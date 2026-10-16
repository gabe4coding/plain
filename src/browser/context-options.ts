import { devices, type BrowserContextOptions } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Spec } from '../core/spec.js';
import type { RunOptions } from './run-options.js';

/** Edit distance keeps device suggestions useful for misspellings and nearby versions. */
function distance(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++)
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (left[i] === right[j] ? 0 : 1)));
    row = next;
  }
  return row[right.length];
}

export function browserContextOptions(spec: Spec, opts: RunOptions): BrowserContextOptions {
  const browser = spec.browser;
  if (opts.cdp && (spec.auth || spec.geolocation || (browser && Object.keys(browser).length)))
    throw new Error('--cdp attaches to an existing browser context: `auth`, `geolocation` and `browser` in the spec are not supported there');
  if (opts.profile && browser?.storageState !== undefined)
    throw new Error('--profile uses a persistent browser context: `browser.storageState` in the spec is not supported there');
  const options: BrowserContextOptions = {};
  if (browser?.device !== undefined) {
    const device = Object.hasOwn(devices, browser.device) ? devices[browser.device] : undefined;
    if (!device) {
      const requested = browser.device.toLowerCase();
      const byDistance = (a: string, b: string) => distance(requested, a.toLowerCase()) - distance(requested, b.toLowerCase()) || a.localeCompare(b);
      const close = Object.keys(devices).sort(byDistance).slice(0, 3);
      throw new Error(`unknown browser device "${browser.device}"; close names: ${close.join(', ')}`);
    }
    const { defaultBrowserType: _type, ...context } = device;
    Object.assign(options, context);
  }
  if (browser?.viewport !== undefined) options.viewport = browser.viewport;
  if (browser?.locale !== undefined) options.locale = browser.locale;
  if (browser?.timezone !== undefined) options.timezoneId = browser.timezone;
  if (browser?.colorScheme !== undefined) options.colorScheme = browser.colorScheme;
  if (browser?.storageState !== undefined) {
    const file = resolve(spec.dir, browser.storageState);
    if (!existsSync(file)) throw new Error(`storageState file not found: ${file} (run the spec that saves it first)`);
    options.storageState = file;
  }
  if (spec.auth) options.httpCredentials = { username: spec.auth.user, password: spec.auth.pass };
  if (spec.geolocation) {
    options.geolocation = { latitude: spec.geolocation.lat, longitude: spec.geolocation.lon };
    options.permissions = ['geolocation'];
  }
  return options;
}
