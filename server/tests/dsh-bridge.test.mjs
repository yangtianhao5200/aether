import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const bridgePath = path.join(import.meta.dirname, "..", "bin", "dsh-bridge.mjs");
const fakeAgentPath = path.join(import.meta.dirname, "fixtures", "fake-acp-agent.mjs");

/** Drives the bridge over stdio and collects frames. */
function startBridge(workspace) {
  const child = spawn(process.execPath, [bridgePath], {
    cwd: workspace,
    env: {
      ...process.env,
      AETHER_WORKSPACE_DIR: workspace,
      AETHER_DSH_NODE: process.execPath,
      AETHER_DSH_ARGS: fakeAgentPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = [];
  const waiters = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.match(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const waitFor = (match, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const existing = frames.find(match);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for frame; stderr=${stderr}`)), timeoutMs);
      waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  const send = (type, payload = {}, id = type) =>
    child.stdin.write(`${JSON.stringify({ type, id, payload })}\n`);
  return { child, frames, waitFor, send, stderr: () => stderr };
}

async function withWorkspace(run) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "aether-dsh-"));
  const bridge = startBridge(workspace);
  try {
    await run(bridge, workspace);
  } finally {
    bridge.child.kill();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test("dsh bridge answers ping", async () => {
  await withWorkspace(async ({ send, waitFor }) => {
    send("ping");
    const frame = await waitFor((candidate) => candidate.type === "response" && candidate.id === "ping");
    assert.equal(frame.payload.runtime, "dsh");
    assert.match(frame.payload.bridge_version, /dsh-bridge/);
  });
});

test("dsh bridge exposes the ACP model catalog as providers", async () => {
  await withWorkspace(async ({ send, waitFor }) => {
    send("list_providers");
    const frame = await waitFor((candidate) => candidate.type === "response" && candidate.id === "list_providers");
    assert.equal(frame.payload.providers.length, 1);
    const provider = frame.payload.providers[0];
    assert.equal(provider.id, "deepseek-official");
    assert.deepEqual(
      provider.models.map((model) => model.id),
      [JSON.stringify(["deepseek-official", "deepseek-v4-flash"]), JSON.stringify(["deepseek-official", "deepseek-v4-pro"])],
    );
  });
});

test("dsh bridge streams a turn as bridge events", async () => {
  await withWorkspace(async ({ send, waitFor }) => {
    send("run_turn", {
      session_id: "app-session-1",
      model_config: { provider: "deepseek-official", model: "deepseek-v4-pro" },
      reasoning: "high",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "say hello" },
      ],
    });

    const text = await waitFor((frame) => frame.type === "event" && frame.event === "assistant_text_delta");
    assert.equal(text.payload.delta, "Hello ");

    const thought = await waitFor((frame) => frame.type === "event" && frame.event === "assistant_reasoning_delta");
    assert.equal(thought.payload.delta, "planning");

    // The harness execution plan arrives as its own card.
    const planStart = await waitFor((frame) => frame.type === "event" && frame.event === "tool_call_start");
    assert.equal(planStart.payload.name, "plan");
    assert.equal(planStart.payload.arguments.entries.length, 2);
    assert.equal(planStart.payload.arguments.entries[0].status, "in_progress");

    const toolStart = await waitFor(
      (frame) => frame.type === "event"
        && frame.event === "tool_call_start"
        && frame.payload.name === "bash",
    );
    assert.equal(toolStart.payload.arguments.command, "echo say hello");

    const toolEnd = await waitFor((frame) => frame.type === "event" && frame.event === "tool_call_end");
    assert.equal(toolEnd.payload.is_error, false);

    const usage = await waitFor((frame) => frame.type === "event" && frame.event === "context_usage");
    assert.equal(usage.payload.used, 1200);
    assert.equal(usage.payload.full, 128000);

    const done = await waitFor((frame) => frame.type === "response" && frame.id === "run_turn");
    assert.equal(done.payload.assistant_text, "Hello from DSH");
    assert.equal(done.payload.reasoning_text, "planning");
    assert.equal(done.payload.stop_reason, "end_turn");
    assert.equal(done.payload.usage.input_tokens, 100);
    assert.equal(done.payload.usage.output_tokens, 12);
  });
});

test("dsh bridge rejects methods the harness runtime does not implement", async () => {
  await withWorkspace(async ({ send, waitFor }) => {
    send("complete_once", {});
    const frame = await waitFor((candidate) => candidate.type === "error" && candidate.id === "complete_once");
    assert.equal(frame.error.code, "unsupported_method");
  });
});

test("dsh launcher arguments drop a legacy node prefix", async () => {
  const { normalizeDshArgs } = await import("../src/config.mjs");
  // Old deployments wrote "node /path/to/dsh bin --profile acp"; the bridge must
  // keep only the flags, otherwise the harness reads the profile as "node".
  assert.equal(
    normalizeDshArgs("node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile acp --patch /x.yml"),
    "--profile acp --patch /x.yml",
  );
  assert.equal(normalizeDshArgs("--profile acp"), "--profile acp");
  assert.equal(normalizeDshArgs("/usr/local/bin/node --profile acp"), "--profile acp");
});
