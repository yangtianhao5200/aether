import { randomUUID } from "node:crypto";
import { BridgeHost, STARTUP_PING_ID } from "./bridge-host.mjs";
import { Journal } from "./journal.mjs";
import { ProcessHost } from "./process-host.mjs";
import { RuntimeRpc } from "./runtime-rpc.mjs";
import { PROTOCOL_VERSION, SERVER_VERSION } from "./config.mjs";

const SERVER_OPERATION_PREFIX = "srv_";

/**
 * One workspace = one bridge process + one journal + N attached clients.
 *
 * All clients of a workspace share the same bridge, so an iPhone, an Android
 * phone and a browser dashboard can watch (and steer) the same agent session.
 * Requests are answered to their originator; events are broadcast to everyone.
 */
export class WorkspaceHub {
  constructor({ workspace, workspaceStore, config, log }) {
    this.workspace = workspace;
    this.config = config;
    this.log = log;
    this.clients = new Map();
    this.requestOwners = new Map();
    this.closed = false;
    this.journal = new Journal({
      directory: workspace.journalDirectory,
      log,
      webhookUrl: config.webhookUrl,
    });
    this.runtimeRpc = new RuntimeRpc({ workspaceStore, log });
    this.processes = new ProcessHost({ workspace, log });
    this.bridge = new BridgeHost({
      workspace,
      bridgePath: config.bridgePath,
      nodePath: config.nodePath,
      extraEnv: config.runtime === "dsh"
        ? {
            AETHER_DSH_HOME: config.dshHome ?? "",
            AETHER_DSH_COMMAND: config.dshCommand ?? "dsh",
            AETHER_DSH_ARGS: config.dshArgs ?? "--profile acp",
          }
        : {},
      log,
    });
    this.bridge.on("frame", (frame) => this.#onBridgeFrame(frame));
    this.bridge.on("stderr", (line) => this.log("debug", "bridge.stderr", { line }));
    this.bridge.on("status", (status) => {
      this.broadcastEvent("server_status", { ...status, bridge: "running" });
    });
    this.bridge.on("exit", () => {
      this.failPendingRequests("Pi bridge process exited.");
    });
  }

  async initialize() {
    await this.journal.initialize();
  }

  get clientCount() {
    return this.clients.size;
  }

  // ---------------------------------------------------------------- clients

  attach(client) {
    const clientId = client.id || randomUUID();
    client.id = clientId;
    this.clients.set(clientId, client);
    this.log("info", "client.attached", {
      workspace: this.workspace.id,
      client: clientId,
      user: client.user,
      total: this.clients.size,
    });
    this.#cancelIdleShutdown();
    // A client that just (re)connected needs the bridge warm: starting it now
    // hides ~1-2 s of Pi bootstrap behind the app's own splash.
    this.bridge.ensureStarted().catch((error) => {
      if (this.closed) return;
      this.log("error", "bridge.start_failed", { error: String(error) });
      this.sendTo(client, {
        type: "event",
        event: "server_status",
        payload: {
          bridge: "failed",
          workspace: this.workspace.id,
          error: String(error.message ?? error),
        },
      });
    });
    return clientId;
  }

  detach(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    this.log("info", "client.detached", {
      workspace: this.workspace.id,
      client: clientId,
      total: this.clients.size,
    });
    if (this.clients.size === 0) this.#scheduleIdleShutdown();
  }

  sendTo(client, frame) {
    client.send(frame);
  }

  broadcastEvent(event, payload, { id } = {}) {
    const frame = { type: "event", event, payload };
    if (id) frame.id = id;
    for (const client of this.clients.values()) client.send(frame);
  }

  // --------------------------------------------------------------- inbound

  async handleClientFrame(client, frame) {
    if (!frame || typeof frame !== "object") return;
    const type = typeof frame.type === "string" ? frame.type : "";
    if (type.startsWith(SERVER_OPERATION_PREFIX)) {
      await this.#handleServerOperation(client, type, frame);
      return;
    }
    if (type === "ping" && frame.id) {
      // Answer server-side so a client can measure reachability even while the
      // bridge is still booting.
      const bridgeStatus = this.bridge.status();
      client.send({
        type: "response",
        id: frame.id,
        ok: true,
        payload: {
          bridge_version: bridgeStatus.bridge_version ?? "unknown",
          server_version: SERVER_VERSION,
          protocol: PROTOCOL_VERSION,
          node_version: process.version,
          bridge_running: bridgeStatus.running,
          workspace: this.workspace.id,
          home_directory: this.workspace.home,
          workspace_directory: this.workspace.workspace,
        },
      });
      return;
    }

    this.journal.append("in", frame, { clientId: client.id });
    if (typeof frame.id === "string" && frame.id) this.requestOwners.set(frame.id, client.id);
    this.log("debug", "frame.in", { workspace: this.workspace.id, type, id: frame.id });

    try {
      await this.bridge.ensureStarted();
      this.bridge.send(frame);
    } catch (error) {
      this.log("error", "bridge.forward_failed", {
        error: String(error.message ?? error),
        type,
      });
      client.send({
        type: "error",
        id: typeof frame.id === "string" ? frame.id : undefined,
        error: { code: "bridge_unavailable", message: String(error.message ?? error) },
      });
    }
  }

  #onBridgeFrame(frame) {
    if (frame?.id === STARTUP_PING_ID) return;
    this.journal.append("out", frame);
    this.log("debug", "frame.out", { workspace: this.workspace.id, type: frame.type, id: frame.id });
    const id = typeof frame.id === "string" ? frame.id : "";
    if (frame.type === "event") {
      // Events are broadcast: every connected device sees the same live work.
      for (const client of this.clients.values()) client.send(frame);
      return;
    }
    const ownerId = id ? this.requestOwners.get(id) : "";
    if (ownerId) this.requestOwners.delete(id);
    const owner = ownerId ? this.clients.get(ownerId) : null;
    if (owner) owner.send(frame);
    else for (const client of this.clients.values()) client.send(frame);
  }

  failPendingRequests(reason) {
    for (const [id, ownerId] of this.requestOwners) {
      const owner = this.clients.get(ownerId);
      owner?.send({ type: "error", id, error: { code: "bridge_exited", message: reason } });
    }
    this.requestOwners.clear();
  }

  // -------------------------------------------------------- server ops

  async #handleServerOperation(client, type, frame) {
    const id = typeof frame.id === "string" ? frame.id : "";
    const payload = frame.payload && typeof frame.payload === "object" ? frame.payload : {};
    const respond = (ok, body) => {
      client.send(ok
        ? { type: "response", id, ok: true, payload: body }
        : { type: "error", id, error: { code: body.code ?? "server_error", message: body.message } });
    };

    try {
      switch (type) {
        case "srv_ping":
          respond(true, {
            pong: true,
            ts: Date.now(),
            server_version: SERVER_VERSION,
            protocol: PROTOCOL_VERSION,
          });
          return;
        case "srv_info":
          respond(true, {
            server_version: SERVER_VERSION,
            protocol: PROTOCOL_VERSION,
            node_version: process.version,
            workspace: {
              id: this.workspace.id,
              home_directory: this.workspace.home,
              workspace_directory: this.workspace.workspace,
              agent_directory: this.workspace.agentDirectory,
            },
            bridge: this.bridge.status(),
            clients: this.clients.size,
          });
          return;
        case "srv_status":
          respond(true, this.bridge.status());
          return;
        case "srv_bridge_restart":
          await this.bridge.stop({ force: true });
          await this.bridge.ensureStarted();
          respond(true, this.bridge.status());
          return;
        case "srv_journal": {
          const records = payload.replay
            ? this.journal.since(Number(payload.since ?? 0), Number(payload.limit ?? 200))
            : await this.journal.read({
              sessionId: typeof payload.session_id === "string" ? payload.session_id : "",
              limit: Number(payload.limit ?? 200),
              since: Number(payload.since ?? 0),
            });
          respond(true, { records });
          return;
        }
        case "srv_fs": {
          const result = await this.runtimeRpc.handle(this.workspace, payload);
          respond(true, result);
          return;
        }
        case "srv_process_start": {
          const started = this.processes.start(payload, {
            ownerId: client.id,
            onOutput: (chunk) => {
              this.sendTo(client, {
                type: "event",
                event: "srv_process_output",
                payload: chunk,
              });
            },
            onExit: (chunk) => {
              this.sendTo(client, {
                type: "event",
                event: "srv_process_exit",
                payload: chunk,
              });
            },
          });
          respond(true, started);
          return;
        }
        case "srv_process_stdin":
          respond(true, this.processes.writeStdin(payload.process_id, payload.data_base64 ?? ""));
          return;
        case "srv_process_close_stdin":
          respond(true, this.processes.closeStdin(payload.process_id));
          return;
        case "srv_process_signal":
          respond(true, this.processes.signal(payload.process_id, payload.signal));
          return;
        case "srv_process_list":
          respond(true, { processes: this.processes.list() });
          return;
        case "srv_exec": {
          const abort = new AbortController();
          const onClose = () => abort.abort();
          client.socket?.once?.("close", onClose);
          const result = await this.runtimeRpc.execute(this.workspace, payload, {
            signal: abort.signal,
            onOutput: (chunk) => {
              client.send({
                type: "event",
                id,
                event: "srv_exec_output",
                payload: chunk,
              });
            },
          });
          client.socket?.off?.("close", onClose);
          respond(true, result);
          return;
        }
        default:
          respond(false, { code: "unsupported_operation", message: `Unknown server operation: ${type}` });
      }
    } catch (error) {
      this.log("warn", "server_op_failed", { type, error: String(error.message ?? error) });
      respond(false, { code: error.code ?? "server_error", message: String(error.message ?? error) });
    }
  }

  // --------------------------------------------------------------- lifecycle

  #scheduleIdleShutdown() {
    this.#cancelIdleShutdown();
    const minutes = this.config.idleTimeoutMinutes;
    if (!minutes || minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.clients.size > 0) return;
      this.log("info", "workspace.idle_shutdown", { workspace: this.workspace.id });
      void this.close();
    }, minutes * 60_000);
    this.idleTimer.unref?.();
  }

  #cancelIdleShutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.#cancelIdleShutdown();
    for (const client of this.clients.values()) {
      client.send({
        type: "event",
        event: "server_status",
        payload: { bridge: "stopped", workspace: this.workspace.id, reason: "shutdown" },
      });
    }
    this.processes.killAll();
    await this.bridge.stop();
    await this.journal.flush();
  }
}

/** Lazily creates and reaps workspace hubs, enforcing the concurrency cap. */
export class HubRegistry {
  constructor({ config, workspaceStore, log }) {
    this.config = config;
    this.workspaceStore = workspaceStore;
    this.log = log;
    this.hubs = new Map();
  }

  async get(userId, workspaceName = "default") {
    const workspace = await this.workspaceStore.ensure(userId, workspaceName);
    const existing = this.hubs.get(workspace.id);
    if (existing && !existing.closed) return existing;

    const active = [...this.hubs.values()].filter((hub) => !hub.closed);
    if (active.length >= this.config.maxWorkspaces) {
      const idle = active
        .filter((hub) => hub.clientCount === 0)
        .sort((left, right) => left.bridge.lastActivityAt - right.bridge.lastActivityAt)[0];
      if (!idle) {
        const error = new Error(
          `Too many active workspaces (${active.length}/${this.config.maxWorkspaces}).`,
        );
        error.code = "too_many_workspaces";
        throw error;
      }
      await idle.close();
      this.hubs.delete(idle.workspace.id);
    }

    const hub = new WorkspaceHub({ workspace, workspaceStore: this.workspaceStore, config: this.config, log: this.log });
    await hub.initialize();
    this.hubs.set(workspace.id, hub);
    return hub;
  }

  async closeAll() {
    await Promise.all([...this.hubs.values()].map((hub) => hub.close().catch(() => {})));
    this.hubs.clear();
  }
}
