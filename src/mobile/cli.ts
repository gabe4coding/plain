#!/usr/bin/env node
import { nativeCli } from '../suite/native-cli.js';
import { AppiumAdapter, DEFAULT_APPIUM_URL } from './adapter.js';
import { MobileSession, runMobileSpec } from './session.js';
import { loadMobileSpec } from './spec.js';

const appiumUrl = (values: Record<string, string | undefined>) => values.server ?? process.env.PLAIN_APPIUM_URL ?? DEFAULT_APPIUM_URL;

await nativeCli('plain-mobile', '[--server http://127.0.0.1:4723] ', 'mobile', {
  serve: async (timeout, values) => (await import('./mcp.js')).serveMobileMcp(timeout, appiumUrl(values)), // the MCP SDK loads only when serving
  load: loadMobileSpec,
  meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }),
  run: (spec, timeout, values, observer, info, specTimeout) => {
    const adapter = new AppiumAdapter(appiumUrl(values), timeout, undefined, true);
    return runMobileSpec(spec, new MobileSession(adapter, timeout), observer, info, specTimeout);
  },
});
