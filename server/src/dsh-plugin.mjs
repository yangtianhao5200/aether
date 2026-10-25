import { startAetherServer } from "./index.mjs";
import {
  defaultBridgePath,
  defaultDshBridgePath,
  repositoryRoot,
} from "./config.mjs";

/**
 * DeepSeek Harness (dsh) plugin.
 *
 * Lets a dsh instance host the Aether remote agent server: dsh owns the
 * lifecycle, the server binds a port, and the Aether apps connect to it exactly
 * as they would to a standalone `aether-server` process.
 *
 * Usage (inside a dsh profile directory):
 *
 *   dsh plugin --profile web add /path/to/aether/server
 *
 * then add to the profile's `cordis.patch.yml`:
 *
 *   - id: aether-remote-server
 *     name: '@aether/remote-server/dsh'
 *     config:
 *       host: 0.0.0.0
 *       port: 8787
 *       dataDir: /srv/aether
 *       tokens:
 *         - token: replace-me
 *           user: default
 */
export const name = "aether-remote-server";

/**
 * `webServer` is optional: with it the routes are mounted on the host's HTTP
 * server (the same public URL the DeepSeek Harness web GUI uses); without it the
 * plugin binds its own port.
 */
export const inject = ["webServer"];

export function apply(ctx, config = {}) {
  const mountPath = String(config.mountPath ?? "/aether").replace(/\/$/, "") || "/aether";
  const runtime = String(config.runtime ?? process.env.AETHER_RUNTIME ?? "pi").trim() || "pi";
  const dshBridgePath = config.bridgePath?.trim()
    || process.env.AETHER_DSH_BRIDGE?.trim()
    || defaultDshBridgePath;
  const resolved = {
    host: config.host ?? process.env.AETHER_HOST ?? "127.0.0.1",
    port: Number(config.port ?? process.env.AETHER_PORT ?? 8787),
    dataDir: config.dataDir ?? process.env.AETHER_DATA_DIR ?? `${repositoryRoot}/server/data`,
    bridgePath: config.bridgePath?.trim()
      || process.env.AETHER_BRIDGE?.trim()
      || (runtime === "dsh" ? dshBridgePath : defaultBridgePath),
    runtime,
    dshHome: config.dshHome ?? process.env.AETHER_DSH_HOME ?? process.env.DSH_HOME ?? "",
    dshCommand: config.dshCommand ?? process.env.AETHER_DSH_COMMAND ?? process.env.AETHER_DSH_NODE ?? "dsh",
    dshArgs: config.dshArgs?.trim() || process.env.AETHER_DSH_ARGS?.trim() || "--profile acp",
    nodePath: config.nodePath ?? process.env.AETHER_NODE ?? process.execPath,
    tokens: normalizeTokens(config),
    noAuth: config.noAuth === true || process.env.AETHER_NO_AUTH === "1",
    idleTimeoutMinutes: Number(
      config.idleTimeoutMinutes ?? process.env.AETHER_IDLE_TIMEOUT_MINUTES ?? 30,
    ),
    maxWorkspaces: Number(config.maxWorkspaces ?? process.env.AETHER_MAX_WORKSPACES ?? 8),
    publicUrl: config.publicUrl ?? process.env.AETHER_PUBLIC_URL ?? "",
    webhookUrl: config.webhookUrl ?? process.env.AETHER_WEBHOOK_URL ?? "",
    logLevel: config.logLevel ?? process.env.AETHER_LOG_LEVEL ?? "info",
    // With a host webserver there is no port of our own to bind.
    mountedByHost: Boolean(ctx.webServer),
  };

  ctx.effect(async () => {
    const server = await startAetherServer(resolved);
    const logger = ctx.logger?.("aether-remote-server");
    let dispose = async () => {};

    if (ctx.webServer && server.http) {
      // Mount on the harness webserver: the agent is reachable through the same
      // public URL as the web GUI, e.g. ws://host:3193/aether/v1/agent.
      //
      // A duplicate path name makes cordis *throw*, which would abort the whole
      // harness boot; registration therefore never propagates an error. If the
      // preferred path is taken we retry once with a suffixed path, and if that
      // still fails the host keeps running and only logs.
      const register = (base) => {
        const disposeHttp = ctx.webServer.register({
          kind: "prefix",
          path: base,
          handler: server.http.handleUnder(base),
        });
        const disposeUpgrade = ctx.webServer.registerUpgrade({
          path: `${base}/v1/agent`,
          handler: (request, socket, head) => server.http.upgrade(request, socket, head),
        });
        logger?.info?.(`Aether remote agent mounted on ${base} of the harness webserver`);
        dispose = async () => {
          disposeHttp();
          disposeUpgrade();
        };
      };
      try {
        register(mountPath);
      } catch (error) {
        logger?.warn?.(
          `Cannot mount the agent on ${mountPath} (${error?.message ?? error}); trying ${mountPath}-remote.`,
        );
        try {
          register(`${mountPath}-remote`);
        } catch (fallbackError) {
          logger?.error?.(
            `Agent HTTP routes unavailable: ${fallbackError?.message ?? fallbackError}. ` +
              "Change mountPath in the profile patch.",
          );
        }
      }
    } else {
      logger?.info?.(`Aether remote agent server listening on ${server.url}`);
    }

    const disposeProvide = ctx.provide?.("aetherRemoteServer", server);
    return async () => {
      try {
        disposeProvide?.();
      } catch {
        // provider already gone
      }
      await dispose();
      await server.close();
    };
  }, "aether-remote-server");
}

function normalizeTokens(config) {
  const fromConfig = Array.isArray(config.tokens)
    ? config.tokens.map((entry) =>
      typeof entry === "string"
        ? { token: entry, user: "default" }
        : { token: String(entry?.token ?? ""), user: String(entry?.user ?? "default") })
    : [];
  const fromEnvironment = String(process.env.AETHER_TOKENS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.lastIndexOf(":");
      return separator === -1
        ? { token: entry, user: "default" }
        : { token: entry.slice(0, separator), user: entry.slice(separator + 1) };
    });
  const single = process.env.AETHER_TOKEN?.trim();
  return [
    ...fromConfig,
    ...fromEnvironment,
    ...(single ? [{ token: single, user: "default" }] : []),
  ].filter((entry) => entry.token);
}
