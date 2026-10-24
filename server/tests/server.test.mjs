import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startAetherServer } from "../src/index.mjs";
import { defaultBridgePath } from "../src/config.mjs";

const TOKEN = "test-token-123";

async function withServer(callback) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "aether-server-"));
  const server = await startAetherServer({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    bridgePath: defaultBridgePath,
    nodePath: process.execPath,
    tokens: [{ token: TOKEN, user: "tester" }],
    noAuth: false,
    idleTimeoutMinutes: 0,
    maxWorkspaces: 4,
    publicUrl: "",
    webhookUrl: "",
    logLevel: "error",
  });
  try {
    await callback(server, dataDir);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Minimal WebSocket client with request/event correlation. */
class TestClient {
  constructor(url, token = TOKEN) {
    this.url = url;
    this.token = token;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.helloWaiters = [];
  }

  async connect({ workspace = "default", hello = true } = {}) {
    this.socket = new WebSocket(`${this.url.replace(/^http/, "ws")}/v1/agent`);
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (data) => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "hello") {
        this.hello = frame;
        for (const waiter of this.helloWaiters.splice(0)) waiter(frame);
        return;
      }
      if (frame.type === "event") {
        this.events.push(frame);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(frame)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        }
        return;
      }
      const waiter = this.pending.get(frame.id);
      if (waiter) {
        this.pending.delete(frame.id);
        waiter(frame);
      }
    });
    if (hello) await this.sendHello(workspace);
    return this;
  }

  async sendHello(workspace = "default") {
    this.socket.send(JSON.stringify({
      type: "hello",
      protocol: 1,
      token: this.token,
      workspace,
      client: { name: "aether-test", platform: "android" },
    }));
    this.hello = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for hello")), 15_000);
      this.helloWaiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
    return this.hello;
  }

  request(type, payload = {}, { timeout = 60_000 } = {}) {
    const id = `req-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${type}`));
      }, timeout);
      this.pending.set(id, (frame) => {
        clearTimeout(timer);
        if (frame.type === "error" || frame.ok === false) {
          reject(Object.assign(new Error(frame.error?.message ?? "request failed"), {
            code: frame.error?.code,
          }));
        } else {
          resolve(frame.payload);
        }
      });
      this.socket.send(JSON.stringify({ id, type, payload }));
    });
  }

  waitFor(predicate, timeout = 30_000, label = "condition") {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${label}`)), timeout);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  close() {
    this.socket?.close();
  }
}

test("rejects unauthenticated hello and HTTP requests", async () => {
  await withServer(async (server) => {
    const client = new TestClient(server.url, "wrong-token");
    await client.connect({ hello: false });
    const helloPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for hello")), 10_000);
      client.helloWaiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
    client.socket.send(JSON.stringify({
      type: "hello",
      protocol: 1,
      token: "wrong-token",
      workspace: "default",
    }));
    const hello = await helloPromise;
    assert.equal(hello.ok, false);
    assert.equal(hello.error.code, "unauthorized");
    client.close();

    const response = await fetch(`${server.url}/v1/info`, {
      headers: { authorization: "Bearer nope" },
    });
    assert.equal(response.status, 401);
  });
});

test("requires a hello frame before bridge traffic", async () => {
  await withServer(async (server) => {
    const client = new TestClient(server.url);
    await client.connect({ hello: false });
    const error = await new Promise((resolve) => {
      client.socket.on("message", (data) => {
        const frame = JSON.parse(data.toString("utf8"));
        if (frame.type === "error") resolve(frame);
      });
      client.socket.send(JSON.stringify({ id: "early", type: "ping", payload: {} }));
    });
    assert.equal(error.error.code, "handshake_required");
    client.close();
  });
});

test("hello exposes server-side paths and answers server pings", async () => {
  await withServer(async (server) => {
    const client = await new TestClient(server.url).connect();
    assert.equal(client.hello.ok, true);
    assert.equal(client.hello.workspace, "tester/default");
    assert.ok(client.hello.paths.home.startsWith(server.config.dataDir));
    assert.ok(client.hello.paths.workspace.endsWith(path.join("workspace")));
    assert.ok(client.hello.capabilities.server_ops.includes("srv_fs"));

    const pong = await client.request("srv_ping");
    assert.equal(pong.pong, true);

    const info = await client.request("srv_info");
    assert.equal(info.workspace.id, "tester/default");
    assert.equal(info.workspace.home_directory, client.hello.paths.home);
    client.close();
  });
});

test("remote filesystem operations stay inside the workspace", async () => {
  await withServer(async (server) => {
    const client = await new TestClient(server.url).connect();
    const workspace = client.hello.paths.workspace;

    await client.request("srv_fs", {
      op: "write",
      path: path.join(workspace, "notes", "hello.txt"),
      text: "远程写入 OK",
    });
    const read = await client.request("srv_fs", {
      op: "read",
      path: path.join(workspace, "notes", "hello.txt"),
      encoding: "utf8",
    });
    assert.equal(read.text, "远程写入 OK");

    const listing = await client.request("srv_fs", { op: "list", path: workspace });
    assert.ok(listing.entries.some((entry) => entry.name === "notes" && entry.is_directory));

    const stat = await client.request("srv_fs", { op: "stat", path: "notes/hello.txt" });
    assert.equal(stat.is_directory, false);

    // Traversal and absolute escapes must be refused.
    await assert.rejects(
      client.request("srv_fs", { op: "read", path: "/etc/passwd" }),
      /outside this workspace/,
    );
    await assert.rejects(
      client.request("srv_fs", { op: "read", path: "../../../../etc/passwd" }),
      /outside this workspace/,
    );
    client.close();
  });
});

test("remote exec streams output and reports the exit code", async () => {
  await withServer(async (server) => {
    const client = await new TestClient(server.url).connect();
    const chunks = [];
    const collected = new Promise((resolve) => {
      const timer = setInterval(() => {
        const output = client.events.filter((frame) => frame.event === "srv_exec_output");
        if (output.length > 0) {
          clearInterval(timer);
          resolve(output);
        }
      }, 50);
    });
    const result = await client.request("srv_exec", {
      command: "printf 'hello-from-server\\n'; pwd",
      timeout_ms: 20_000,
    });
    const output = await collected;
    for (const frame of output) chunks.push(Buffer.from(frame.payload.data_base64, "base64").toString());
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /hello-from-server/);
    assert.match(result.stdout, new RegExp(client.hello.paths.workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(chunks.join("").includes("hello-from-server"));
    client.close();
  });
});

test("bridges real pi-bridge frames and broadcasts events to every client", async () => {
  await withServer(async (server) => {
    const phone = await new TestClient(server.url).connect();
    const observer = await new TestClient(server.url).connect();

    const providers = await phone.request("list_providers", {}, { timeout: 120_000 });
    assert.ok(Array.isArray(providers.providers));
    assert.ok(providers.providers.length > 0);

    const ping = await phone.request("ping");
    assert.equal(ping.workspace_directory, phone.hello.paths.workspace);

    // A server status event is broadcast to all clients of the workspace.
    const status = await observer.waitFor(
      (frame) => frame.event === "server_status",
      20_000,
      "server_status",
    );
    assert.ok(status.payload.workspace);
    phone.close();
    observer.close();
  });
});

test("journal records agent frames and replays them", async () => {
  await withServer(async (server) => {
    const client = await new TestClient(server.url).connect();
    await client.request("list_providers", {}, { timeout: 120_000 });

    const journal = await client.request("srv_journal", { limit: 100 });
    assert.ok(journal.records.length > 0);
    assert.ok(journal.records.some((record) => record.type === "list_providers" && record.dir === "in"));
    assert.ok(journal.records.some((record) => record.dir === "out"));

    const workspace = client.hello.paths.workspace;
    const journalDirectory = path.join(path.dirname(workspace), ".aether", "journal");
    const files = (await readdir(journalDirectory)).filter((name) => name.endsWith(".jsonl")).sort();
    assert.ok(files.length > 0);
    const content = await readFile(path.join(journalDirectory, files.at(-1)), "utf8");
    assert.match(content, /list_providers/);
    client.close();
  });
});

test("HTTP API mirrors the WebSocket surface", async () => {
  await withServer(async (server) => {
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const info = await fetch(`${server.url}/v1/info`, { headers }).then((response) => response.json());
    assert.equal(info.server_version, "1.0.0");
    assert.ok(Array.isArray(info.workspaces));

    const write = await fetch(`${server.url}/v1/workspaces/default/fs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ op: "write", path: "api.txt", text: "http" }),
    }).then((response) => response.json());
    assert.ok(write.bytes_written > 0);

    const exec = await fetch(`${server.url}/v1/workspaces/default/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "cat api.txt" }),
    }).then((response) => response.json());
    assert.equal(exec.stdout.trim(), "http");

    const health = await fetch(`${server.url}/healthz`).then((response) => response.json());
    assert.equal(health.ok, true);
  });
});

test("restarting the bridge keeps the same workspace", async () => {
  await withServer(async (server) => {
    const client = await new TestClient(server.url).connect();
    await client.request("list_providers", {}, { timeout: 120_000 });
    const restarted = await client.request("srv_bridge_restart", {}, { timeout: 120_000 });
    assert.equal(restarted.running, true);
    const providers = await client.request("list_providers", {}, { timeout: 120_000 });
    assert.ok(providers.providers.length > 0);
    client.close();
  });
});

test("server-side processes stream stdin, stdout and exit codes", async () => {
  await withServer(async (server) => {
    const client = new TestClient(server.url);
    await client.connect();
    const hello = client.hello;
    const started = await client.request("srv_process_start", {
      command: "node -e \"process.stdin.on('data', d => process.stdout.write(d.toString().toUpperCase()))\"",
      cwd: hello.paths.workspace,
    });
    assert.match(started.process_id, /^proc_/);
    const output = client.waitFor(
      (frame) => frame.event === "srv_process_output" &&
        frame.payload?.process_id === started.process_id &&
        Buffer.from(frame.payload.data_base64, "base64").toString().includes("HELLO"),
      20_000,
      "process output",
    );
    await client.request("srv_process_stdin", {
      process_id: started.process_id,
      data_base64: Buffer.from("hello\n").toString("base64"),
    });
    await output;
    await client.request("srv_process_close_stdin", { process_id: started.process_id });
    const exit = await client.waitFor(
      (frame) => frame.event === "srv_process_exit" &&
        frame.payload?.process_id === started.process_id,
      20_000,
      "process exit",
    );
    assert.equal(exit.payload.exit_code, 0);
    const listed = await client.request("srv_process_list", {});
    assert.ok(!listed.processes.some((entry) => entry.process_id === started.process_id));
    client.close();
  });
});

test("hello advertises bridge bundles inside the workspace home", async () => {
  await withServer(async (server) => {
    const client = new TestClient(server.url);
    await client.connect();
    const hello = client.hello;
    assert.ok(hello.paths.bridge.startsWith(hello.paths.home));
    assert.ok(hello.paths.extensions.startsWith(hello.paths.home));
    const entries = await readdir(hello.paths.bridge);
    assert.ok(entries.includes("bridge.mjs"));
    assert.ok(entries.includes("extension-bridge.mjs"));
    client.close();
  });
});

test("runs a real agent turn on the server with tools executing remotely", async () => {
  await withServer(async (server) => {
    const client = new TestClient(server.url);
    await client.connect();
    const hello = client.hello;

    // The Pi bridge ships a deterministic "faux" provider: no network, no keys.
    const modelConfig = {
      provider_type: "faux",
      provider_config_id: "faux",
      pi_provider_id: "faux",
      pi_api: "openai-completions",
      model_id: "faux-model",
      base_url: "",
      api_key: "",
      reasoning: false,
      faux_tool_calls: [
        {
          name: "bash",
          arguments: {
            command: "printf 'remote-agent-ok' > marker.txt && pwd",
          },
        },
      ],
      faux_response: "The marker file is written.",
    };

    const runId = "run-e2e-1";
    const toolEvent = client.waitFor(
      (frame) => frame.event === "tool_call_end" || frame.event === "tool_call_start",
      120_000,
      "tool event",
    );
    const response = await client.request(
      "run_turn",
      {
        model_config: modelConfig,
        session_id: "session-e2e",
        system_prompt: "You are a test agent.",
        messages: [{ role: "user", content: "write the marker file" }],
        workspace_directory: hello.paths.workspace,
        workspace_trusted: true,
        runtime: "server",
        platform: "android",
        reasoning: "off",
        chrome_enabled: false,
        skill_paths: [],
        host_tools: [],
      },
      { timeout: 180_000 },
    );
    assert.ok(runId);
    await toolEvent;
    assert.ok(response, "run_turn answered");
    // The bridge must have honoured runtime: "server" (not fallen back to alpine).
    assert.equal(response.runtime, "server");

    // The tool really ran on the server, inside the server workspace.
    const marker = await client.request("srv_fs", {
      op: "read",
      path: path.join(hello.paths.workspace, "marker.txt"),
      encoding: "utf8",
    });
    const text = marker.data_base64
      ? Buffer.from(marker.data_base64, "base64").toString("utf8")
      : marker.content ?? marker.text;
    assert.match(String(text), /remote-agent-ok/);

    // Session state lives on the server too.
    const state = await client.request("get_session_state", { session_id: "session-e2e" });
    assert.ok(state);
    client.close();
  });
});

test("reads a prefix of a large file instead of failing", async () => {
  await withServer(async (server) => {
    const client = new TestClient(server.url);
    await client.connect();
    const hello = client.hello;
    const big = Buffer.alloc(64 * 1024, 0x61);
    await client.request("srv_fs", {
      op: "write",
      path: path.join(hello.paths.workspace, "big.txt"),
      data_base64: big.toString("base64"),
    });
    const head = await client.request("srv_fs", {
      op: "read",
      path: path.join(hello.paths.workspace, "big.txt"),
      encoding: "base64",
      max_bytes: 1024,
      prefix: true,
    });
    assert.equal(head.truncated, true);
    assert.equal(Buffer.from(head.data_base64, "base64").length, 1024);
    client.close();
  });
});
