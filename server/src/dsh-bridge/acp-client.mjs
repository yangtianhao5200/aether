import { spawn } from "node:child_process";

/**
 * Minimal Agent Client Protocol (ACP) client over JSON-RPC stdio.
 *
 * DeepSeek Harness ships an ACP profile (`dsh --profile acp`), so a plain
 * child process is enough: we write newline-delimited JSON-RPC requests and
 * consume the agent's `session/update` notifications.
 */
export class AcpClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #buffer = "";
  #closed = false;
  #onUpdate;
  #onPermission;
  #stderr;

  constructor({ command, args = [], env = {}, cwd, onUpdate, onPermission, log = () => {} }) {
    this.#onUpdate = onUpdate ?? (() => {});
    this.#onPermission = onPermission ?? (() => "allow_once");
    this.#stderr = log;
    this.#child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) this.#stderr(line.trim());
      }
    });
    this.#child.on("exit", (code, signal) => {
      this.#closed = true;
      for (const [, pending] of this.#pending) {
        pending.reject(new Error(`ACP agent exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`));
      }
      this.#pending.clear();
    });
  }

  get closed() {
    return this.#closed;
  }

  /** `initialize` handshake. */
  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    this.agentInfo = result?.agentInfo ?? {};
    this.sessionCapabilities = result?.agentCapabilities?.sessionCapabilities ?? {};
    return result;
  }

  async newSession({ cwd, mcpServers = [] }) {
    return this.request("session/new", { cwd, mcpServers });
  }

  async loadSession({ sessionId, cwd, mcpServers = [] }) {
    return this.request("session/load", { sessionId, cwd, mcpServers });
  }

  async setConfigOption({ sessionId, configId, value }) {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  async prompt({ sessionId, text }) {
    return this.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      { timeoutMs: 0 },
    );
  }

  async cancel(sessionId) {
    this.notify("session/cancel", { sessionId });
  }

  async closeSession(sessionId) {
    return this.request("session/close", { sessionId });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  request(method, params, { timeoutMs = 120000 } = {}) {
    if (this.#closed) return Promise.reject(new Error("ACP agent is not running."));
    const id = this.#nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      let timer;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`ACP request "${method}" timed out.`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#write(payload);
    });
  }

  dispose() {
    this.#closed = true;
    try {
      this.#child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

  #write(message) {
    if (!this.#child.stdin.writable) return;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consume(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#stderr(`acp: ignoring malformed line: ${line.slice(0, 200)}`);
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? "ACP request failed.");
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "session/update") {
      this.#onUpdate(message.params ?? {});
      return;
    }
    if (message.method === "session/request_permission") {
      const params = message.params ?? {};
      const outcome = this.#onPermission(params);
      const response = outcome === "cancel"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: outcome } };
      this.#write({ jsonrpc: "2.0", id: message.id, result: response });
      return;
    }
    if (message.id !== undefined && message.method) {
      // Unsupported client-side method (fs/terminal/elicitation): answer with a
      // JSON-RPC error so the agent can fall back instead of hanging.
      this.#write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported client method: ${message.method}` },
      });
    }
  }
}
