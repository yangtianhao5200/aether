import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_VERSION = "1.0.0";
export const PROTOCOL_VERSION = 1;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (`aether/`), used to find the sibling `pi-bridge` build. */
export const repositoryRoot = path.resolve(moduleDirectory, "..", "..");

/**
 * Bridge bundle resolution order:
 *   1. <repo>/pi-bridge/dist/bridge.mjs  (running from a checkout)
 *   2. <package>/bridge/bridge.mjs       (installed tarball / release bundle)
 *   3. $AETHER_BRIDGE / --bridge         (explicit override, handled by the caller)
 */
export const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return candidates[candidates.length - 1];
}

export const defaultBridgePath = firstExisting([
  path.join(repositoryRoot, "pi-bridge", "dist", "bridge.mjs"),
  path.join(packageRoot, "bridge", "bridge.mjs"),
]);

/**
 * Bridge that drives a DeepSeek Harness agent (`dsh --profile acp`) instead of
 * the Pi coding agent. Selected with `AETHER_RUNTIME=dsh` (or `--runtime dsh`).
 */
export const defaultDshBridgePath = path.join(packageRoot, "bin", "dsh-bridge.mjs");

const USAGE = `Aether remote server

Usage: aether-server [options]

Options:
  --host <address>          Bind address (default 127.0.0.1, use 0.0.0.0 for LAN)
  --port <number>           TCP port (default 8787, 0 picks a free port)
  --data-dir <path>         State directory (default ./data)
  --bridge <path>           Path to pi-bridge/dist/bridge.mjs
  --node <path>             Node executable used to run the bridge (default: current)
  --token <token>           Accept this bearer token (repeatable)
  --token-user <user>       User id for the preceding --token (default: default)
  --token-file <path>       JSON token file: {"tokens":[{"token":"..","user":"..","label":".."}]}
  --no-auth                 Disable authentication (development only)
  --idle-timeout <minutes>  Stop an idle bridge after N minutes without clients (0 disables)
  --max-workspaces <n>      Maximum concurrently running bridges (default 8)
  --public-url <url>        Externally reachable base URL reported to clients
  --webhook <url>           POST compact agent activity records to this URL
  --log-level <level>       debug | info | warn | error (default info)
  --help                    Show this help

Environment equivalents: AETHER_HOST, AETHER_PORT, AETHER_DATA_DIR, AETHER_BRIDGE,
AETHER_TOKENS ("token:user,token2:user2"), AETHER_TOKEN, AETHER_NO_AUTH,
AETHER_IDLE_TIMEOUT_MINUTES, AETHER_MAX_WORKSPACES, AETHER_PUBLIC_URL,
AETHER_WEBHOOK_URL, AETHER_LOG_LEVEL.`;

class UsageError extends Error {}

function readOption(argv, index, name) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`Option ${name} requires a value.`);
  }
  return value;
}

/**
 * Parse command line flags and environment variables into a server config.
 * Explicit flags win over environment variables; both win over defaults.
 */
export function loadConfig(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const tokens = [];
  const options = {
    host: env.AETHER_HOST?.trim() || "127.0.0.1",
    port: env.AETHER_PORT ? Number(env.AETHER_PORT) : 8787,
    dataDir: env.AETHER_DATA_DIR?.trim() || path.join(cwd, "data"),
    runtime: env.AETHER_RUNTIME?.trim() || "pi",
    bridgePath:
      env.AETHER_BRIDGE?.trim() ||
      (env.AETHER_RUNTIME?.trim() === "dsh" ? defaultDshBridgePath : defaultBridgePath),
    dshBridgePath: env.AETHER_DSH_BRIDGE?.trim() || defaultDshBridgePath,
    dshHome: env.AETHER_DSH_HOME?.trim() || env.DSH_HOME?.trim() || "",
    dshArgs: env.AETHER_DSH_ARGS?.trim() || "--profile acp",
    nodePath: env.AETHER_NODE?.trim() || process.execPath,
    noAuth: env.AETHER_NO_AUTH === "1" || env.AETHER_NO_AUTH === "true",
    idleTimeoutMinutes: env.AETHER_IDLE_TIMEOUT_MINUTES
      ? Number(env.AETHER_IDLE_TIMEOUT_MINUTES)
      : 30,
    maxWorkspaces: env.AETHER_MAX_WORKSPACES ? Number(env.AETHER_MAX_WORKSPACES) : 8,
    publicUrl: env.AETHER_PUBLIC_URL?.trim() || "",
    webhookUrl: env.AETHER_WEBHOOK_URL?.trim() || "",
    logLevel: env.AETHER_LOG_LEVEL?.trim() || "info",
    help: false,
  };

  for (const [token, user] of parseEnvironmentTokens(env)) {
    tokens.push({ token, user });
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--host":
        options.host = readOption(argv, ++index, argument);
        break;
      case "--port":
        options.port = Number(readOption(argv, ++index, argument));
        break;
      case "--data-dir":
        options.dataDir = path.resolve(cwd, readOption(argv, ++index, argument));
        break;
      case "--bridge":
        options.bridgePath = path.resolve(cwd, readOption(argv, ++index, argument));
        break;
      case "--node":
        options.nodePath = readOption(argv, ++index, argument);
        break;
      case "--token": {
        const token = readOption(argv, ++index, argument);
        tokens.push({ token, user: options.pendingTokenUser || "default" });
        options.pendingTokenUser = undefined;
        break;
      }
      case "--token-user": {
        const user = readOption(argv, ++index, argument);
        const last = tokens.at(-1);
        if (last) last.user = user;
        else options.pendingTokenUser = user;
        break;
      }
      case "--token-file": {
        const file = path.resolve(cwd, readOption(argv, ++index, argument));
        tokens.push(...readTokenFile(file));
        break;
      }
      case "--no-auth":
        options.noAuth = true;
        break;
      case "--idle-timeout":
        options.idleTimeoutMinutes = Number(readOption(argv, ++index, argument));
        break;
      case "--max-workspaces":
        options.maxWorkspaces = Number(readOption(argv, ++index, argument));
        break;
      case "--public-url":
        options.publicUrl = readOption(argv, ++index, argument);
        break;
      case "--webhook":
        options.webhookUrl = readOption(argv, ++index, argument);
        break;
      case "--log-level":
        options.logLevel = readOption(argv, ++index, argument);
        break;
      default:
        throw new UsageError(`Unknown option: ${argument}`);
    }
  }

  delete options.pendingTokenUser;
  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65_535) {
    throw new UsageError("--port must be a number between 0 and 65535.");
  }
  if (!Number.isFinite(options.maxWorkspaces) || options.maxWorkspaces < 1) {
    throw new UsageError("--max-workspaces must be a positive number.");
  }
  if (!Number.isFinite(options.idleTimeoutMinutes) || options.idleTimeoutMinutes < 0) {
    throw new UsageError("--idle-timeout must be zero or a positive number of minutes.");
  }
  if (!options.noAuth && tokens.length === 0) {
    throw new UsageError(
      "No tokens configured. Pass --token, --token-file or AETHER_TOKENS, or use --no-auth for local development.",
    );
  }

  return {
    ...options,
    dataDir: path.resolve(options.dataDir),
    tokens: dedupeTokens(tokens),
  };
}

function dedupeTokens(tokens) {
  const seen = new Map();
  for (const entry of tokens) {
    const token = String(entry?.token ?? "").trim();
    if (!token) continue;
    seen.set(token, { token, user: String(entry.user ?? "default").trim() || "default" });
  }
  return [...seen.values()];
}

function parseEnvironmentTokens(env) {
  const raw = env.AETHER_TOKENS?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.lastIndexOf(":");
        return separator === -1
          ? [entry, "default"]
          : [entry.slice(0, separator), entry.slice(separator + 1)];
      });
  }
  const single = env.AETHER_TOKEN?.trim();
  return single ? [[single, "default"]] : [];
}

export function readTokenFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UsageError(`Unable to read token file ${file}: ${error.message}`);
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.tokens;
  if (!Array.isArray(entries)) {
    throw new UsageError(`Token file ${file} must contain a "tokens" array.`);
  }
  return entries.map((entry) => ({
    token: String(entry?.token ?? "").trim(),
    user: String(entry?.user ?? "default").trim() || "default",
    label: entry?.label,
  }));
}

export function usage() {
  return USAGE;
}

export { UsageError };
