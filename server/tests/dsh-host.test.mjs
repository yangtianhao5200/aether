import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  dshHostInfo,
  profilePatchPath,
  readProfilePatch,
  setProfilePluginEnabled,
} from "../src/dsh-host.mjs";

const PATCH = `- id: llm-pi-ai
  config:
    providers:
      inside:
        apiKeyEnv: INSIDE_API_KEY
        api: openai-completions
        baseURL: https://freeshare.cc.cd/v1
        models:
          - id: deepseek-v4.1-flash
            name: deepseek-v4.1-flash
            contextWindow: 1000000
- id: agent-default-model
  config:
    provider: inside
    model: deepseek-v4.1-flash
- insert:
    - id: aether-remote-server
      name: '@aether/remote-server/dsh'
      config:
        mountPath: /aether
        runtime: dsh
        tokens:
          - token: only-on-this-host
            user: default
`;

async function withProfile(run) {
  const home = await mkdtemp(path.join(tmpdir(), "dsh-home-"));
  const dir = path.join(home, "profiles", "web");
  await writeFile(path.join(dir, "cordis.patch.yml"), PATCH, "utf8").catch(async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
    await writeFile(path.join(dir, "cordis.patch.yml"), PATCH, "utf8");
  });
  try {
    await run({ home, profile: "web", file: profilePatchPath(home, "web") });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("reads plugins, providers and models out of the harness profile patch", async () => {
  await withProfile(async ({ home, file }) => {
    const result = readProfilePatch({ dshHome: home, profile: "web" });
    assert.equal(result.file, file);
    const ids = result.plugins.map((plugin) => plugin.id);
    assert.deepEqual(ids, ["llm-pi-ai", "agent-default-model", "aether-remote-server"]);
    assert.equal(result.plugins.every((plugin) => plugin.enabled), true);

    const inside = result.providers.find((provider) => provider.id === "inside");
    assert.ok(inside, "inside provider");
    assert.equal(inside.base_url, "https://freeshare.cc.cd/v1");
    assert.equal(inside.api_key_env, "INSIDE_API_KEY");
    assert.deepEqual(inside.models.map((model) => model.id), ["deepseek-v4.1-flash"]);
    assert.equal(result.providers.length, 1);
  });
});

test("disabling a plugin writes a backup and keeps the rest intact", async () => {
  await withProfile(async ({ home, file }) => {
    const toggled = setProfilePluginEnabled({ dshHome: home, profile: "web", id: "agent-default-model", enabled: false });
    assert.equal(toggled.enabled, false);
    assert.match(toggled.backup, /cordis\.patch\.yml\.bak-/);

    const after = readProfilePatch({ dshHome: home, profile: "web" });
    const agent = after.plugins.find((plugin) => plugin.id === "agent-default-model");
    const llm = after.plugins.find((plugin) => plugin.id === "llm-pi-ai");
    assert.equal(agent.enabled, false);
    assert.equal(llm.enabled, true);
    // Providers survive the rewrite.
    assert.equal(after.providers.length, 1);

    const again = setProfilePluginEnabled({ dshHome: home, profile: "web", id: "agent-default-model", enabled: true });
    assert.equal(again.enabled, true);
    const restored = readProfilePatch({ dshHome: home, profile: "web" });
    assert.equal(restored.plugins.find((plugin) => plugin.id === "agent-default-model").enabled, true);
  });
});

test("toggling an unknown plugin reports a clear error", async () => {
  await withProfile(async ({ home }) => {
    assert.throws(
      () => setProfilePluginEnabled({ dshHome: home, profile: "web", id: "nope", enabled: false }),
      (error) => error.code === "dsh_plugin_not_found",
    );
  });
});

test("host info reports the harness home and profile", async () => {
  const info = dshHostInfo({ dshHome: "/home/dsh/.dsh", profile: "web", mountPath: "/aether" });
  assert.equal(info.runtime, "dsh");
  assert.equal(info.dsh_home, "/home/dsh/.dsh");
  assert.equal(info.profile, "web");
  assert.equal(info.mount_path, "/aether");
  assert.equal(typeof info.dsh_version, "string");
});
