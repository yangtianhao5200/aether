#!/usr/bin/env node
/**
 * Scripted ACP agent used by the DSH bridge tests.
 *
 * It answers the ACP handshake, streams a deterministic turn (thought, text,
 * one tool call, usage) and honours cancel/close, so the bridge can be tested
 * without an API key or a real model.
 */
import readline from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const sessions = new Set();
let prompts = 0;

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]),
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          { value: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]), name: "deepseek-v4-flash" },
          { value: JSON.stringify(["deepseek-official", "deepseek-v4-pro"]), name: "DeepSeek-V4-Pro" },
        ],
      },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

function update(sessionId, body) {
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-dsh-acp", version: "0.0.1" },
          agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } },
          authMethods: [],
        },
      });
      return;
    case "session/new": {
      const sessionId = `fake-${sessions.size + 1}`;
      sessions.add(sessionId);
      write({ jsonrpc: "2.0", id, result: { sessionId, configOptions } });
      return;
    }
    case "session/set_config_option":
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    case "session/close":
      sessions.delete(params?.sessionId);
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    case "session/prompt": {
      prompts += 1;
      const sessionId = params.sessionId;
      const text = (params.prompt ?? []).map((block) => block.text ?? "").join("");
      setTimeout(() => update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "planning" } }), 10);
      setTimeout(() => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } }), 20);
      setTimeout(() => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "from DSH" } }), 30);
      setTimeout(() => update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "bash",
        kind: "execute",
        rawInput: { command: `echo ${text.slice(0, 20)}` },
        status: "pending",
      }), 40);
      setTimeout(() => update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      }), 50);
      setTimeout(() => update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 128000 }), 55);
      setTimeout(() => write({
        jsonrpc: "2.0",
        id,
        result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 12, totalTokens: 112 } },
      }), 70);
      return;
    }
    case "session/cancel":
      return;
    default:
      if (id !== undefined) {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
      }
  }
});
