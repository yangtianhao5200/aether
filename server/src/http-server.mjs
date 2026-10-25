import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { extractToken } from "./auth.mjs";
import { PROTOCOL_VERSION, SERVER_VERSION } from "./config.mjs";

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/**
 * `aether://host:port?token=...&workspace=default` — a single string that fills
 * every onboarding field at once (the app parses it, or the raw host:port).
 */
function buildConnectionString(baseUrl, token, workspace) {
  const wsBase = baseUrl
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://")
    .replace(/\/$/, "");
  const query = new URLSearchParams({ token, workspace });
  return `aether://${wsBase.replace(/^(wss?):\/\//, "")}/v1/agent?${query.toString()}`;
}
const MAX_BODY_BYTES = 96 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 15_000;
const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * HTTP + WebSocket front end.
 *
 * REST endpoints serve dashboards, health checks and scripted clients; the
 * WebSocket endpoint carries the Pi bridge protocol verbatim so the app can use
 * exactly the same frames it uses against the on-device bridge.
 */
export function createAetherHttpServer({ config, registry, tokens, log }) {
  const sseClients = new Map();

  const httpServer = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      if (request.method === "OPTIONS") {
        return sendJson(response, 204, null);
      }
      if (url.pathname === "/healthz") {
        return sendJson(response, 200, {
          ok: true,
          version: SERVER_VERSION,
          protocol: PROTOCOL_VERSION,
          uptime_seconds: Math.round(process.uptime()),
        });
      }
      if (url.pathname === "/" || url.pathname === "/dashboard") {
        const html = await readFile(path.join(publicDirectory, "index.html"), "utf8").catch(() => "");
        if (!html) return sendJson(response, 404, { error: "dashboard_unavailable" });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(html);
      }
      if (url.pathname === "/v1/pair") {
        requireIdentity(request, url);
        // Only the raw bearer token can build a connectable string; the identity
        // service keeps digests.
        const token = extractToken({ headers: request.headers, url: url.pathname + url.search });
        const base = config.publicUrl?.trim() || `http://${request.headers.host ?? "localhost"}`;
        const workspace = url.searchParams.get("workspace")?.trim() || "default";
        const connection = buildConnectionString(base, token, workspace);
        return sendJson(response, 200, {
          server_url: base,
          token,
          workspace,
          // One string the app can paste: aether://host:port?token=...&workspace=default
          connection_string: connection,
          qr_payload: connection,
        });
      }
      if (url.pathname === "/v1/info") {
        const identity = requireIdentity(request, url);
        return sendJson(response, 200, {
          server_version: SERVER_VERSION,
          protocol: PROTOCOL_VERSION,
          node_version: process.version,
          user: identity.user,
          workspaces: await registry.workspaceStore.list(identity.user),
          bridges: [...registry.hubs.values()].map((hub) => hub.bridge.status()),
        });
      }
      if (url.pathname === "/v1/workspaces") {
        const identity = requireIdentity(request, url);
        if (request.method === "GET") {
          return sendJson(response, 200, {
            workspaces: await registry.workspaceStore.list(identity.user),
          });
        }
        if (request.method === "POST") {
          const body = await readJsonBody(request);
          const workspace = await registry.workspaceStore.ensure(identity.user, body.name ?? "default");
          return sendJson(response, 200, { workspace: publicWorkspace(workspace) });
        }
      }

      const workspaceMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)(?:\/([^/]+))?\/?$/);
      if (workspaceMatch) {
        const identity = requireIdentity(request, url);
        const workspaceName = decodeURIComponent(workspaceMatch[1]);
        const action = workspaceMatch[2] ?? "";
        const workspace = await registry.workspaceStore.ensure(identity.user, workspaceName);
        const hub = await registry.get(identity.user, workspaceName);

        if (action === "fs" && request.method === "POST") {
          const body = await readJsonBody(request);
          const result = await hub.runtimeRpc.handle(workspace, body);
          return sendJson(response, 200, result);
        }
        if (action === "exec" && request.method === "POST") {
          const body = await readJsonBody(request);
          const result = await hub.runtimeRpc.execute(workspace, body);
          return sendJson(response, 200, result);
        }
        if (action === "journal" && request.method === "GET") {
          const records = await hub.journal.read({
            sessionId: url.searchParams.get("session") ?? "",
            limit: Number(url.searchParams.get("limit") ?? 200),
            since: Number(url.searchParams.get("since") ?? 0),
          });
          return sendJson(response, 200, { records });
        }
        if (action === "events" && request.method === "GET") {
          return streamEvents(response, hub, sseClients, workspace.id);
        }
        if (!action && request.method === "GET") {
          return sendJson(response, 200, {
            workspace: publicWorkspace(workspace),
            bridge: hub.bridge.status(),
            clients: hub.clientCount,
          });
        }
      }

      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error.statusCode ?? (error.code === "unauthorized" ? 401 : 500);
      if (status >= 500) log("error", "http.failed", { path: url.pathname, error: String(error) });
      return sendJson(response, status, {
        error: error.code ?? "server_error",
        message: String(error.message ?? error),
      });
    }
  });

  function requireIdentity(request, url) {
    const identity = tokens.identify(extractToken({ headers: request.headers, url: url.pathname + url.search }));
    if (!identity) {
      const error = new Error("Missing or invalid Aether token.");
      error.statusCode = 401;
      error.code = "unauthorized";
      throw error;
    }
    return identity;
  }

  // ------------------------------------------------------------------- WS

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

  httpServer.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/v1/agent" && url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    // Query tokens are accepted for browsers; native clients send a header.
    const headerIdentity = tokens.identify(extractToken({ headers: request.headers }));
    wsServer.handleUpgrade(request, socket, head, (webSocket) => {
      wsServer.emit("connection", webSocket, request, { url, headerIdentity });
    });
  });

  wsServer.on("connection", (socket, request, context) => {
    const url = context?.url ?? new URL(request.url ?? "/", "http://localhost");
    const initialIdentity = context?.headerIdentity ?? tokens.identify(extractToken({ headers: request.headers }));
    const state = {
      authenticated: Boolean(initialIdentity),
      identity: initialIdentity,
      hub: null,
      clientId: "",
      alive: true,
    };

    const helloTimeout = setTimeout(() => {
      if (!state.authenticated) socket.close(4401, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    socket.on("pong", () => {
      state.alive = true;
    });

    socket.on("message", async (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString("utf8"));
      } catch {
        socket.send(JSON.stringify({
          type: "error",
          error: { code: "invalid_json", message: "Frames must be JSON objects." },
        }));
        return;
      }

      if (frame?.type === "hello") {
        try {
          const identity = initialIdentity
            ?? tokens.identify(frame.token ?? extractToken({ url: url.pathname + url.search }));
          if (!identity) {
            socket.send(JSON.stringify({
              type: "hello",
              protocol: PROTOCOL_VERSION,
              ok: false,
              error: { code: "unauthorized", message: "Missing or invalid Aether token." },
            }));
            socket.close(4401, "unauthorized");
            return;
          }
          clearTimeout(helloTimeout);
          const workspaceName = String(frame.workspace ?? "default");
          const hub = await registry.get(identity.user, workspaceName);
          const client = {
            id: state.clientId || `c_${Math.random().toString(36).slice(2, 10)}`,
            user: identity.user,
            socket,
            info: frame.client ?? {},
            send: (outbound) => {
              if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(outbound));
            },
          };
          state.clientId = hub.attach(client);
          state.hub = hub;
          state.authenticated = true;
          state.identity = identity;
          socket.send(JSON.stringify({
            type: "hello",
            protocol: PROTOCOL_VERSION,
            ok: true,
            server_version: SERVER_VERSION,
            workspace: hub.workspace.id,
            user: identity.user,
            paths: {
              home: hub.workspace.home,
              workspace: hub.workspace.workspace,
              agent: hub.workspace.agentDirectory,
              bridge: hub.workspace.bridgeDirectory,
              extensions: hub.workspace.extensionDirectory,
            },
            bridge: hub.bridge.status(),
            capabilities: {
              server_ops: ["srv_ping", "srv_info", "srv_status", "srv_fs", "srv_exec", "srv_journal", "srv_bridge_restart"],
              broadcast_events: true,
              journal_replay: true,
            },
          }));

          // Optional catch-up for a client that was offline while the agent worked.
          const resumeSince = Number(frame.resume?.since ?? 0);
          if (resumeSince > 0) {
            for (const record of hub.journal.since(resumeSince, 200)) {
              client.send({ type: "event", event: "journal_replay", payload: record });
            }
          }
          log("info", "ws.hello", { workspace: hub.workspace.id, client: state.clientId });
        } catch (error) {
          socket.send(JSON.stringify({
            type: "hello",
            protocol: PROTOCOL_VERSION,
            ok: false,
            error: { code: error.code ?? "hello_failed", message: String(error.message ?? error) },
          }));
          socket.close(1011, "hello failed");
        }
        return;
      }

      if (!state.authenticated || !state.hub) {
        socket.send(JSON.stringify({
          type: "error",
          error: { code: "handshake_required", message: "Send a hello frame first." },
        }));
        return;
      }
      await state.hub.handleClientFrame(
        state.hub.clients.get(state.clientId) ?? {
          id: state.clientId,
          socket,
          send: (outbound) => socket.send(JSON.stringify(outbound)),
        },
        frame,
      );
    });

    socket.on("close", () => {
      clearTimeout(helloTimeout);
      state.hub?.detach(state.clientId);
    });
    socket.on("error", () => {
      state.hub?.detach(state.clientId);
    });
  });

  const keepalive = setInterval(() => {
    for (const client of wsServer.clients) {
      const state = client.__aetherState;
      if (state === false) {
        client.terminate();
        continue;
      }
      client.__aetherState = false;
      try {
        client.ping();
      } catch {
        // socket already closing
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();

  wsServer.on("connection", (socket) => {
    socket.__aetherState = true;
    socket.on("pong", () => {
      socket.__aetherState = true;
    });
  });

  return {
    httpServer,
    wsServer,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve(httpServer.address());
        });
      });
    },
    async close() {
      clearInterval(keepalive);
      for (const response of sseClients.values()) response.end();
      sseClients.clear();
      for (const client of wsServer.clients) client.terminate();
      wsServer.close();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

function streamEvents(response, hub, sseClients, workspaceId) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  const key = `${workspaceId}:${Math.random().toString(36).slice(2)}`;
  sseClients.set(key, response);
  response.write(`event: ready\ndata: ${JSON.stringify({ workspace: workspaceId })}\n\n`);

  // Reuse the hub broadcast path by attaching a pseudo client.
  const pseudo = {
    id: key,
    user: "sse",
    socket: null,
    send: (frame) => {
      if (frame?.type !== "event") return;
      response.write(`event: agent\ndata: ${JSON.stringify(frame)}\n\n`);
    },
  };
  hub.clients.set(key, pseudo);
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 20_000);
  heartbeat.unref?.();

  response.on("close", () => {
    clearInterval(heartbeat);
    hub.clients.delete(key);
    sseClients.delete(key);
  });
}

function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    user: workspace.user,
    name: workspace.name,
    home_directory: workspace.home,
    workspace_directory: workspace.workspace,
    agent_directory: workspace.agentDirectory,
  };
}

function sendJson(response, status, body) {
  const payload = body === null ? "" : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, x-aether-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  response.end(payload);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be JSON.");
    error.statusCode = 400;
    throw error;
  }
}
