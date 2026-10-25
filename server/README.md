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

### Mount on the harness webserver (single public URL)

`AETHER_RUNTIME=dsh` can run standalone (its own port) **or** be mounted on the
DeepSeek Harness web server, so the phone uses the same public URL as the web GUI
and no second port has to be exposed:

```yaml
# cordis.patch.yml of the web profile
plugins:
  aether-remote-server:
    mountPath: /aether          # agent lives at <web-url>/aether
    dataDir: /var/lib/aether
    tokens:
      - token: "<token>"
        user: default
```

```bash
dsh plugin --profile web add /path/to/aether/server
```

The phone then connects to:

| | URL |
|---|---|
| HTTP (test / pairing) | `https://<web-host>/aether` |
| WebSocket (app) | `wss://<web-host>/aether/v1/agent` |

`AETHER_DSH_ARGS` must contain the launcher command line, because the ACP agent
is started with the harness CLI, not with a plain node flag:

```bash
AETHER_DSH_ARGS="/usr/local/bin/node /path/to/dsh/lib/bin.js --profile acp --patch /path/to/patch.yml"
```

Use `--patch` to point the ACP profile at a provider route that actually holds
credentials on that host, and `AETHER_DSH_HOME` to select the harness home.

### Run the agent on DeepSeek Harness instead of Pi

`src/dsh-bridge/` implements the same bridge protocol on top of
`dsh --profile acp` (Agent Client Protocol over JSON-RPC stdio). Start the
server with `AETHER_RUNTIME=dsh` and the app keeps working unchanged:

```bash
AETHER_RUNTIME=dsh \
DEEPSEEK_API_KEY=sk-... \
aether-server --host 0.0.0.0 --port 8787
```

| Variable | Default | Meaning |
|---|---|---|
| `AETHER_RUNTIME` | `pi` | `pi` (Pi coding agent) or `dsh` (DeepSeek Harness) |
| `AETHER_DSH_HOME` | `$DSH_HOME` | Harness home holding profiles and credentials |
| `AETHER_DSH_ARGS` | `--profile acp` | Arguments passed to the harness launcher |
| `AETHER_DSH_BRIDGE` | `<package>/bin/dsh-bridge.mjs` | Bridge script override |

What the mapping carries:

| ACP update | Bridge event |
|---|---|
| `agent_message_chunk` | `assistant_text_delta` |
| `agent_thought_chunk` | `assistant_reasoning_delta` |
| `tool_call` / `tool_call_update` | `tool_call_start` / `tool_call_delta` / `tool_call_end` |
| `usage_update` | `context_usage` |
| `PromptResponse.usage` | turn usage in `assistant_done` |

`list_providers` is built from the ACP `model` config option, so the app's model
picker shows the harness models and `reasoning_effort` maps to the harness
thinking levels. Permission prompts are auto-approved with the harness's own
`allow_*` option; add an approval policy there if the deployment needs one.

## Tests

```bash
npm test          # node --test tests/*.test.mjs
```

The suite covers authentication, the hello handshake, path jailing, exec
streaming, process streaming, journal replay, the HTTP API, bridge restarts,
the DeepSeek Harness bridge (catalog, streaming turn, unsupported methods) and
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
