import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAcpPatch, webDefaultModel, webProviderRoutes } from "../src/dsh-bridge/acp-patch.mjs";

const WEB_PATCH = `- id: llm-pi-ai
  config:
    providers:
      catwork:
        apiKeyEnv: OPENAI_API_KEY
        api: openai-completions
        baseURL: http://gateway.example/v1
        models:
          - id: minimax-m3.1-flash
- id: agent-default-model
  config:
    provider: catwork
    model: minimax-m3.1-flash
`;

const ACP_PATCH = `- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
- id: acp
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
`;

async function withHome(run) {
  const home = await mkdtemp(path.join(tmpdir(), "dsh-acp-home-"));
  try {
    await mkdir(path.join(home, "profiles", "web"), { recursive: true });
    await writeFile(path.join(home, "profiles", "web", "cordis.patch.yml"), WEB_PATCH, "utf8");
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("the host's provider routes are read from the web profile", async () => {
  await withHome(async (home) => {
    const routes = webProviderRoutes({ dshHome: home, profile: "web" });
    assert.deepEqual(Object.keys(routes), ["catwork"]);
    assert.equal(routes.catwork.apiKeyEnv, "OPENAI_API_KEY");
    assert.deepEqual(webDefaultModel({ dshHome: home, profile: "web" }), {
      provider: "catwork",
      model: "minimax-m3.1-flash",
    });
  });
});

test("the ACP patch carries the host's routes and default model", async () => {
  await withHome(async (home) => {
    const patchPath = path.join(home, "acp.yml");
    await writeFile(patchPath, ACP_PATCH, "utf8");
    const outPath = path.join(home, "generated.yml");

    const result = buildAcpPatch({ dshHome: home, profile: "web", patchPath, outPath });

    assert.deepEqual(result.routes, ["catwork"]);
    assert.equal(result.providersFromHost, true);
    assert.deepEqual(result.defaultModel, { provider: "catwork", model: "minimax-m3.1-flash" });

    const generated = await readFile(outPath, "utf8");
    assert.match(generated, /catwork:/);
    assert.match(generated, /apiKeyEnv: OPENAI_API_KEY/);
    // The default model follows the host, so the agent starts on a route the
    // host actually has.
    assert.doesNotMatch(generated, /provider: deepseek-official/);
  });
});

test("a missing web profile keeps the configured patch untouched", async () => {
  await withHome(async (home) => {
    const patchPath = path.join(home, "acp.yml");
    await writeFile(patchPath, ACP_PATCH, "utf8");
    const outPath = path.join(home, "generated.yml");

    const result = buildAcpPatch({
      dshHome: path.join(home, "empty"),
      profile: "web",
      patchPath,
      outPath,
    });

    assert.deepEqual(result.routes, []);
    assert.equal(result.providersFromHost, false);
    assert.equal(result.defaultModel, null);
    const generated = await readFile(outPath, "utf8");
    assert.match(generated, /provider: deepseek-official/);
  });
});
