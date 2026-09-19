#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// stdout is the MCP JSON-RPC channel, so all install output goes to stderr (fd 2).
function runOrExit(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 2, 2] });
  if (result.status !== 0) {
    console.error(`jev-e2e: "${cmd} ${args.join(' ')}" failed`);
    process.exit(1);
  }
}

if (!existsSync(join(root, 'node_modules', 'playwright'))) {
  console.error('jev-e2e: installing dependencies (first run)…');
  // --ignore-scripts: this is a runtime install, not a dev checkout; no build step needed here.
  runOrExit('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts']);
}

const { chromium } = await import(pathToFileURL(join(root, 'node_modules/playwright/index.mjs')).href);

if (!existsSync(chromium.executablePath())) {
  console.error('jev-e2e: installing Chromium (first run)…');
  runOrExit('npx', ['playwright', 'install', 'chromium']);
}

await import(pathToFileURL(join(root, 'dist/cli.js')).href);
