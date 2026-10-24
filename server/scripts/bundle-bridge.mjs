#!/usr/bin/env node
/**
 * Copies the built Pi bridge bundles into `server/bridge/` so `npm pack`
 * produces a self-contained server package: install it on any machine with
 * Node >= 22 and `aether-server` finds the bridge without a repo checkout.
 *
 *   cd pi-bridge && npm run build
 *   cd ../server && npm pack
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(serverRoot, "..", "pi-bridge", "dist");
const target = path.join(serverRoot, "bridge");

if (!fs.existsSync(path.join(source, "bridge.mjs"))) {
  console.error(
    `[bundle-bridge] ${source}/bridge.mjs is missing.\n` +
      "  Build it first:  cd pi-bridge && npm ci && npm run build",
  );
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
let bytes = 0;
for (const name of fs.readdirSync(source)) {
  const from = path.join(source, name);
  if (!fs.statSync(from).isFile()) continue;
  const to = path.join(target, name);
  fs.copyFileSync(from, to);
  bytes += fs.statSync(to).size;
}
console.log(
  `[bundle-bridge] copied ${fs.readdirSync(target).length} files (${(bytes / 1024 / 1024).toFixed(1)} MB) into ${path.relative(serverRoot, target)}/`,
);
