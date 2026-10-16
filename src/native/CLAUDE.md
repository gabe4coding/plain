# Native core (desktop and mobile)

`src/native/` is the shared desktop/mobile core. `src/computer/` and `src/mobile/` build on it.

- `NativeSession` (`session.ts`): Jev targeting via `askSettled`, expect/wait polling, phase timing. Subclasses
  implement `parse`, `label` and `act`.
- `runNativeSpec` (`run-spec.ts`): hooks → open → steps → teardown → close. `nativeCli` (`src/suite/native-cli.ts`).
- `src/native/mcp.ts` (`createNativeServer`, `serveNative`) holds the shared step/find/snapshot/ask/read/screenshot/
  save/close tools. Each platform registers its own open and discovery tools first.
- As in the browser: `step` results carry `changed` (diffed against the step's own first whole-screen capture,
  `NativeSession.firstSnapshot`; press/swipe/mouse capture first), picks see `goal` (`open {goal}`, spec `goal:`),
  and `read` answers with tree lines.
- Spatial evidence too: `NativeSession` queues prompt groups per spec (`runNativeSpec`) and per step, and routes
  them through `core/evidence.ts` (injected intelligence without `ask` never routes). A spatial capture
  (`CaptureOptions.spatial`, also on `captureEarly`) gives candidates `bounds`, the snapshot a `layout`
  (`nativeLayout` in `core/layout.ts`: named elements, measured neighbors, 254 rows, 24k chars) and the frame its
  `coordinates`, which picks name instead of the browser's CSS pixels. Desktop reads xa11y `bounds` only in a
  spatial capture; mobile parses Android `bounds` and iOS `x`/`y`/`width`/`height`; a spatial iOS capture is never
  fast, since the fast tree would measure covered elements as visible references. The mobile and macOS smoke
  fixtures hold an Alpha/Beta pair whose tree order is the reverse of its visual order.
- `NativeSession.settled()` uses `askSettled` (`core/automation.ts`): within 1 s of the previous step (or
  `noteActivity()` after open), a platform with `captureEarly` reads a quick tree and Jev works on it while the
  idle-waiting `capture()` runs; the answer is kept only if both frames are identical, else re-asked
  (`ms.reasked`). Android implements it; iOS returns null (no gain measured). The pre-action identity revalidation
  is unchanged.
- `save` never writes a password: a `fill` into an element the adapter's `secret()` reports (macOS subrole
  `AXSecureTextField`, iOS `XCUIElementTypeSecureTextField`, Android `password="true"`), and any later fill of the
  same value, is saved as `${env.password}` (`password2`, ...) with an `env` block.
  `NativeSession.filledSecret` carries the answer from `act` to the MCP server.
- Run modes (`src/core/lock.ts`): `NativeSession.find` replays a recorded candidate when exactly one candidate on
  the screen has its `nativeIdentity` (the description without `value=` and `[state]` flags), records the
  accepted picks, and `assert` records or (no-judge) compares the hashed passing state; `run` reruns a step that
  failed with a replayed element (auto-healing). The MCP `save` writes the session's records as the lock file.
- Native engines require `--workers 1`.
- Tests: `session.ts` and `mcp.ts` are tested through each platform, in `src/computer/session.test.ts` and
  `src/mobile/session.test.ts`; the run modes in `lock.test.ts`.
