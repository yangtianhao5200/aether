import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readComposedProfile } from "../src/dsh-host.mjs";

const COMPOSED = `- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js '!ctx.get(''profileContext'')'
- id: llm
  name: '@deepseek-ai/dsh-llm'
- insert:
    - id: nested
      name: '@x/y'
      disabled: true
`;
const PATCH = `- id: llm
  name: '@deepseek-ai/dsh-llm'
  disabled: true
- id: extra
  name: '@a/extra'
`;

async function withHome(run) {
  const home = await mkdtemp(path.join(tmpdir(), "dsh-composed-"));
  try {
    await mkdir(path.join(home, "profiles", "web"), { recursive: true });
    await writeFile(path.join(home, "profiles", "web", "cordis.yml"), COMPOSED, "utf8");
    await writeFile(path.join(home, "profiles", "web", "cordis.patch.yml"), PATCH, "utf8");
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("composed profile lists bundle plugins plus patch rows", async () => {
  await withHome(async (home) => {
    const result = readComposedProfile({ dshHome: home, profile: "web" });
    const byId = Object.fromEntries(result.plugins.map((p) => [p.id, p]));
    assert.ok(byId.timer);
    assert.equal(byId.timer.enabled, true);
    // !!js condition is reported as conditional, not resolved.
    assert.equal(byId.hmr.conditional, true);
    // The patch disables `llm`.
    assert.equal(byId.llm.patch, true);
    assert.equal(byId.llm.enabled, false);
    // An inserted plugin is flattened into the list.
    assert.equal(byId.nested.enabled, false);
    // A patch-only plugin is appended as inserted.
    assert.ok(result.plugins.some((p) => p.id === "extra" && p.inserted === true));
  });
});

test("composed profile errors when the profile is missing", async () => {
  await withHome(async (home) => {
    assert.throws(
      () => readComposedProfile({ dshHome: path.join(home, "nope"), profile: "web" }),
      (error) => error.code === "dsh_profile_missing",
    );
  });
});
