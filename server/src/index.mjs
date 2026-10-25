import { createAetherHttpServer } from "./http-server.mjs";
import { HubRegistry } from "./workspace-hub.mjs";
import { WorkspaceStore } from "./workspace-store.mjs";
import { createTokenRegistry } from "./auth.mjs";
import { PROTOCOL_VERSION, SERVER_VERSION, loadConfig } from "./config.mjs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (levelName, event, details) => {
    if ((LEVELS[levelName] ?? LEVELS.info) < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: levelName,
      event,
      ...(details ?? {}),
    };
    const line = JSON.stringify(record);
    if (levelName === "error" || levelName === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return (levelName, event, details) => write(levelName, event, details);
}

/**
 * Boot a complete remote agent host.
 *
 * @param {object} [options] Partial config (same shape as `loadConfig` output).
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, registry: HubRegistry, config: object}>}
 */
export async function startAetherServer(options = {}) {
  const config = options.dataDir && options.tokens
    ? { ...options }
    : { ...loadConfig([], process.env), ...options };
  const log = config.log ?? createLogger(config.logLevel);

  const workspaceStore = new WorkspaceStore({
    dataDir: config.dataDir,
    bridgePath: config.bridgePath,
    log,
  });
  await workspaceStore.initialize();

  const tokens = createTokenRegistry(config);
  const registry = new HubRegistry({ config, workspaceStore, log });
  const http = createAetherHttpServer({ config, registry, tokens, log });

  // `host` mode (an external process owns the listening socket, e.g. the
  // DeepSeek Harness webserver plugin) keeps the handler and returns no address.
  const mountedByHost = config.mountedByHost === true;
  const address = mountedByHost ? null : await http.listen(config.port, config.host);
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  const url = config.publicUrl || (mountedByHost ? "" : `http://${host}:${port}`);

  log("info", "server.started", {
    version: SERVER_VERSION,
    protocol: PROTOCOL_VERSION,
    ...(mountedByHost ? { mode: "host-mounted" } : { url }),
    data_dir: config.dataDir,
    bridge: config.bridgePath,
    auth: config.noAuth ? "disabled" : `${tokens.size} token(s)`,
  });

  return {
    url,
    port: mountedByHost ? 0 : port,
    host: mountedByHost ? "" : config.host,
    /** Mount on an external webserver: { handle: (req,res)=>void, upgrade: (req,socket,head)=>void } */
    http,
    config,
    registry,
    workspaceStore,
    log,
    async close() {
      await registry.closeAll();
      if (!mountedByHost) await http.close();
      else {
        for (const client of http.wsServer.clients) client.terminate();
        http.wsServer.close();
      }
      log("info", "server.stopped", {});
    },
  };
}

export { loadConfig, usage, SERVER_VERSION, PROTOCOL_VERSION } from "./config.mjs";
export { WorkspaceStore } from "./workspace-store.mjs";
export { Journal, summarize } from "./journal.mjs";
export { RuntimeRpc } from "./runtime-rpc.mjs";
export { BridgeHost } from "./bridge-host.mjs";
export { WorkspaceHub, HubRegistry } from "./workspace-hub.mjs";
export { createTokenRegistry } from "./auth.mjs";
