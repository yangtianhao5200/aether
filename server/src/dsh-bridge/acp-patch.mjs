import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

/**
 * The ACP profile has to offer the same provider routes as the host's web
 * profile.
 *
 * The phone picks a model from the host catalog (the server reads it from the
 * web profile patch) and the agent itself runs inside the ACP profile, so the
 * two have to agree. When they drift, the turn dies with
 * "llm-pi-ai: no credential for provider route ..." — either because the
 * route only exists on one side, or because a hand-written route points at an
 * endpoint whose credential was never stored.
 *
 * This module materializes a patch for the ACP profile that carries the web
 * profile's `llm-pi-ai` routes and its default model, so every model the
 * phone can pick is served by a route that resolves its credential.
 */

const PROVIDER_ENTRY_ID = "llm-pi-ai";
const DEFAULT_MODEL_ENTRY_ID = "agent-default-model";

/** Read a patch file; a broken or missing file simply contributes nothing. */
function readDocument(file) {
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const document = yaml.load(raw);
    return Array.isArray(document) ? document : [];
  } catch {
    return [];
  }
}

/** Find a patch entry by id, including entries nested in an `insert` list. */
function findEntry(document, id) {
  if (!Array.isArray(document)) return null;
  for (const entry of document) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.id === id) return entry;
    if (Array.isArray(entry.insert)) {
      const nested = entry.insert.find((item) => item && item.id === id);
      if (nested) return nested;
    }
  }
  return null;
}

/** The provider routes the host's web profile configures. */
export function webProviderRoutes({ dshHome, profile = "web" } = {}) {
  if (!dshHome) return {};
  const file = path.join(dshHome, "profiles", profile, "cordis.patch.yml");
  const entry = findEntry(readDocument(file), PROVIDER_ENTRY_ID);
  const providers = entry?.config?.providers;
  return providers && typeof providers === "object" ? providers : {};
}

/** The model the host's web profile uses by default. */
export function webDefaultModel({ dshHome, profile = "web" } = {}) {
  if (!dshHome) return null;
  const file = path.join(dshHome, "profiles", profile, "cordis.patch.yml");
  const entry = findEntry(readDocument(file), DEFAULT_MODEL_ENTRY_ID);
  const config = entry?.config ?? {};
  const provider = typeof config.provider === "string" ? config.provider : "";
  const model = typeof config.model === "string" ? config.model : "";
  return provider && model ? { provider, model } : null;
}

/**
 * Build the patch the ACP profile is started with.
 *
 * The result keeps every entry of the configured patch (the ACP defaults, for
 * instance) but swaps the provider routes and the default model for the
 * host's ones, and repoints any entry that names a provider route the host no
 * longer has.
 */
export function buildAcpPatch({
  dshHome,
  profile = "web",
  patchPath = "",
  outPath,
  log = () => {},
} = {}) {
  if (!outPath) throw new Error("buildAcpPatch needs an output path.");
  const staticDocument = readDocument(patchPath);
  const routes = webProviderRoutes({ dshHome, profile });
  const routeIds = Object.keys(routes);
  const hostDefault = webDefaultModel({ dshHome, profile });
  const usableDefault = hostDefault && routeIds.includes(hostDefault.provider)
    ? hostDefault
    : null;

  const document = [];

  // 1. The provider routes: the host's, so every model the phone offers is
  //    served by a route whose credential resolves.
  const staticProviders = findEntry(staticDocument, PROVIDER_ENTRY_ID);
  if (routeIds.length > 0) {
    document.push({
      id: PROVIDER_ENTRY_ID,
      config: { ...(staticProviders?.config ?? {}), providers: routes },
    });
  } else if (staticProviders) {
    log("warn", "acp_patch.routes_missing", {
      profile,
      file: path.join(dshHome ?? "", "profiles", profile, "cordis.patch.yml"),
    });
    document.push(staticProviders);
  }

  // 2. The default model: the host's, when it is one of the routes above.
  const staticDefault = findEntry(staticDocument, DEFAULT_MODEL_ENTRY_ID)?.config ?? {};
  if (usableDefault || staticDefault.provider) {
    document.push({
      id: DEFAULT_MODEL_ENTRY_ID,
      config: { ...staticDefault, ...(usableDefault ?? {}) },
    });
  }

  // 3. Everything else the configured patch brings (the ACP agent's own
  //    defaults), with providers that the host does not have moved over to the
  //    host's default model.
  for (const entry of staticDocument) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.id === PROVIDER_ENTRY_ID || entry.id === DEFAULT_MODEL_ENTRY_ID) continue;
    const config = entry.config;
    if (config && typeof config === "object" && typeof config.provider === "string") {
      if (usableDefault && !routeIds.includes(config.provider)) {
        document.push({
          ...entry,
          config: { ...config, provider: usableDefault.provider, model: usableDefault.model },
        });
        continue;
      }
    }
    document.push(entry);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, yaml.dump(document), "utf8");
  return {
    path: outPath,
    routes: routeIds,
    defaultModel: usableDefault,
    providersFromHost: routeIds.length > 0,
  };
}
