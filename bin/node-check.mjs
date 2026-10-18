// Stop before Playwright or webdriverio load. An older Node fails later with a confusing missing-file error.

/** The message `refuseOldNode` prints. `minimum` is `22` or `22.19`. */
export function nodeVersionMessage(version, minimum = '22') {
  const who = minimum === '22' ? 'plain' : 'plain-mobile';
  return `${who} requires Node.js ${minimum} or newer. This process is Node.js ${version}.\nInstall Node.js ${minimum} or newer and run the command again.`;
}

/** True when `version` is older than `minimum`. Missing parts compare as 0. */
export function isOlderNode(version, minimum) {
  const parse = (text) => String(text).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const got = parse(version);
  const need = parse(minimum);
  const length = Math.max(got.length, need.length);
  for (let i = 0; i < length; i++) {
    const left = got[i] ?? 0;
    const right = need[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/** Exit when this process is older than `minimum`. */
export function refuseOldNode(minimum = '22') {
  if (!isOlderNode(process.versions.node, minimum)) return;
  console.error(nodeVersionMessage(process.versions.node, minimum));
  process.exit(1);
}
