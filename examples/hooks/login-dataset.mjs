import { readFile } from 'node:fs/promises';

// Stand-in for a real project's dataset: here it's a JSON file checked into the repo, but a real
// project would lease a row from its own backend (a test-data service, a DB pool) instead, and
// release it in teardown so it's free for the next run.
export async function setup() {
  const users = JSON.parse(await readFile(new URL('../fixtures/users.json', import.meta.url), 'utf8'));
  return { user: users[0] };
}

export async function teardown({ data, result }) {
  console.error(`teardown: released ${data.user.name} (run ${result.status})`);
}
