import * as fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_TEXT = 2_000;
const BINARY_KEYS = new Set([
  "data_base64",
  "screenshot_base64",
  "bytes_base64",
  "image_base64",
  "input_base64",
]);
const OMITTED_PREFIX = "__aether_omitted__";

/**
 * Append-only, per-workspace activity journal.
 *
 * Every frame that crosses the bridge is recorded so the "work content" the
 * agent produces survives a disconnected phone, can be replayed to a second
 * device or a browser dashboard, and can be shipped to an external sink.
 *
 * Large binary payloads (screenshots, image chunks) are replaced by a size
 * marker: the journal is a narrative log, not a blob store.
 */
export class Journal {
  constructor({ directory, log = () => {}, maxFileBytes = 64 * 1024 * 1024, webhookUrl = "" }) {
    this.directory = directory;
    this.log = log;
    this.maxFileBytes = maxFileBytes;
    this.webhookUrl = webhookUrl;
    this.writeChain = Promise.resolve();
    this.recent = [];
    this.recentLimit = 500;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true });
  }

  filePathFor(date = new Date()) {
    return path.join(this.directory, `${date.toISOString().slice(0, 10)}.jsonl`);
  }

  /**
   * Record one protocol frame.
   * @param {"in"|"out"|"server"} direction
   */
  append(direction, frame, { clientId = "", kind } = {}) {
    const record = {
      ts: Date.now(),
      dir: direction,
      kind: kind ?? inferKind(frame),
      id: typeof frame?.id === "string" ? frame.id : "",
      type: typeof frame?.type === "string" ? frame.type : "",
      event: typeof frame?.event === "string" ? frame.event : "",
      session_id: sessionIdOf(frame),
      client: clientId,
      payload: summarize(frame?.payload ?? frame?.error ?? frame?.result),
    };
    this.recent.push(record);
    if (this.recent.length > this.recentLimit) this.recent.shift();
    this.writeChain = this.writeChain
      .then(() => this.#write(record))
      .catch((error) => this.log("warn", "journal.write_failed", { error: String(error) }));
    return record;
  }

  async #write(record) {
    const file = this.filePathFor(new Date(record.ts));
    const line = `${JSON.stringify(record)}\n`;
    await fs.appendFile(file, line, "utf8");
    await this.#rotateIfNeeded(file);
    this.#forward(record, line);
  }

  async #rotateIfNeeded(file) {
    const stats = await fs.stat(file).catch(() => null);
    if (!stats || stats.size <= this.maxFileBytes) return;
    const archive = `${file}.${stats.size}`;
    await fs.rename(file, archive).catch(() => {});
    this.log("info", "journal.rotated", { file: path.basename(archive) });
  }

  #forward(record, line) {
    if (!this.webhookUrl) return;
    // Fire-and-forget: a broken sink must never stall agent output.
    fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: line,
    }).catch((error) => this.log("warn", "journal.webhook_failed", { error: String(error) }));
  }

  /** Replay buffered records newer than `since` (epoch ms). */
  since(since, limit = 200) {
    return this.recent.filter((record) => record.ts > since).slice(-limit);
  }

  async read({ sessionId = "", limit = 200, since = 0 } = {}) {
    const files = (await fs.readdir(this.directory).catch(() => []))
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .slice(-2);
    const records = [];
    for (const name of files) {
      const content = await fs.readFile(path.join(this.directory, name), "utf8").catch(() => "");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (since && record.ts <= since) continue;
          if (sessionId && record.session_id !== sessionId) continue;
          records.push(record);
        } catch {
          // ignore torn writes
        }
      }
    }
    return records.slice(-Math.max(1, Math.min(limit, 5_000)));
  }

  async flush() {
    await this.writeChain.catch(() => {});
  }
}

function inferKind(frame) {
  if (frame?.type === "event") return "event";
  if (frame?.type === "response") return "response";
  if (frame?.type === "error") return "error";
  if (typeof frame?.type === "string") return "request";
  return "unknown";
}

function sessionIdOf(frame) {
  const payload = frame?.payload;
  if (payload && typeof payload === "object") {
    if (typeof payload.session_id === "string") return payload.session_id;
    if (typeof payload.request_id === "string") return "";
  }
  return "";
}

/** Shrink a payload so the journal stays readable and cheap. */
export function summarize(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return value.length <= DEFAULT_MAX_TEXT
      ? value
      : `${value.slice(0, DEFAULT_MAX_TEXT)}…${OMITTED_PREFIX}${value.length}`;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 50).map((item) => summarize(item, depth + 1));
    return value.length > 50 ? [...head, `${OMITTED_PREFIX}${value.length - 50} more`] : head;
  }
  if (depth > 6) return `${OMITTED_PREFIX}depth`;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (BINARY_KEYS.has(key) && typeof entry === "string") {
      output[key] = `${OMITTED_PREFIX}${entry.length}`;
      continue;
    }
    output[key] = summarize(entry, depth + 1);
  }
  return output;
}
