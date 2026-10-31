/**
 * Thin gateway to the DeepSeek Harness native RPC.
 *
 * The phone talks to the Aether server with a single bearer token; it never
 * needs the harness port or its launch token. This module forwards
 * `POST /v1/dsh/rpc` calls to the harness's own `POST /api/<namespace>/<method>`
 * and holds the browser-session cookie the harness requires.
 *
 * The harness authenticates a root request carrying `?token=<launchToken>` by
 * minting a signed, authority-bound cookie; every later `/api` request must
 * present it. The cookie is cached here per authority and refreshed on a 401.
 */

const COOKIE_TTL_MS = 20 * 60 * 1000;

/** Per-authority cookie cache. */
const cookies = new Map();

/** Path-safe base: strips a trailing slash. */
function trimBase(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

/**
 * Fetch (or reuse) the harness browser-session cookie for an origin.
 *
 * @param {string} base harness origin, e.g. http://127.0.0.1:3081
 * @param {string} launchToken the harness process launch token
 * @param {boolean} force ignore the cache (after a 401)
 */
async function cookieFor(base, launchToken, force = false) {
  const key = `${base}::${launchToken}`;
  const cached = cookies.get(key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.value;

  const url = `${base}/?token=${encodeURIComponent(launchToken)}`;
  const response = await fetch(url, { redirect: "manual" });
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers.get("set-cookie") ?? "").split(/,(?=\s*[^;=]+=)/);
  const value = setCookies
    .map((line) => String(line).split(";")[0].trim())
    .filter((pair) => pair.includes("="))
    .join("; ");
  if (!value) {
    const error = new Error(
      `The harness did not accept the launch token (HTTP ${response.status}). ` +
        "Check the DSH access token in Settings.",
    );
    error.code = "dsh_auth";
    throw error;
  }
  cookies.set(key, { value, expiresAt: Date.now() + COOKIE_TTL_MS });
  return value;
}

/**
 * Forward one unary RPC call to the harness.
 *
 * @param {object} options
 * @param {string} options.base harness origin
 * @param {string} options.launchToken harness launch token
 * @param {string} options.namespace e.g. `session`
 * @param {string} options.method e.g. `prompt`
 * @param {object} [options.args] the call arguments (becomes `payload.args`)
 * @returns {Promise<{ok: boolean, value?: any, error?: {code: string, message: string}}>}
 */
export async function dshRpc({ base, launchToken, namespace, method, args = {}, timeoutMs = 120000 }) {
  const origin = trimBase(base);
  if (!origin) {
    const error = new Error("The harness URL is not configured.");
    error.code = "dsh_not_configured";
    throw error;
  }
  const ns = String(namespace ?? "").trim();
  const name = String(method ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(ns) || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    const error = new Error("namespace and method must be plain identifiers.");
    error.code = "dsh_bad_request";
    throw error;
  }
  const endpoint = `${ns}/${name}`;
  const envelope = JSON.stringify({
    type: "client-request",
    rpcId: randomId(),
    method: endpoint,
    payload: { args: args ?? {} },
  });

  const attempt = async (force) => {
    const cookie = await cookieFor(origin, launchToken, force);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${origin}/api/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: envelope,
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, text };
    } finally {
      clearTimeout(timer);
    }
  };

  let { status, text } = await attempt(false);
  if (status === 401) ({ status, text } = await attempt(true));

  if (status === 404) {
    const error = new Error(`The harness has no endpoint "${endpoint}".`);
    error.code = "dsh_not_found";
    throw error;
  }
  if (status === 401) {
    const error = new Error("The harness rejected the session cookie.");
    error.code = "dsh_auth";
    throw error;
  }
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    const error = new Error(`The harness answered HTTP ${status} with a non-JSON body.`);
    error.code = "dsh_bad_response";
    throw error;
  }
  const result = root?.result;
  if (!result || typeof result !== "object") {
    const error = new Error("The harness response has no result.");
    error.code = "dsh_bad_response";
    throw error;
  }
  if (result.ok === true) {
    return { ok: true, value: result.value === undefined ? null : result.value };
  }
  const err = result.error ?? {};
  return {
    ok: false,
    error: {
      code: typeof err.code === "string" ? err.code : "dsh_error",
      message: typeof err.message === "string" ? err.message : "The harness rejected the call.",
    },
  };
}

function randomId() {
  return `aether-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Open one harness stream (`session/follow`, …) and relay its items.
 *
 * @param {object} options
 * @param {string} options.base harness origin (http://…)
 * @param {string} options.launchToken harness launch token
 * @param {string} options.endpoint e.g. `session/follow`
 * @param {object} options.args the stream payload (`{request: …}`)
 * @param {(value: any) => void} options.onItem
 * @param {() => void} options.onEnd
 * @param {(error: Error) => void} options.onError
 * @param {typeof WsClient} [WsClientRef] injected ws client (keeps `ws` optional)
 * @returns {{cancel: () => void}}
 */
export async function openDshStream({ base, launchToken, endpoint, args = {}, onItem, onEnd, onError }, WsClientRef) {
  const origin = trimBase(base);
  const Ws = WsClientRef ?? (await import("ws")).WebSocket;
  const cookie = await cookieFor(origin, launchToken);
  const muxUrl = origin.replace(/^http/, "ws") + "/api/remote.mux";
  const streamId = randomId();
  const ws = new Ws(muxUrl, { headers: { cookie } });
  let settled = false;

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
  });
  ws.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (frame.streamId !== streamId) return;
    switch (frame.type) {
      case "item":
        onItem?.(frame.value);
        break;
      case "end":
        settled = true;
        onEnd?.();
        ws.close();
        break;
      case "error":
        settled = true;
        onError?.(new Error(frame?.error?.message ?? "stream failed"));
        ws.close();
        break;
      default:
        break;
    }
  });
  ws.on("close", () => {
    if (!settled) onEnd?.();
  });
  ws.on("error", (error) => {
    if (!settled) onError?.(error);
  });

  return {
    cancel() {
      settled = true;
      try {
        ws.send(JSON.stringify({ type: "cancel", streamId }));
      } catch {
        // already gone
      }
      try {
        ws.close();
      } catch {
        // already gone
      }
    },
  };
}
