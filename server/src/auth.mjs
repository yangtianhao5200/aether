import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Token registry with constant-time comparisons.
 *
 * Tokens are hashed once at startup so a comparison never leaks length or
 * content through timing, and so the plaintext token never appears in logs or
 * heap dumps we control.
 */
export function createTokenRegistry(config) {
  const entries = config.tokens.map((entry) => ({
    digest: digestToken(entry.token),
    user: entry.user,
    label: entry.label ?? "",
  }));

  return {
    enabled: !config.noAuth,
    /** @returns {{user: string} | null} */
    identify(token) {
      if (config.noAuth) return { user: "anonymous" };
      const candidate = String(token ?? "");
      if (!candidate) return null;
      const digest = digestToken(candidate);
      let matched = null;
      for (const entry of entries) {
        if (entry.digest.length === digest.length && timingSafeEqual(entry.digest, digest)) {
          matched = entry;
        }
      }
      return matched ? { user: matched.user, label: matched.label } : null;
    },
    /** Only used by tests and diagnostics; never exposes tokens. */
    size: entries.length,
  };
}

function digestToken(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Extract a bearer token from headers, query string or the WS subprotocol. */
export function extractToken({ headers = {}, url = "" } = {}) {
  const header = headers.authorization ?? headers.Authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const custom = headers["x-aether-token"] ?? headers["X-Aether-Token"];
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  const query = new URL(url, "http://localhost").searchParams;
  const fromQuery = query.get("token");
  if (fromQuery) return fromQuery.trim();
  return "";
}
