# Aether Remote Agent Server

Runs the Aether agent **on a server** instead of inside the phone's Alpine VM.

The app keeps its UI, its chat history and its host-side tools; the agent loop,
the file system, `bash`, and every other Pi tool move to the machine that runs
this server. All agent work is streamed back in real time and mirrored into a
per-workspace journal, so several devices (phone, tablet, browser dashboard,
DeepSeek Harness) can watch or steer the same session.

```
┌─────────────┐   WebSocket (newline-delimited JSON, Pi bridge protocol)
│  Aether app │◀───────────────────────────────────────────────┐
│  (Android / │                                                │
│   iOS)      │   srv_fs / srv_exec / srv_process_* (RPC)      │
└─────────────┘                                                │
                                                               ▼
                        ┌──────────────────────────────────────────────┐
                        │ aether-server                                │
                        │  └─ workspace hub ── pi-bridge (bridge.mjs)   │
                        │        ├─ journal (.jsonl, webhook, SSE)      │
                        │        └─ runtime (fs, exec, processes)       │
                        └──────────────────────────────────────────────┘
```

## Requirements

- Node.js ≥ 22 (tested with 24)
- A built bridge bundle: `cd pi-bridge && npm ci && npm run build`
- A Linux/macOS host reachable from the phone (LAN or VPN recommended)

## Quick start

```bash
# 1. build the Pi bridge bundle once
cd pi-bridge && npm ci && npm run build && cd ..

# 2. start the server
cd server
npm ci
node bin/aether-server.mjs \
  --host 0.0.0.0 \
  --port 8787 \
  --data-dir ./data \
  --token "$(openssl rand -hex 24)"
```

The printed token is the only credential: paste it into
**Aether → Settings → 远程 Agent → 访问令牌**.

`--no-auth` disables authentication and is meant for `127.0.0.1` development only.

## What lives where

```
<data-dir>/users/<user>/<workspace>/
├── home/            HOME for the bridge (~/.pi, ~/.aether, credentials)
├── workspace/       the agent working directory (read/write/edit/bash)
└── .aether/
    ├── journal/     daily .jsonl of every agent frame (replay + webhook)
    └── logs/
```

The server reports these paths in the `hello` frame (`paths.home`,
`paths.workspace`, `paths.agent`, `paths.bridge`, `paths.extensions`), and the
app uses them verbatim — there is no path translation layer.

## Protocol

The WebSocket carries the Pi bridge protocol unchanged, plus a small server
namespace:

| Direction | Frame | Purpose |
| --- | --- | --- |
| client → server | `{type:"hello", protocol, token, workspace, client}` | attach to a workspace |
| server → client | `{type:"hello", ok, paths, capabilities, bridge}` | paths + feature flags |
| both | `{id, type, payload}` → `{type:"response", id, ok, payload}` | bridge requests (`run_turn`, `steer`, `abort`, …) |
| server → client | `{type:"event", event, payload}` | streamed deltas, tool calls, `server_status` |
| client → server | `srv_ping`, `srv_info`, `srv_status`, `srv_bridge_restart` | server control |
| client → server | `srv_fs` (`stat/list/tree/read/write/append/mkdir/remove/move/copy/exists/chmod/glob/info`) | workspace file system |
| client → server | `srv_exec` | one-shot command with streamed output |
| client → server | `srv_process_start/stdin/close_stdin/signal/list` | long-lived processes (extension bridge, MCP, terminal) |
| client → server | `srv_journal` | journal replay for reconnect |

Every bridge `event` is broadcast to **all** clients of the workspace, so a
phone and a browser dashboard see the same live work. Responses go back to the
client that asked.

## HTTP surface

| Route | Purpose |
| --- | --- |
| `GET /healthz` | liveness probe |
| `GET /v1/info` | server + workspace summary |
| `GET /v1/workspaces` | workspaces for the authenticated user |
| `GET /v1/workspaces/:name/journal` | journal records |
| `GET /v1/workspaces/:name/events` | Server-Sent Events stream |
| `GET /dashboard` | dependency-free live dashboard |
| `POST /v1/workspaces/:name/fs` | file-system RPC (JSON) |
| `POST /v1/workspaces/:name/exec` | command execution (JSON) |

All HTTP routes accept `Authorization: Bearer <token>`, `x-aether-token`, or
`?token=` (use the header where possible).

## DeepSeek Harness

`src/dsh-plugin.mjs` is a cordis plugin, so the same server can run inside a
DeepSeek Harness process:

```yaml
# cordis.patch.yml
plugins:
  aether-remote-server:
    host: 0.0.0.0
    port: 8787
    dataDir: /var/lib/aether
    tokens:
      - token: "<token>"
        user: default
```

```bash
dsh plugin --profile web add /path/to/aether/server
```

## Tests

```bash
npm test          # node --test tests/*.test.mjs
```

The suite covers authentication, the hello handshake, path jailing, exec
streaming, process streaming, journal replay, the HTTP API, bridge restarts, and
one **end-to-end agent turn** driven by the Pi bridge's deterministic `faux`
provider — including a `bash` tool call that writes a file inside the server
workspace, plus prefix reads for large files.

## Security notes

- Bind to `127.0.0.1` and put a reverse proxy (TLS + auth) in front when the
  server is reachable from the internet; use a VPN or Tailscale for LAN use.
- Tokens are compared in constant time and stored hashed in memory.
- Every path from a client is resolved against the workspace roots, with
  symlink-escape checks; `..` cannot leave `home/` or `workspace/`.
- Child processes run as the server user — do not run as `root` on a shared box.
