import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { BridgeHost } from "../src/bridge-host.mjs";

/**
 * A bridge killed from the outside must not look alive: `exitCode` stays null
 * when a process dies from a signal, so checking only `exitCode` wedges the
 * supervisor — the agent then silently stops answering turns.
 */
test("a bridge killed by a signal is not reported as running", async () => {
  const host = new BridgeHost({
    workspace: { id: "test", home: "/tmp", workspace: "/tmp" },
    bridgePath: "/nonexistent/bridge.mjs",
    nodePath: process.execPath,
    log: () => {},
  });

  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  host.child = child;
  assert.equal(host.running, true);

  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;

  assert.equal(host.running, false);
  host.stopping = true;
  host.child = null;
});

test("a bridge that exited normally is not reported as running", async () => {
  const host = new BridgeHost({
    workspace: { id: "test", home: "/tmp", workspace: "/tmp" },
    bridgePath: "/nonexistent/bridge.mjs",
    nodePath: process.execPath,
    log: () => {},
  });

  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  host.child = child;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await exited;

  assert.equal(host.running, false);
  host.stopping = true;
  host.child = null;
});
