# Setup and teardown hooks

A spec can lease test data before its first step and release it after the last one, whatever the
outcome. The data is used in steps as `${hooks.*}`.

```yaml
name: Login with a user from the dataset
url: https://the-internet.herokuapp.com
env:
  path: /login
hooks: ./hooks/login-dataset.mjs
steps:
  - goto: "${env.path}"
  - fill: { target: the username textbox, value: "${hooks.user.name}" }
  - fill: { target: the password textbox, value: "${hooks.user.pass}" }
  - click: the Login button
  - expect: a heading with the text "Secure Area" is shown
```

`hooks` is a path relative to the spec file. It points at an ES module with two optional exports:

```js
export async function setup({ spec, page }) {
  const user = await leaseUser();     // your test-data service, a DB pool, a JSON file...
  return { user };                    // becomes ${hooks.user.*}
}

export async function teardown({ spec, page, data, result }) {
  await releaseUser(data.user);       // data is what setup returned
  console.error(`released ${data.user.name} (run ${result.status})`);
}
```

- `setup` runs once, before the first step, with the Playwright `page` already open. What it returns
  becomes `${hooks.*}` in `url` and in every step string, and is passed to `teardown` as `data`.
- `teardown` runs after every successful `setup`, whether the steps passed, failed or errored, so a
  lease is never left behind. `result` is `{ status, steps }` for the run so far.
- Where the data comes from is up to the module. plainwright only calls the two functions and passes the
  data through.

## Static data: `env`

`env` is a top-level mapping of static values, nested as you like, used as `${env.*}`. A leaf string
starting with `$` is read from the OS environment when the spec loads, so a credential never sits in
the file. A missing variable is an error that names it.

```yaml
env:
  path: /login
  user: { name: tomsmith, pass: $DEMO_PASSWORD }   # $DEMO_PASSWORD → process.env.DEMO_PASSWORD
steps:
  - fill: { target: the password textbox, value: "${env.user.pass}" }
```

## Failure rules

- The hooks module is imported before the browser opens, so a bad path fails fast.
- A `setup` error skips every step and `teardown` (nothing was leased). The run is `error` with a single
  `setup` step.
- A `teardown` error makes the run `error`, even when every step passed.
- An unresolved `${...}` placeholder fails the run before the first step and names the exact text.

Working example: `examples/login-dataset.yaml`, `examples/hooks/login-dataset.mjs` and
`examples/fixtures/users.json`.

Hooks work in agent mode too: pass `hooks` to the `open` tool. See [agent-mode.md](agent-mode.md).
