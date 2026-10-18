#!/usr/bin/env node
// Browser CLI entrypoint (npm bin). On the first run it downloads the Chromium of the installed Playwright.
// stdout belongs to MCP: the installer's output goes to stderr only.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { refuseOldNode } from './node-check.mjs';
refuseOldNode();
const require = createRequire(import.meta.url);
const { chromium } = await import('playwright');
if (!existsSync(chromium.executablePath())) {
  console.error('plain: installing Chromium (first run)…');
  const playwrightCli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  const result = spawnSync(process.execPath, [playwrightCli, 'install', 'chromium'], { stdio: ['ignore', 2, 2] });
  if (result.status !== 0) { console.error('plain: "playwright install chromium" failed'); process.exit(1); }
}
await import('../dist/cli.js');
