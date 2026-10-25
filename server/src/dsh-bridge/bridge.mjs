import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { normalizeDshArgs } from "../config.mjs";
import { dshHostInfo, readProfilePatch, setProfilePluginEnabled } from "../dsh-host.mjs";
import { AcpClient } from "./acp-client.mjs";

const BRIDGE_VERSION = "aether-dsh-bridge/1.0.0";

/**
 * Aether bridge protocol on top of a DeepSeek Harness ACP agent.
 *
 * The Android app speaks the same JSON-lines protocol it uses for the Pi
 * bridge, so every existing screen (chat, tool cards, reasoning, usage) works
 * unchanged while the agent itself runs in `dsh --profile acp`.
 */

const write = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const writeEvent = (id, event, payload = {}) => write({ type: "event", id, event, payload });
const writeResponse = (id, payload = {}) => write({ type: "response", id, ok: true, payload });
const writeError = (id, message, code = "bridge_error") =>
  write({ type: "error", id: id ?? "", ok: false, error: { code, message: String(message) } });

const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const asString = (value, fallback = "") =>
  typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asObject(messages[index]);
    if (asString(message.role) !== "user") continue;
    const text = textFromContent(message.content).trim();
    if (text) return text;
  }
  return "";
}

class DshRuntime {
  constructor({ command, args, env, cwd, log }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.log = log;
    this.client = null;
    this.catalog = null;
    this.sessions = new Map();
    this.stateFile = path.join(cwd, ".aether-dsh-sessions.json");
    this.persisted = this.#loadState();
  }

  #loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return {};
    }
  }

  #saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.persisted, null, 2));
    } catch {
      // best effort only
    }
  }

  async ensureClient() {
    if (this.client && !this.client.closed) return this.client;
    const client = new AcpClient({
      command: this.command,
      args: this.args,
      env: this.env,
      cwd: this.cwd,
      log: this.log,
      onUpdate: (params) => this.#onUpdate(params),
      onPermission: () => this.autoApprove ?? "allow_once",
    });
    await client.initialize();
    this.client = client;
    this.autoApprove = this.#permissionOptionId(client);
    return client;
  }

  #permissionOptionId(client) {
    const options = client.permissionOptions ?? [];
    const preferred = options.find((option) => /allow.*(once|always)/i.test(option.optionId ?? ""))
      ?? options.find((option) => /allow/i.test(option.kind ?? ""))
      ?? options[0];
    return preferred?.optionId ?? "allow_once";
  }

  /** Active prompt sink, set while a `run_turn` is streaming. */
  setSink(sink) {
    this.sink = sink;
  }

  #onUpdate(params) {
    const update = asObject(params.update);
    const sink = this.sink;
    if (!sink) return;
    sink(update);
  }

  async providerCatalog() {
    if (this.catalog) return this.catalog;
    const client = await this.ensureClient();
    const probe = await client.newSession({ cwd: this.cwd });
    const options = Array.isArray(probe.configOptions) ? probe.configOptions : [];
    const modelOption = options.find((option) => option.id === "model");
    const providers = new Map();
    for (const group of modelOption?.options ?? []) {
      const providerId = asString(group.group) || "default";
      const provider = providers.get(providerId) ?? {
        id: providerId,
        name: asString(group.name) || providerId,
        base_url: "",
        auth: { api_key: "", api_key_login: false, oauth: "", ambient: false },
        models: [],
      };
      for (const model of group.options ?? []) {
        provider.models.push({
          id: asString(model.value),
          name: asString(model.name) || asString(model.value),
          api: "openai-completions",
        });
      }
      providers.set(providerId, provider);
    }
    this.catalog = {
      providers: [...providers.values()],
      config_options: options,
    };
    await client.closeSession(probe.sessionId).catch(() => {});
    return this.catalog;
  }

  async sessionFor(appSessionId) {
    const existing = this.sessions.get(appSessionId);
    if (existing) return existing;
    const client = await this.ensureClient();
    const created = await client.newSession({ cwd: this.cwd });
    const entry = {
      appSessionId,
      acpSessionId: created.sessionId,
      configOptions: created.configOptions ?? [],
    };
    this.sessions.set(appSessionId, entry);
    this.persisted[appSessionId] = created.sessionId;
    this.#saveState();
    return entry;
  }

  async applyModel(entry, modelConfig, reasoning) {
    const client = await this.ensureClient();
    const modelOption = entry.configOptions.find((option) => option.id === "model");
    const values = (modelOption?.options ?? []).flatMap((group) =>
      (group.options ?? []).map((model) => asString(model.value)),
    );
    const provider = asString(asObject(modelConfig).provider);
    const model = asString(asObject(modelConfig).model);
    let value = "";
    if (provider && model) {
      const joined = JSON.stringify([provider, model]);
      value = values.includes(joined) ? joined : "";
      if (!value) {
        const match = values.find((candidate) => candidate.includes(`"${model}"`));
        value = match ?? "";
      }
    } else if (model) {
      value = values.find((candidate) => candidate.includes(`"${model}"`)) ?? "";
    }
    if (value) {
      await client.setConfigOption({ sessionId: entry.acpSessionId, configId: "model", value })
        .catch((error) => this.log(`set model failed: ${error.message}`));
    }
    const effort = asString(reasoning);
    if (effort) {
      const normalized = ["off", "low", "high", "max"].includes(effort) ? effort : "";
      if (normalized) {
        await client.setConfigOption({
          sessionId: entry.acpSessionId,
          configId: "reasoning_effort",
          value: normalized,
        }).catch((error) => this.log(`set reasoning failed: ${error.message}`));
      }
    }
  }

  async runTurn(requestId, payload) {
    const client = await this.ensureClient();
    const appSessionId = asString(payload.session_id) || "default";
    const entry = await this.sessionFor(appSessionId);
    await this.applyModel(entry, payload.model_config, payload.reasoning);

    const text = lastUserText(payload.messages);
    if (!text) throw new Error("run_turn requires a user message.");

    let assistantText = "";
    let reasoningText = "";
    const toolNames = new Map();
    const toolArgs = new Map();

    this.setSink((update) => {
      switch (asString(update.sessionUpdate)) {
        case "agent_message_chunk": {
          const delta = textFromContent(update.content);
          if (!delta) return;
          assistantText += delta;
          writeEvent(requestId, "assistant_text_delta", { delta });
          return;
        }
        case "agent_thought_chunk": {
          const delta = textFromContent(update.content);
          if (!delta) return;
          reasoningText += delta;
          writeEvent(requestId, "assistant_reasoning_delta", { delta });
          return;
        }
        case "tool_call": {
          const toolCallId = asString(update.toolCallId);
          const name = asString(update.title) || asString(update.kind) || "tool";
          toolNames.set(toolCallId, name);
          toolArgs.set(toolCallId, asObject(update.rawInput));
          writeEvent(requestId, "tool_call_start", {
            id: toolCallId,
            name,
            arguments: asObject(update.rawInput),
            arguments_json: JSON.stringify(asObject(update.rawInput)),
          });
          return;
        }
        case "tool_call_update": {
          const toolCallId = asString(update.toolCallId);
          const name = toolNames.get(toolCallId) ?? asString(update.title) ?? "tool";
          const status = asString(update.status);
          const args = Object.keys(asObject(update.rawInput)).length > 0
            ? asObject(update.rawInput)
            : (toolArgs.get(toolCallId) ?? {});
          if (status === "completed" || status === "failed") {
            const content = Array.isArray(update.content) ? update.content : [];
            writeEvent(requestId, "tool_call_end", {
              id: toolCallId,
              name,
              arguments: args,
              arguments_json: JSON.stringify(args),
              content,
              output_json: JSON.stringify({ status, content }),
              raw_output_json: "",
              details: {},
              is_error: status === "failed",
            });
            return;
          }
          writeEvent(requestId, "tool_call_delta", {
            id: toolCallId,
            name,
            arguments: args,
            arguments_json: JSON.stringify(args),
            content: Array.isArray(update.content) ? update.content : [],
          });
          return;
        }
        case "plan":
        case "plan_update": {
          // Harness execution plans are shown as their own card in the app.
          const entries = Array.isArray(update.entries) ? update.entries : [];
          const payload = {
            id: "plan",
            name: "plan",
            arguments: { entries },
            arguments_json: JSON.stringify({ entries }),
          };
          writeEvent(
            requestId,
            asString(update.sessionUpdate) === "plan" ? "tool_call_start" : "tool_call_delta",
            payload,
          );
          return;
        }
        case "plan_removed":
          writeEvent(requestId, "tool_call_end", {
            id: "plan",
            name: "plan",
            arguments: {},
            arguments_json: "{}",
            content: [],
            output_json: "",
            raw_output_json: "",
            details: {},
            is_error: false,
          });
          return;
        case "usage_update": {
          writeEvent(requestId, "context_usage", {
            used: update.used ?? null,
            full: update.size ?? null,
          });
          return;
        }
        default:
          return;
      }
    });

    let result;
    try {
      result = await client.prompt({ sessionId: entry.acpSessionId, text });
    } finally {
      this.setSink(null);
    }

    const usage = asObject(result?.usage);
    const usagePayload = {
      input_tokens: Number(usage.inputTokens ?? usage.input_tokens ?? 0),
      output_tokens: Number(usage.outputTokens ?? usage.output_tokens ?? 0),
      total_tokens: Number(usage.totalTokens ?? usage.total_tokens ?? 0),
      request_count: 1,
    };
    writeEvent(requestId, "assistant_done", {
      assistant_text: assistantText,
      reasoning_text: reasoningText,
      usage: usagePayload,
      stop_reason: asString(result?.stopReason),
    });
    return {
      session_id: appSessionId,
      assistant_text: assistantText,
      reasoning_text: reasoningText,
      usage: usagePayload,
      stop_reason: asString(result?.stopReason),
      provider: asString(asObject(payload.model_config).provider),
      model: asString(asObject(payload.model_config).model),
      runtime: "dsh",
      cwd: this.cwd,
    };
  }
}

async function main() {
  const cwd = process.env.AETHER_WORKSPACE_DIR || process.cwd();
  // AETHER_DSH_COMMAND is the harness launcher (default: `dsh` on PATH) and
  // AETHER_DSH_ARGS its flags only, e.g. "--profile acp --patch patch.yml".
  const runtime = new DshRuntime({
    command: process.env.AETHER_DSH_COMMAND || process.env.AETHER_DSH_NODE || "dsh",
    args: normalizeDshArgs(process.env.AETHER_DSH_ARGS || "--profile acp").split(" ").filter(Boolean),
    env: {
      ...(process.env.AETHER_DSH_HOME || process.env.DSH_HOME
        ? { DSH_HOME: process.env.AETHER_DSH_HOME || process.env.DSH_HOME }
        : {}),
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "",
    },
    cwd,
    log: (line) => process.stderr.write(`${line}\n`),
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      return;
    }
    const id = asString(frame.id);
    const type = asString(frame.type);
    const payload = asObject(frame.payload);
    try {
      switch (type) {
        case "ping":
          writeResponse(id, {
            bridge_version: BRIDGE_VERSION,
            runtime: "dsh",
            node_version: process.version,
          });
          return;
        case "list_providers":
          writeResponse(id, await runtime.providerCatalog());
          return;
        case "set_model_config":
          writeResponse(id, { ok: true });
          return;
        case "run_turn":
          writeResponse(id, await runtime.runTurn(id, payload));
          return;
        case "abort": {
          const sessionId = asString(payload.session_id);
          const entry = runtime.sessions.get(sessionId);
          if (entry) await runtime.client?.cancel(entry.acpSessionId);
          writeResponse(id, { aborted: Boolean(entry) });
          return;
        }
        case "close_session": {
          const sessionId = asString(payload.session_id);
          const entry = runtime.sessions.get(sessionId);
          if (entry) {
            await runtime.client?.closeSession(entry.acpSessionId).catch(() => {});
            runtime.sessions.delete(sessionId);
          }
          writeResponse(id, { closed: Boolean(entry), session_id: sessionId });
          return;
        }
        case "get_session_state": {
          const sessionId = asString(payload.session_id);
          const entry = runtime.sessions.get(sessionId);
          writeResponse(id, {
            session_id: sessionId,
            session_file: "",
            messages: [],
            runtime: "dsh",
            cwd: cwd,
            active: Boolean(entry),
          });
          return;
        }
        case "list_extensions":
          writeResponse(id, {
            session_id: asString(payload.session_id),
            workspace_directory: cwd,
            extension_paths: [],
            discovered_paths: [],
            errors: [],
            tools: [],
            commands: [],
            pending_reload: false,
            ui_mode: "rpc",
            custom_tui_supported: false,
          });
          return;
        case "list_extension_packages":
          writeResponse(id, { packages: [] });
          return;
        case "dsh_host_info":
          writeResponse(id, dshHostInfo({
            dshHome: process.env.AETHER_DSH_HOME || process.env.DSH_HOME || "",
            profile: asString(payload.profile) || "web",
            mountPath: process.env.AETHER_MOUNT_PATH || "",
          }));
          return;
        case "dsh_plugins_list":
          writeResponse(id, readProfilePatch({
            dshHome: process.env.AETHER_DSH_HOME || process.env.DSH_HOME || "",
            profile: asString(payload.profile) || "web",
          }));
          return;
        case "dsh_plugin_set_enabled":
          writeResponse(id, setProfilePluginEnabled({
            dshHome: process.env.AETHER_DSH_HOME || process.env.DSH_HOME || "",
            profile: asString(payload.profile) || "web",
            id: asString(payload.id),
            enabled: payload.enabled === true,
          }));
          return;
        case "list_discovered_skills":
          writeResponse(id, { skills: [] });
          return;
        case "get_aether_extensions":
          writeResponse(id, { extensions: [], version: 1 });
          return;
        default:
          writeError(id, `Method "${type}" is not supported by the DeepSeek Harness runtime.`, "unsupported_method");
          return;
      }
    } catch (error) {
      writeError(id, error?.message ?? String(error));
    }
  });
  rl.on("close", () => {
    runtime.client?.dispose();
    process.exit(0);
  });
}

main().catch((error) => {
  process.stderr.write(`dsh-bridge fatal: ${error?.stack ?? error}\n`);
  process.exit(1);
});
