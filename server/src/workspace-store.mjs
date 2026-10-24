import * as fs from "node:fs/promises";
import path from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class WorkspacePathError extends Error {
  constructor(message, code = "path_outside_workspace") {
    super(message);
    this.code = code;
  }
}

/**
 * Per-user sandbox layout:
 *
 *   <dataDir>/users/<user>/<workspace>/home/       (HOME, ~/.pi, ~/.aether)
 *   <dataDir>/users/<user>/<workspace>/workspace/  (agent working directory)
 *   <dataDir>/users/<user>/<workspace>/.aether/    (journal, logs)
 *
 * Paths are absolute and handed to clients verbatim, so the phone never has to
 * translate guest paths: whatever the client sends back is already valid on the
 * server that runs the bridge.
 */
export class WorkspaceStore {
  constructor({ dataDir, bridgePath = "", log = () => {} }) {
    this.dataDir = dataDir;
    this.usersRoot = path.join(dataDir, "users");
    this.bridgePath = bridgePath;
    this.log = log;
    this.cache = new Map();
  }

  async initialize() {
    await fs.mkdir(this.usersRoot, { recursive: true });
  }

  static normalizeSegment(value, fallback) {
    const candidate = String(value ?? "").trim();
    if (!candidate) return fallback;
    if (!SAFE_SEGMENT.test(candidate)) {
      throw new WorkspacePathError(
        `Invalid workspace segment "${candidate}": use letters, digits, dot, dash or underscore.`,
        "invalid_workspace_name",
      );
    }
    return candidate;
  }

  /**
   * Resolve (and create) a workspace handle. Idempotent.
   * @returns {Promise<Workspace>}
   */
  async ensure(userId, name = "default") {
    const user = WorkspaceStore.normalizeSegment(userId, "default");
    const workspaceName = WorkspaceStore.normalizeSegment(name, "default");
    const id = `${user}/${workspaceName}`;
    const cached = this.cache.get(id);
    if (cached) return cached;

    const root = path.join(this.usersRoot, user, workspaceName);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const state = path.join(root, ".aether");
    for (const directory of [home, workspace, path.join(state, "journal"), path.join(state, "logs")]) {
      await fs.mkdir(directory, { recursive: true });
    }

    const handle = {
      id,
      user,
      name: workspaceName,
      root,
      home,
      workspace,
      state,
      journalDirectory: path.join(state, "journal"),
      logDirectory: path.join(state, "logs"),
      agentDirectory: path.join(home, ".pi", "agent"),
      // The app spawns auxiliary bridges (extensions, MCP) through the runtime,
      // so the bundles must be reachable from inside the workspace home.
      bridgeDirectory: path.join(home, ".aether", "pi-bridge"),
      extensionDirectory: path.join(home, ".aether", "extensions"),
      allowedRoots: [home, workspace],
    };
    await linkBridgeBundles(handle, this.bridgePath, this.log);
    this.cache.set(id, handle);
    return handle;
  }

  async list(userId) {
    const user = WorkspaceStore.normalizeSegment(userId, "default");
    const userRoot = path.join(this.usersRoot, user);
    let entries;
    try {
      entries = await fs.readdir(userRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && SAFE_SEGMENT.test(entry.name))
      .map((entry) => ({
        id: `${user}/${entry.name}`,
        user,
        name: entry.name,
        root: path.join(userRoot, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Map a client-supplied path onto the sandbox, rejecting anything outside the
   * home/workspace roots (including symlink escapes).
   *
   * Relative paths resolve against the workspace root, which is what the app
   * uses for `@file` references and attachment uploads.
   */
  async resolve(workspace, inputPath, { mustExist = false } = {}) {
    const raw = String(inputPath ?? "").trim();
    const candidate = raw === "" ? workspace.workspace : raw;
    const absolute = path.isAbsolute(candidate)
      ? path.normalize(candidate)
      : path.resolve(workspace.workspace, candidate);

    const inside = workspace.allowedRoots.some(
      (root) => absolute === root || absolute.startsWith(root + path.sep),
    );
    if (!inside) {
      throw new WorkspacePathError(`Path is outside this workspace: ${raw}`);
    }

    // Resolve symlinks on the longest existing prefix so a symlink cannot point
    // outside the sandbox.
    const existing = await realpathIfExists(absolute);
    if (existing) {
      const stillInside = workspace.allowedRoots.some(
        (root) => existing === root || existing.startsWith(root + path.sep),
      );
      if (!stillInside) {
        throw new WorkspacePathError(`Path escapes the workspace through a symlink: ${raw}`);
      }
      return existing;
    }
    if (mustExist) {
      throw new WorkspacePathError(`Path does not exist: ${raw}`, "not_found");
    }

    const parent = await realpathIfExists(path.dirname(absolute));
    if (parent) {
      const stillInside = workspace.allowedRoots.some(
        (root) => parent === root || parent.startsWith(root + path.sep),
      );
      if (!stillInside) {
        throw new WorkspacePathError(`Path escapes the workspace through a symlink: ${raw}`);
      }
      return path.join(parent, path.basename(absolute));
    }
    return absolute;
  }
}

async function realpathIfExists(target) {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

/**
 * Exposes the built bridge bundles inside the workspace home, so the app can
 * start `extension-bridge.mjs` (and any future helper) the same way it does on
 * a phone, without knowing the server's checkout path.
 */
async function linkBridgeBundles(workspace, bridgePath, log) {
  if (!bridgePath) return;
  const sourceDirectory = path.dirname(bridgePath);
  const targetDirectory = workspace.bridgeDirectory;
  await fs.mkdir(targetDirectory, { recursive: true });
  let entries;
  try {
    entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  } catch (error) {
    log("warn", "workspace.bridge_bundles_missing", { error: String(error) });
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const source = path.join(sourceDirectory, entry.name);
    const target = path.join(targetDirectory, entry.name);
    try {
      const existing = await fs.lstat(target).catch(() => null);
      if (existing) continue;
      await fs.symlink(source, target);
    } catch (error) {
      log("debug", "workspace.bridge_link_failed", {
        name: entry.name,
        error: String(error),
      });
    }
  }
}
