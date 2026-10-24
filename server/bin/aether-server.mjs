#!/usr/bin/env node
import { startAetherServer } from "../src/index.mjs";
import { UsageError, loadConfig, usage } from "../src/config.mjs";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${usage()}\n`);
      process.exit(2);
    }
    throw error;
  }
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const server = await startAetherServer(config);
  process.stdout.write(
    `\nAether remote agent server ready\n` +
    `  URL:        ${server.url}\n` +
    `  WebSocket:  ${server.url.replace(/^http/, "ws")}/v1/agent\n` +
    `  Dashboard:  ${server.url}/\n` +
    `  Data:       ${config.dataDir}\n\n` +
    `Point Aether at the URL above and enter one of your tokens.\n` +
    `Press Ctrl+C to stop.\n\n`,
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\nReceived ${signal}, shutting down…\n`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(`aether-server failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
