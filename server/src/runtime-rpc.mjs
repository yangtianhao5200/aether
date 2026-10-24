import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

const MAX_READ_BYTES = 32 * 1024 * 1024;
const MAX_WRITE_BYTES = 64 * 1024 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_TIMEOUT_MS = 30 * 60_000;

export class FileOperationError extends Error {
  constructor(message, code = "fs_error") {
    super(message);
    this.code = code;
  }
}

/**
 * Remote filesystem + process execution for the client UI.
 *
 * The agent itself never uses this: its tools run inside the bridge process on
 * the same filesystem. This surface exists so the phone can browse the remote
 * workspace, attach files, preview images and open a shell — everything the app
 * normally does against its local Alpine VM.
 */
export class RuntimeRpc {
  constructor({ workspaceStore, log = () => {} }) {
    this.workspaceStore = workspaceStore;
    this.log = log;
  }

  async handle(workspace, payload) {
    const operation = String(payload?.op ?? "").trim();
    switch (operation) {
      case "stat":
        return this.#stat(workspace, payload);
      case "list":
        return this.#list(workspace, payload);
      case "tree":
        return this.#tree(workspace, payload);
      case "read":
        return this.#read(workspace, payload);
      case "write":
        return this.#write(workspace, payload, { append: false });
      case "append":
        return this.#write(workspace, payload, { append: true });
      case "mkdir":
        return this.#mkdir(workspace, payload);
      case "remove":
        return this.#remove(workspace, payload);
      case "move":
        return this.#move(workspace, payload);
      case "copy":
        return this.#copy(workspace, payload);
      case "exists":
        return this.#exists(workspace, payload);
      case "chmod":
        return this.#chmod(workspace, payload);
      case "glob":
        return this.#glob(workspace, payload);
      case "info":
        return {
          home_directory: workspace.home,
          workspace_root: workspace.workspace,
          agent_directory: workspace.agentDirectory,
          platform: process.platform,
          arch: process.arch,
          node_version: process.version,
        };
      default:
        throw new FileOperationError(`Unsupported file operation: ${operation}`, "unsupported_operation");
    }
  }

  async #stat(workspace, payload) {
    const target = await this.workspaceStore.resolve(workspace, payload.path, { mustExist: true });
    const stats = await fs.lstat(target);
    return {
      path: target,
      name: path.basename(target),
      is_directory: stats.isDirectory(),
      is_symbolic_link: stats.isSymbolicLink(),
      size: stats.size,
      modified_at_millis: Math.floor(stats.mtimeMs),
      mode: stats.mode & 0o777,
    };
  }

  async #list(workspace, payload) {
    const directory = await this.workspaceStore.resolve(workspace, payload.path ?? ".", { mustExist: true });
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const detailed = await Promise.all(
      entries.map(async (entry) => {
        const absolute = path.join(directory, entry.name);
        const stats = await fs.lstat(absolute).catch(() => null);
        return {
          name: entry.name,
          path: absolute,
          is_directory: entry.isDirectory(),
          is_symbolic_link: entry.isSymbolicLink(),
          size: stats?.size ?? 0,
          modified_at_millis: stats ? Math.floor(stats.mtimeMs) : 0,
        };
      }),
    );
    detailed.sort((left, right) => {
      if (left.is_directory !== right.is_directory) return left.is_directory ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return { path: directory, entries: detailed };
  }

  async #tree(workspace, payload) {
    const root = await this.workspaceStore.resolve(workspace, payload.path ?? ".", { mustExist: true });
    const depth = Math.max(0, Math.min(Number(payload.depth ?? 2), 6));
    const limit = Math.max(1, Math.min(Number(payload.limit ?? 500), 5_000));
    const output = [];
    const walk = async (directory, level) => {
      if (output.length >= limit) return;
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (output.length >= limit) return;
        const absolute = path.join(directory, entry.name);
        output.push({
          name: entry.name,
          path: absolute,
          is_directory: entry.isDirectory(),
          depth: level,
        });
        if (entry.isDirectory() && level < depth) await walk(absolute, level + 1);
      }
    };
    await walk(root, 0);
    return { path: root, entries: output, truncated: output.length >= limit };
  }

  async #read(workspace, payload) {
    const target = await this.workspaceStore.resolve(workspace, payload.path, { mustExist: true });
    const stats = await fs.stat(target);
    if (stats.isDirectory()) throw new FileOperationError("Cannot read a directory.", "is_directory");
    const requested = Number(payload.max_bytes ?? MAX_READ_BYTES);
    const maximum = Math.max(0, Math.min(requested, MAX_READ_BYTES));
    if (payload.prefix === true) {
      // Callers that only need a head (log tails, previews) must not fail on
      // large files.
      const handle = await fs.open(target, "r");
      try {
        const buffer = Buffer.alloc(Math.min(stats.size, maximum));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const head = buffer.subarray(0, bytesRead);
        const encoding = String(payload.encoding ?? "base64");
        return encoding === "utf8"
          ? { path: target, size: stats.size, truncated: stats.size > bytesRead, text: head.toString("utf8") }
          : {
              path: target,
              size: stats.size,
              truncated: stats.size > bytesRead,
              data_base64: head.toString("base64"),
            };
      } finally {
        await handle.close();
      }
    }
    if (stats.size > maximum) {
      throw new FileOperationError(
        `File is ${stats.size} bytes, larger than the ${maximum} byte limit.`,
        "file_too_large",
      );
    }
    const buffer = await fs.readFile(target);
    const encoding = String(payload.encoding ?? "base64");
    if (encoding === "utf8") {
      return { path: target, size: buffer.length, text: buffer.toString("utf8") };
    }
    return { path: target, size: buffer.length, data_base64: buffer.toString("base64") };
  }

  async #write(workspace, payload, { append }) {
    const target = await this.workspaceStore.resolve(workspace, payload.path);
    const base64 = typeof payload.data_base64 === "string" ? payload.data_base64 : "";
    const text = typeof payload.text === "string" ? payload.text : "";
    const buffer = base64 ? Buffer.from(base64, "base64") : Buffer.from(text, "utf8");
    if (buffer.length > MAX_WRITE_BYTES) {
      throw new FileOperationError(
        `Refusing to write ${buffer.length} bytes (limit ${MAX_WRITE_BYTES}).`,
        "file_too_large",
      );
    }
    if (payload.create_parents !== false) {
      await fs.mkdir(path.dirname(target), { recursive: true });
    }
    if (append) await fs.appendFile(target, buffer);
    else await fs.writeFile(target, buffer);
    if (payload.executable === true) await fs.chmod(target, 0o755);
    return { path: target, bytes_written: buffer.length };
  }

  async #mkdir(workspace, payload) {
    const target = await this.workspaceStore.resolve(workspace, payload.path);
    await fs.mkdir(target, { recursive: payload.recursive !== false });
    return { path: target };
  }

  async #remove(workspace, payload) {
    const target = await this.workspaceStore.resolve(workspace, payload.path, { mustExist: true });
    if (target === workspace.home || target === workspace.workspace) {
      throw new FileOperationError("Refusing to remove a workspace root.", "invalid_target");
    }
    await fs.rm(target, { recursive: payload.recursive === true, force: false });
    return { path: target };
  }

  async #move(workspace, payload) {
    const source = await this.workspaceStore.resolve(workspace, payload.from, { mustExist: true });
    const destination = await this.workspaceStore.resolve(workspace, payload.to);
    if (payload.create_parents !== false) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
    }
    if (payload.overwrite !== true) {
      const exists = await fs.access(destination).then(() => true, () => false);
      if (exists) throw new FileOperationError(`Destination already exists: ${destination}`, "exists");
    }
    await fs.rename(source, destination);
    return { from: source, to: destination };
  }

  async #copy(workspace, payload) {
    const source = await this.workspaceStore.resolve(workspace, payload.from, { mustExist: true });
    const destination = await this.workspaceStore.resolve(workspace, payload.to);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: payload.overwrite === true });
    return { from: source, to: destination };
  }

  async #exists(workspace, payload) {
    try {
      const target = await this.workspaceStore.resolve(workspace, payload.path);
      const exists = await fs.access(target).then(() => true, () => false);
      return { path: target, exists };
    } catch (error) {
      if (error?.code === "path_outside_workspace") return { path: String(payload.path ?? ""), exists: false };
      throw error;
    }
  }

  async #chmod(workspace, payload) {
    const target = await this.workspaceStore.resolve(workspace, payload.path, { mustExist: true });
    const mode = Number(payload.mode ?? (payload.executable ? 0o755 : 0o644));
    await fs.chmod(target, mode);
    return { path: target, mode };
  }

  async #glob(workspace, payload) {
    const root = await this.workspaceStore.resolve(workspace, payload.path ?? ".", { mustExist: true });
    const pattern = String(payload.pattern ?? "*");
    const limit = Math.max(1, Math.min(Number(payload.limit ?? 500), 5_000));
    const matcher = globToRegExp(pattern);
    const matches = [];
    const walk = async (directory, relative) => {
      if (matches.length >= limit) return;
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (matches.length >= limit) return;
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(directory, entry.name), childRelative);
        } else if (matcher.test(childRelative)) {
          matches.push({ path: path.join(directory, entry.name), relative_path: childRelative });
        }
      }
    };
    await walk(root, "");
    return { path: root, pattern, matches, truncated: matches.length >= limit };
  }

  /**
   * Run a command on the server, streaming output through `onOutput`.
   * Resolves with the exit code and a bounded copy of both streams.
   */
  async execute(workspace, payload, { onOutput = () => {}, signal } = {}) {
    const command = String(payload?.command ?? "");
    if (!command.trim()) throw new FileOperationError("command is required.", "invalid_arguments");
    const cwd = payload.cwd
      ? await this.workspaceStore.resolve(workspace, payload.cwd)
      : workspace.workspace;
    const timeoutMs = Math.max(
      1_000,
      Math.min(Number(payload.timeout_ms ?? DEFAULT_EXEC_TIMEOUT_MS), MAX_EXEC_TIMEOUT_MS),
    );
    const environment = {
      ...process.env,
      HOME: workspace.home,
      AETHER_WORKSPACE: workspace.workspace,
      ...(payload.env && typeof payload.env === "object" ? payload.env : {}),
    };

    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let bytesEmitted = 0;
    let timedOut = false;
    let sequence = 0;

    const collect = (stream, chunk) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") {
        if (stdout.length < MAX_EXEC_OUTPUT_BYTES) stdout += text;
      } else if (stderr.length < MAX_EXEC_OUTPUT_BYTES) {
        stderr += text;
      }
      bytesEmitted += chunk.length;
      if (bytesEmitted <= MAX_EXEC_OUTPUT_BYTES) {
        onOutput({ stream, sequence: sequence++, data_base64: chunk.toString("base64") });
      }
    };

    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const exitCode = await new Promise((resolve) => {
      child.on("close", (code) => resolve(code ?? -1));
      child.on("error", () => resolve(-1));
    });
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);

    return { exit_code: exitCode, stdout, stderr, timed_out: timedOut, cwd };
  }
}

function globToRegExp(pattern) {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else if (character === ".") source += "\\.";
    else if ("+()^$|{}[]\\".includes(character)) source += `\\${character}`;
    else source += character;
  }
  return new RegExp(`${source}$`);
}
