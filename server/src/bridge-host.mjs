import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const STDERR_RING_LINES = 200;
const START_TIMEOUT_MS = 60_000;
const MAX_RESTART_ATTEMPTS = 5;
export const STARTUP_PING_ID = "aether-server-startup-ping";

/**
 * Owns one `bridge.mjs` child process for one workspace.
 *
 * The bridge protocol is newline-delimited JSON on stdin/stdout, so this class
 * is a faithful relay: every frame it reads is emitted unchanged, which keeps
 * the app's protocol (and its tests) identical to the on-device bridge.
 *
 * Events:
 *   frame  (frame)            parsed bridge frame
 *   stderr (chunk: string)
 *   status (status)           lifecycle changes
 *   exit   ({code, signal})
 */
export class BridgeHost extends EventEmitter {
  constructor({ workspace, bridgePath, nodePath = process.execPath, extraEnv = {}, log = () => {} }) {
    super();
    this.workspace = workspace;
    this.bridgePath = bridgePath;
    this.nodePath = nodePath;
    this.extraEnv = extraEnv;
    this.log = log;
    this.child = null;
    this.starting = null;
    this.restarts = 0;
    this.startedAt = 0;
    this.lastExit = null;
    this.stderrLines = [];
    this.stopping = false;
    this.idleTimer = null;
    this.lastActivityAt = Date.now();
    this.readyInfo = null;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  status() {
    return {
      workspace: this.workspace.id,
      running: this.running,
      pid: this.child?.pid ?? 0,
      started_at: this.startedAt,
      restarts: this.restarts,
      last_exit: this.lastExit,
      bridge_info: this.readyInfo,
      stderr_tail: this.stderrLines.slice(-20),
    };
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  async ensureStarted() {
    if (this.running) return this.status();
    if (this.starting) {
      await this.starting;
      return this.status();
    }
    this.starting = this.#start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    return this.status();
  }

  async #start() {
    await fs.access(this.bridgePath).catch(() => {
      throw new Error(
        `Pi bridge bundle not found at ${this.bridgePath}. Build it with "npm run build" in pi-bridge/.`,
      );
    });

    const environment = {
      ...process.env,
      HOME: this.workspace.home,
      AETHER_WORKSPACE: this.workspace.workspace,
      AETHER_SERVER_MODE: "1",
      AETHER_WORKSPACE_ID: this.workspace.id,
      NODE_COMPILE_CACHE: path.join(this.workspace.home, ".aether", "node-compile-cache"),
      XDG_CONFIG_HOME: path.join(this.workspace.home, ".config"),
      XDG_CACHE_HOME: path.join(this.workspace.home, ".cache"),
      XDG_DATA_HOME: path.join(this.workspace.home, ".local", "share"),
      AETHER_WORKSPACE_DIR: this.workspace.workspace,
      ...this.extraEnv,
    };

    const child = spawn(this.nodePath, [this.bridgePath], {
      cwd: path.dirname(this.bridgePath),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.startedAt = Date.now();
    this.readyInfo = null;

    let settleReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      settleReady = resolve;
      rejectReady = reject;
    });

    // A single reader owns stdout: a second readline interface would compete
    // for the same stream and silently drop frames.
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.touch();
      let frame;
      try {
        frame = JSON.parse(trimmed);
      } catch (error) {
        this.log("warn", "bridge.malformed_frame", {
          error: String(error),
          line: trimmed.slice(0, 400),
        });
        return;
      }
      if (frame?.type === "response" && frame.id === STARTUP_PING_ID) {
        this.readyInfo = frame.payload ?? null;
        settleReady(frame.payload ?? null);
        return;
      }
      this.emit("frame", frame);
    });

    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => {
      if (!line.trim()) return;
      this.stderrLines.push(line);
      if (this.stderrLines.length > STDERR_RING_LINES) this.stderrLines.shift();
      this.emit("stderr", line);
    });

    child.on("error", (error) => {
      this.log("error", "bridge.spawn_failed", {
        workspace: this.workspace.id,
        error: String(error),
      });
      rejectReady(error);
    });
    child.on("exit", (code, signal) => {
      this.lastExit = { code, signal, at: Date.now() };
      rejectReady(new Error(`Pi bridge exited during startup with code ${code}.`));
      this.log(code === 0 ? "info" : "warn", "bridge.exit", {
        workspace: this.workspace.id,
        code,
        signal,
      });
      this.emit("exit", this.lastExit);
      this.emit("status", this.status());
      if (!this.stopping) this.#scheduleRestart();
    });

    child.stdin.write(`${JSON.stringify({ id: STARTUP_PING_ID, type: "ping", payload: {} })}\n`);

    const timer = setTimeout(() => {
      rejectReady(new Error(`Pi bridge did not answer within ${START_TIMEOUT_MS} ms.`));
    }, START_TIMEOUT_MS);
    timer.unref?.();

    try {
      await ready;
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    } finally {
      clearTimeout(timer);
    }

    this.log("info", "bridge.started", {
      workspace: this.workspace.id,
      pid: child.pid,
      bridge: this.bridgePath,
      version: this.readyInfo?.bridge_version,
    });
    this.emit("status", this.status());
    this.restarts = 0;
  }

  #scheduleRestart() {
    if (this.restarts >= MAX_RESTART_ATTEMPTS) {
      this.log("error", "bridge.restart_gave_up", {
        workspace: this.workspace.id,
        attempts: this.restarts,
      });
      return;
    }
    this.restarts += 1;
    const delay = Math.min(30_000, 500 * 2 ** (this.restarts - 1));
    this.log("warn", "bridge.restart_scheduled", {
      workspace: this.workspace.id,
      attempt: this.restarts,
      delay_ms: delay,
    });
    const timer = setTimeout(() => {
      this.ensureStarted().catch((error) => {
        this.log("error", "bridge.restart_failed", { error: String(error) });
      });
    }, delay);
    timer.unref?.();
  }

  send(frame) {
    if (!this.running) throw new Error("Pi bridge is not running.");
    this.touch();
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async stop({ force = false } = {}) {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // stdin already closed
    }
    const exited = await waitForExit(child, force ? 500 : 3_000);
    if (!exited) child.kill("SIGKILL");
    this.emit("status", this.status());
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}
