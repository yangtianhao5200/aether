import { startAetherServer } from "./index.mjs";
import { defaultBridgePath, repositoryRoot } from "./config.mjs";

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

/** No services are required; the plugin only owns a listening socket. */
export const inject = [];

export function apply(ctx, config = {}) {
  const resolved = {
    host: config.host ?? process.env.AETHER_HOST ?? "127.0.0.1",
    port: Number(config.port ?? process.env.AETHER_PORT ?? 8787),
    dataDir: config.dataDir ?? process.env.AETHER_DATA_DIR ?? `${repositoryRoot}/server/data`,
    bridgePath: config.bridgePath ?? process.env.AETHER_BRIDGE ?? defaultBridgePath,
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
  };

  ctx.effect(async () => {
    const server = await startAetherServer(resolved);
    ctx.logger?.("aether-remote-server")?.info?.(
      `Aether remote agent server listening on ${server.url}`,
    );
    // Expose the handle so other plugins (or dsh commands) can inspect it.
    const disposeProvide = ctx.provide?.("aetherRemoteServer", server);
    return async () => {
      try {
        disposeProvide?.();
      } catch {
        // provider already gone
      }
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
