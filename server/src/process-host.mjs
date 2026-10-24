import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const MAX_PROCESSES_PER_WORKSPACE = 8;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Long-lived child processes owned by one workspace, with stdin/stdout piped
 * back to the client that started them.
 *
 * The app needs this for anything that speaks a stream protocol with the agent
 * host — the extension bridge, MCP servers, and the interactive terminal — the
 * same way it would use a local `Process` on the phone.
 */
export class ProcessHost {
  constructor({ workspace, log = () => {} }) {
    this.workspace = workspace;
    this.log = log;
    this.processes = new Map();
  }

  get count() {
    return this.processes.size;
  }

  start(payload, { ownerId, onOutput, onExit } = {}) {
    if (this.processes.size >= MAX_PROCESSES_PER_WORKSPACE) {
      const error = new Error(
        `Too many running processes in this workspace (${MAX_PROCESSES_PER_WORKSPACE}).`,
      );
      error.code = "too_many_processes";
      throw error;
    }
    const command = typeof payload.command === "string" ? payload.command.trim() : "";
    if (!command) {
      const error = new Error("A command is required.");
      error.code = "invalid_command";
      throw error;
    }
    const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : this.workspace.workspace;
    const environment = {
      ...process.env,
      HOME: this.workspace.home,
      AETHER_WORKSPACE: this.workspace.workspace,
      AETHER_SERVER_MODE: "1",
      XDG_CONFIG_HOME: path.join(this.workspace.home, ".config"),
      XDG_CACHE_HOME: path.join(this.workspace.home, ".cache"),
      XDG_DATA_HOME: path.join(this.workspace.home, ".local", "share"),
      ...(payload.env && typeof payload.env === "object" ? payload.env : {}),
    };
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    const processId = `proc_${randomUUID().slice(0, 8)}`;
    const record = {
      id: processId,
      child,
      ownerId: ownerId ?? "",
      command,
      cwd,
      startedAt: Date.now(),
      buffered: 0,
      exitCode: null,
    };
    this.processes.set(processId, record);

    const forward = (stream) => (chunk) => {
      record.buffered += chunk.length;
      if (record.buffered > MAX_BUFFERED_BYTES) {
        // The client stopped reading: stop buffering instead of growing without
        // bound, and let the process feel the backpressure on stdin.
        return;
      }
      onOutput?.({
        process_id: processId,
        stream,
        data_base64: chunk.toString("base64"),
      });
    };
    child.stdout.on("data", forward("stdout"));
    child.stderr.on("data", forward("stderr"));
    child.on("error", (error) => {
      this.log("warn", "process.spawn_error", { processId, error: String(error) });
      this.#finish(record, -1, null, onExit);
    });
    child.on("exit", (code, signal) => {
      this.#finish(record, code ?? -1, signal, onExit);
    });
    this.log("info", "process.started", {
      workspace: this.workspace.id,
      processId,
      pid: child.pid,
      command,
    });
    return { process_id: processId, pid: child.pid ?? 0, cwd, command };
  }

  #finish(record, exitCode, signal, onExit) {
    record.exitCode = exitCode;
    record.buffered = 0;
    this.processes.delete(record.id);
    this.log("info", "process.exited", {
      workspace: this.workspace.id,
      processId: record.id,
      exitCode,
      signal,
    });
    onExit?.({ process_id: record.id, exit_code: exitCode, signal: signal ?? null });
  }

  writeStdin(processId, dataBase64) {
    const record = this.#require(processId);
    record.buffered = 0;
    const buffer = Buffer.from(dataBase64, "base64");
    record.child.stdin.write(buffer);
    return { process_id: processId, bytes: buffer.length };
  }

  closeStdin(processId) {
    const record = this.#require(processId);
    record.child.stdin.end();
    return { process_id: processId };
  }

  signal(processId, signal = "SIGTERM") {
    const record = this.#require(processId);
    const allowed = new Set(["SIGTERM", "SIGKILL", "SIGINT"]);
    record.child.kill(allowed.has(signal) ? signal : "SIGTERM");
    return { process_id: processId, signal };
  }

  list() {
    return [...this.processes.values()].map((record) => ({
      process_id: record.id,
      command: record.command,
      cwd: record.cwd,
      pid: record.child.pid ?? 0,
      started_at: record.startedAt,
    }));
  }

  #require(processId) {
    const record = this.processes.get(processId);
    if (!record) {
      const error = new Error(`Unknown process: ${processId}`);
      error.code = "unknown_process";
      throw error;
    }
    return record;
  }

  killAll() {
    for (const record of this.processes.values()) {
      try {
        record.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    this.processes.clear();
  }
}
