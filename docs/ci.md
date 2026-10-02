# CI and containers

The regular `npm test` suite needs no Jev API key. It builds the TypeScript output and runs local tests. The repository's GitHub workflow also checks that `dist/` and the plugin runtime archives match `npm run build`.

## GitHub Action

The root `action.yml` runs YAML specs from the caller's checkout. Supply a Jev key as a repository secret. A minimal caller workflow is:

```yaml
name: Browser specs
on: [pull_request]
jobs:
  specs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gabe4coding/plainwright@main
        with:
          specs: tests/
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
```

For JUnit output and failure artifacts, set the paths explicitly. `args` and `specs` use shell-style quoting for values containing spaces; they are parsed as arguments, never run as a shell script.

```yaml
name: Browser specs
on: [pull_request]
jobs:
  specs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gabe4coding/plainwright@main
        with:
          specs: 'tests/smoke/ tests/checkout/*.yaml'
          args: '--workers 2 --retries 1'
          junit: plainwright-results/junit.xml
          artifacts: plainwright-results
          node-version: '22'
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
          # Or use AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
```

The action installs its own locked runtime dependencies and Chromium, runs the specs with text and JUnit reporters, and uploads the artifacts directory if the run fails. Artifact names must be unique in a workflow run, so in a matrix give each job its own `artifact-name` (for example `plainwright-results-${{ matrix.site }}`).

## Docker

The image uses Playwright 1.63.0's bundled Chromium and runs as `pwuser`. Build and run it from the Plainwright repository:

```sh
docker build -t plainwright .
docker run --rm -v "$PWD:/work" -e TYPESAFE_API_KEY plainwright tests/
```

The mounted directory is the spec working directory. Set `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` in the host environment and pass only the variable name with `-e`; keep credentials out of spec files and image layers. Running without spec files prints usage and exits 2.

## GitLab CI

For a repository with Plainwright source and a `tests/` directory, this job saves the JUnit report and failure artifacts:

```yaml
browser-specs:
  image: mcr.microsoft.com/playwright:v1.63.0-noble
  variables:
    PLAYWRIGHT_BROWSERS_PATH: /ms-playwright
  script:
    - npm ci
    - node dist/cli.js --headless --reporter text --reporter junit:plainwright-results/junit.xml --artifacts plainwright-results tests/
  artifacts:
    when: always
    paths:
      - plainwright-results/
    reports:
      junit: plainwright-results/junit.xml
```

Configure `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` as a masked CI variable for live specs.

Point specs at test environments only, stop before the last irreversible step (payment, booking, sending), and never bypass bot protection.
