import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

/**
 * Read/write side of the DeepSeek Harness host that serves the agent.
 *
 * The phone app needs to show and steer a few host facts: which plugins the
 * profile mounts, which provider routes and models the agent can use, and
 * enabling/disabling a plugin. All of that lives in the profile's
 * `cordis.patch.yml`, so this module parses and rewrites that file (with a
 * timestamped backup) instead of pretending to have host shell access.
 *
 * The profile patch is YAML, parsed with the declared `js-yaml` dependency; no
 * host shell access is required, and every write keeps a timestamped backup.
 */

/**
 * Whether host management can work here. `js-yaml` is a declared dependency, so
 * this is normally true; it stays a runtime signal because the profile file
 * itself may also be missing.
 */
export function dshHostManagementAvailable() {
  return Boolean(yaml);
}

/** `$DSH_HOME/profiles/<name>/cordis.patch.yml` for the running harness home. */
export function profilePatchPath(dshHome = process.env.DSH_HOME || "/home/dsh/.dsh", profile = "web") {
  return path.join(dshHome, "profiles", profile, "cordis.patch.yml");
}

/** Map a `- id:`/`- insert:` patch into flat, app-friendly rows. */
function summarizeEntries(document, sourceKind) {
  const rows = [];
  const visit = (entries, viaInsert) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!id) continue;
      const values = viaInsert || sourceKind === "insert" ? entry : entry;
      rows.push({
        id,
        name: typeof entry.name === "string" ? entry.name : "",
        disabled: entry.disabled === true,
        inserted: Boolean(viaInsert),
        // Config is echoed for the app to display provider/route facts.
        config: values.config && typeof values.config === "object" ? values.config : {},
      });
    }
  };
  if (Array.isArray(document)) {
    for (const item of document) {
      if (item && typeof item === "object" && Array.isArray(item.insert)) visit(item.insert, true);
      else if (item && typeof item === "object") visit([item], false);
    }
  }
  return rows;
}

export function readProfilePatch({ dshHome, profile }) {
  const file = profilePatchPath(dshHome, profile);
    let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const wrapped = new Error(`No harness profile patch at ${file}.`);
      wrapped.code = "dsh_profile_missing";
      throw wrapped;
    }
    throw error;
  }
  const document = yaml.load(raw) ?? [];
  const entries = summarizeEntries(document);
  const providers = [];
  for (const entry of entries) {
    const config = entry.config ?? {};
    const providersConfig = config.providers;
    if (!providersConfig || typeof providersConfig !== "object") continue;
    for (const [routeId, route] of Object.entries(providersConfig)) {
      if (!route || typeof route !== "object") continue;
      providers.push({
        id: routeId,
        base_url: typeof route.baseURL === "string" ? route.baseURL : "",
        api_key_env: typeof route.apiKeyEnv === "string" ? route.apiKeyEnv : "",
        models: Array.isArray(route.models)
          ? route.models.map((model) =>
            model && typeof model === "object"
              ? {
                  id: String(model.id ?? ""),
                  name: String(model.name ?? model.id ?? ""),
                  context_window: Number(model.contextWindow ?? 0) || null,
                }
              : { id: String(model ?? ""), name: String(model ?? ""), context_window: null },
            )
          : [],
      });
    }
  }
  return {
    dsh_home: dshHome,
    profile,
    file,
    path_exists: true,
    plugins: entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      enabled: !entry.disabled,
      config_keys: Object.keys(entry.config ?? {}),
    })),
    providers,
  };
}

/** Flip one entry's `disabled` flag, keeping a backup of the previous file. */
export function setProfilePluginEnabled({ dshHome, profile, id, enabled }) {
  const file = profilePatchPath(dshHome, profile);
    const raw = fs.readFileSync(file, "utf8");
  const document = yaml.load(raw);
  if (!Array.isArray(document)) {
    const error = new Error("The harness profile patch is not a YAML list.");
    error.code = "dsh_profile_invalid";
    throw error;
  }
  let changed = false;
  for (const item of document) {
    if (!item || typeof item !== "object") continue;
    const matches = (entry) => entry && entry.id === id;
    if (matches(item)) {
      if (enabled) delete item.disabled;
      else item.disabled = true;
      changed = true;
    }
    if (Array.isArray(item.insert)) {
      for (const entry of item.insert) {
        if (matches(entry)) {
          if (enabled) delete entry.disabled;
          else entry.disabled = true;
          changed = true;
        }
      }
    }
  }
  if (!changed) {
    const error = new Error(`Plugin "${id}" is not in the profile patch.`);
    error.code = "dsh_plugin_not_found";
    throw error;
  }
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.writeFileSync(backup, raw, "utf8");
  fs.writeFileSync(file, yaml.dump(document, { lineWidth: 120, noRefs: true }), "utf8");
  return { id, enabled, file, backup };
}

export function dshHostInfo({ dshHome, profile = "web", mountPath = "" }) {
  let version = "";
  try {
    const pkg = JSON.parse(fs.readFileSync("/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json", "utf8"));
    version = pkg.version ?? "";
  } catch {
    // not installed / not this host
  }
  return {
    runtime: "dsh",
    dsh_home: dshHome,
    profile,
    mount_path: mountPath,
    dsh_version: version,
    management: dshHostManagementAvailable(),
    host: process.env.AETHER_HOST ?? "",
    node: process.version,
  };
}

/**
 * A `!!js` tag in the composed profile is an expression the harness evaluates
 * in its own context (e.g. `!ctx.get('profileContext')`). We cannot evaluate it
 * here, so it is kept as an opaque string the app shows as "conditional".
 */
const JsExpression = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  construct: (data) => ({ __jsExpression: String(data) }),
});

const composedSchema = yaml.DEFAULT_SCHEMA.extend([JsExpression]);

/** True when a value is one of the composed profile's `!!js` expressions. */
function isJsExpression(value) {
  return Boolean(value && typeof value === "object" && typeof value.__jsExpression === "string");
}

/**
 * The composed plugin tree of a profile, from `cordis.yml`.
 *
 * `cordis.patch.yml` only holds this machine's overrides (a handful of rows),
 * while `cordis.yml` is the full tree the harness actually loads — every
 * bundle's plugins plus the patch. The app lists *this* so the plugin page
 * shows what is really running, and reports patch overrides alongside.
 */
export function readComposedProfile({ dshHome = process.env.DSH_HOME || "/home/dsh/.dsh", profile = "web" } = {}) {
  const dir = path.join(dshHome, "profiles", profile);
  const composedFile = path.join(dir, "cordis.yml");
  const patchFile = path.join(dir, "cordis.patch.yml");

  let raw = "";
  try {
    raw = fs.readFileSync(composedFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const wrapped = new Error(`No composed harness profile at ${composedFile}.`);
      wrapped.code = "dsh_profile_missing";
      throw wrapped;
    }
    throw error;
  }

  let document;
  try {
    document = yaml.load(raw, { schema: composedSchema }) ?? [];
  } catch (error) {
    const wrapped = new Error(`Cannot parse ${composedFile}: ${error.message}`);
    wrapped.code = "dsh_profile_invalid";
    throw wrapped;
  }

  const plugins = [];
  const visit = (entries) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (Array.isArray(entry.insert)) {
        visit(entry.insert);
        continue;
      }
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!id) continue;
      const name = typeof entry.name === "string" ? entry.name : "";
      // How the plugin is switched: explicit true/false, or a condition the
      // harness evaluates (`!!js`).
      let enabled;
      let conditional = false;
      if (isJsExpression(entry.disabled)) {
        conditional = true;
        enabled = false;
      } else {
        enabled = entry.disabled !== true;
      }
      const config = entry.config && typeof entry.config === "object" ? entry.config : {};
      plugins.push({
        id,
        name,
        enabled,
        conditional,
        // The npm package a plugin mounts (for the app's subtitle / grouping).
        package: name.split("/")[0] === "@deepseek-ai" ? name : name || id,
        config_keys: Object.keys(config),
      });
    }
  };
  visit(document);

  // Patch rows override the composed entry with the same id (or add one).
  const patch = readProfilePatchSafely(patchFile);
  const patchById = new Map(patch.map((row) => [row.id, row]));
  for (const plugin of plugins) {
    const override = patchById.get(plugin.id);
    if (!override) continue;
    plugin.patch = true;
    // A patch row with `disabled: true` turns the plugin off; one without it
    // turns it on (that is how the web Plugins page writes the override).
    plugin.enabled = override.disabled !== true;
    plugin.conditional = false;
  }
  const composedIds = new Set(plugins.map((plugin) => plugin.id));
  for (const row of patch) {
    if (composedIds.has(row.id)) continue;
    plugins.push({
      id: row.id,
      name: row.name,
      enabled: !row.disabled,
      conditional: false,
      package: row.name || row.id,
      patch: true,
      inserted: true,
      config_keys: Object.keys(row.config ?? {}),
    });
  }

  return {
    profile,
    file: composedFile,
    patch_file: patchFile,
    profile_exists: true,
    total: plugins.length,
    enabled: plugins.filter((plugin) => plugin.enabled).length,
    plugins,
  };
}

function readProfilePatchSafely(file) {
  try {
    const document = yaml.load(fs.readFileSync(file, "utf8")) ?? [];
    return summarizeEntries(document, "patch").map((row) => ({
      id: row.id,
      name: row.name,
      disabled: row.disabled,
      config: row.config,
    }));
  } catch {
    return [];
  }
}

/**
 * Enable/disable a plugin in the composed profile.
 *
 * The composed `cordis.yml` is regenerated from the bundles, so the durable
 * place for an override is `cordis.patch.yml`: writing there survives a
 * regeneration and hot-reloads the same way the web Models page does.
 */
export function setComposedPluginEnabled({ dshHome = process.env.DSH_HOME || "/home/dsh/.dsh", profile = "web", id, enabled } = {}) {
  return setProfilePluginEnabled({ dshHome, profile, id, enabled });
}
