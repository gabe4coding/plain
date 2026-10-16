// usage: node wait-ci.mjs <pr>
// waits until CI runs exist for the PR head, then watches the checks; exit code = gh pr checks exit code.
import { execFileSync, spawnSync } from 'node:child_process';

const pr = process.argv[2];
const repo = 'gabe4coding/plain';
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const head = gh(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid']);
for (let i = 0; i < 40; i++) {
  const runs = JSON.parse(gh(['run', 'list', '--repo', repo, '--commit', head, '--json', 'name']));
  if (runs.length >= 2) break;
  await new Promise((r) => setTimeout(r, 5000));
}
console.log(`head ${head}`);
const r = spawnSync('gh', ['pr', 'checks', pr, '--repo', repo, '--watch', '--interval', '20'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
