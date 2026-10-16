// The module boundaries of src/ (`npm run check:deps`). The allowed imports between the folders, from the source
// layout in CODING_STANDARDS.md; the rules below fail every other import between them:
//
//   src/cli.ts         -> browser, suite, core, jev   (the plain CLI)
//   computer, mobile   -> native, core, jev; their cli.ts also -> suite/native-cli.ts
//   browser, native    -> core, jev
//   suite              -> core, jev
//   core               -> jev
//   jev                -> core/candidate.ts only, which imports nothing from src/
//
// A new folder under src/ fails until it has its place here. Type-only imports count too
// (`tsPreCompilationDeps`): a type edge is one runtime import away from a real cycle. The rules skip imports from
// tests, which may reach across folders to set up a fixture; code outside tests never imports a test, because the
// package leaves the compiled tests out. scripts/check-deps.test.mjs proves that each rule still fails its edge.

const AREAS = '^src/((browser|computer|core|jev|mobile|native|suite)/|cli\\.ts$)';
const ENGINES = '^src/(browser|computer|mobile|native)/';
const PLATFORM_CLIS = '^src/(computer|mobile)/cli\\.ts$';
const CLIS = '^src/(cli|computer/cli|mobile/cli)\\.ts$';
const TESTS = '\\.test\\.ts$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Modules import each other in a loop. Move the shared part to a module that both can import.',
      from: { pathNot: TESTS },
      to: { circular: true },
    },
    {
      name: 'known-areas',
      severity: 'error',
      comment: 'Each module of src/ is src/cli.ts or sits in a folder the header of .dependency-cruiser.cjs names. Give a new folder its rules there.',
      from: { path: '^src/', pathNot: [AREAS, TESTS] },
      to: {},
    },
    {
      name: 'known-areas-target',
      severity: 'error',
      comment: 'Each module of src/ is src/cli.ts or sits in a folder the header of .dependency-cruiser.cjs names. Give a new folder its rules there.',
      from: { pathNot: TESTS },
      to: { path: '^src/', pathNot: AREAS },
    },
    {
      name: 'browser-isolated',
      severity: 'error',
      comment: 'The browser engine uses no other engine. Move the shared part to src/core/.',
      from: { path: '^src/browser/', pathNot: TESTS },
      to: { path: '^src/(computer|mobile|native)/' },
    },
    {
      name: 'native-no-platforms',
      severity: 'error',
      comment: 'src/native/ is what desktop and mobile share, so it imports neither of them nor the browser engine. Inject the platform part through the adapter.',
      from: { path: '^src/native/', pathNot: TESTS },
      to: { path: '^src/(browser|computer|mobile)/' },
    },
    {
      name: 'platforms-isolated',
      severity: 'error',
      comment: 'Desktop and mobile share code only through src/native/; neither imports the other or the browser engine.',
      from: { path: '^src/(computer|mobile)/', pathNot: TESTS },
      to: { path: '^src/(browser|computer|mobile)/', pathNot: '^src/$1/' },
    },
    {
      name: 'core-no-up',
      severity: 'error',
      comment: 'src/core/ is engine-independent: it imports no engine, no suite code and no CLI. Pass the engine part in as a parameter or a type argument.',
      from: { path: '^src/core/', pathNot: TESTS },
      to: { path: [ENGINES, '^src/suite/', CLIS] },
    },
    {
      name: 'jev-is-leaf',
      severity: 'error',
      comment: 'src/jev/ is the model layer: from the rest of src/ it imports only src/core/candidate.ts.',
      from: { path: '^src/jev/', pathNot: TESTS },
      to: { path: '^src/', pathNot: ['^src/jev/', '^src/core/candidate\\.ts$'] },
    },
    {
      name: 'candidate-is-leaf',
      severity: 'error',
      comment: 'src/core/candidate.ts imports nothing from src/, so src/jev/ can use it without a cycle.',
      from: { path: '^src/core/candidate\\.ts$' },
      to: { path: '^src/' },
    },
    {
      name: 'suite-no-engines',
      severity: 'error',
      comment: 'src/suite/ runs specs through the engine a CLI passes in; it imports no engine and no CLI.',
      from: { path: '^src/suite/', pathNot: TESTS },
      to: { path: [ENGINES, CLIS] },
    },
    {
      name: 'engines-no-suite',
      severity: 'error',
      comment: 'Of the engine folders, only the desktop and mobile CLIs import from src/suite/. Move the run contract part to src/core/run-contract.ts.',
      from: { path: ENGINES, pathNot: [PLATFORM_CLIS, TESTS] },
      to: { path: '^src/suite/' },
    },
    {
      name: 'platform-cli-wiring',
      severity: 'error',
      comment: 'The desktop and mobile CLIs take their suite wiring from src/suite/native-cli.ts only.',
      from: { path: PLATFORM_CLIS },
      to: { path: '^src/suite/', pathNot: '^src/suite/native-cli\\.ts$' },
    },
    {
      name: 'plain-cli-browser-only',
      severity: 'error',
      comment: 'src/cli.ts is the browser CLI; the desktop and mobile engines have their own CLIs.',
      from: { path: '^src/cli\\.ts$' },
      to: { path: '^src/(computer|mobile|native)/' },
    },
    {
      name: 'no-cli-imports',
      severity: 'error',
      comment: 'The CLIs are entry points for bin/; no module imports one.',
      from: { pathNot: TESTS },
      to: { path: CLIS },
    },
    {
      name: 'no-test-imports',
      severity: 'error',
      comment: 'The package leaves out dist/**/*.test.js, so code outside tests never imports a test. Move the shared helper to a module of its own.',
      from: { pathNot: TESTS },
      to: { path: TESTS },
    },
  ],
  options: {
    includeOnly: '^src/',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
