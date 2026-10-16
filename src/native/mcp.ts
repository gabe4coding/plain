import { LockStore } from '../core/lock.js';
import { SecretNames, writeSaved } from '../core/save.js';
import { resolve, dirname, relative } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Intelligence, Snapshot } from '../core/automation.js';
import { interpolate } from '../core/interpolate.js';
import { parametersOf } from '../core/parameters.js';
import { snapshotView, SnapshotOptions, SNAPSHOT_MODES_DESCRIPTION } from '../core/snapshot-view.js';
import { startHooks, placeholderPaths, type HooksRunner, type HookSpec } from '../core/hooks.js';
import { overallStatus, type StepResult } from '../core/results.js';
import { serialQueue } from '../core/serial-queue.js';
import { jsonResult as ok, askResult, AskClaims, ASK_DESCRIPTION } from '../core/mcp-result.js';
import { ariaChanges, CHANGES_ENABLED, CHANGES_NOTE, type AriaChanges } from '../core/aria-changes.js';
import { READ_ENABLED, READ_DESCRIPTION } from '../core/read.js';
import type { AnyNativeSession } from './session.js';

type Spec = HookSpec & { hooks?: string; goal?: string };

type PlatformTools<S extends Spec> = {
  server: McpServer;
  /** The desktop or the device is one input: reads are serialized too, so a snapshot never races an action. */
  queue: ReturnType<typeof serialQueue>;
  /** Starts a new recording of `spec`: releases the previous hooks lease, runs setup, then `attach` (the platform's open). */
  open(spec: S, attach: (data: Record<string, unknown>) => Promise<object>): Promise<ReturnType<typeof ok>>;
  /** Resolves `${hooks.*}` with the data a given setup returned. */
  withPlaceholders<V>(value: V, data: Record<string, unknown>): V;
};

export interface NativeServerConfig<S extends Spec> {
  name: string;
  version: string;
  placeholderSource: string;
  spec: S;
  ai: Intelligence;
  session: AnyNativeSession;
  kinds: [string, ...string[]];
  describe: { step: string; find: string; snapshot: string; screenshot: string; save: string; close: string };
  /** The platform fields `save` writes (app, or platform/device/app). */
  saved: (spec: S) => Record<string, unknown>;
  /** Registers the platform's own tools (open, discovery) first, so tool order stays as documented. */
  registerPlatformTools: (tools: PlatformTools<S>) => void;
}

/** The desktop and mobile MCP servers: step, find, snapshot, ask, read, screenshot, save and close. */
export function createNativeServer<S extends Spec>(config: NativeServerConfig<S>) {
  const { session, ai, placeholderSource } = config;
  const adapter = session.adapter;
  const server = new McpServer({ name: config.name, version: config.version });
  const queue = serialQueue();
  let opened = false;
  let spec = config.spec;
  let transcript: Record<string, unknown>[] = [];
  /** What each passing step needed from Jev, keyed by its transcript position: `save` writes it as the lock file. */
  let recorder = new LockStore('judge').attempt();
  /** Each value typed into a secure text field, with the `env` key that `save` writes in its place. */
  let secrets = new SecretNames();
  let hooks: HooksRunner<S> | undefined;
  let data: Record<string, unknown> = {};
  let results: StepResult[] = [];
  /** The screen the last step's `changed` ended on. */
  let lastScreen: Snapshot | null = null;

  const requireOpen = () => {
    if (!opened) throw new Error('call open first');
  };
  const withPlaceholders = <V>(value: V, values = data) => interpolate(value, { env: {}, hooks: values }, placeholderSource);
  const withOptionalPlaceholders = (value: string | undefined) => (value ? withPlaceholders(value) : undefined);

  async function close() {
    opened = false;
    try {
      if (hooks?.has.teardown) await hooks.teardown({ spec, data, result: { status: overallStatus(results), steps: results } });
    } finally {
      hooks?.close();
      hooks = undefined;
      data = {};
      lastScreen = null;
      await adapter.close();
    }
  }

  config.registerPlatformTools({
    server,
    queue,
    withPlaceholders,
    async open(next, attach) {
      await close();
      transcript = [];
      recorder = new LockStore('judge').attempt();
      session.lock = recorder;
      secrets = new SecretNames();
      results = [];
      spec = next;
      session.goal = next.goal;
      let setupDone = false;
      try {
        if (spec.hooks) {
          hooks = await startHooks<S>(spec.hooks);
          if (hooks.has.setup) data = await hooks.setup(spec);
        }
        setupDone = true;
        const app = await attach(data);
        opened = true;
        return ok({ ...app, placeholders: placeholderPaths(data) });
      } catch (error) {
        results.push({ step: setupDone ? 'open' : 'setup', status: 'error', detail: String(error) });
        if (!setupDone) {
          hooks?.close();
          hooks = undefined;
        }
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Open and teardown failed');
        }
        throw error;
      }
    },
  });

  // `changed` diffs the screen before the step with the screen after it. A step that targets something already
  // captured the whole screen before acting (NativeSession.firstSnapshot): that is the before, since an exact
  // capture costs seconds on iOS. press, swipe and mouse never look first, so they capture one of their own. An
  // approximate target capture (iOS) lists covered elements and cannot be the before: the previous step's after
  // is, or right after open, a capture of its own.
  const capture = () => adapter.capture('region').then((frame) => frame.snapshot, () => null);
  const capturesBeforeActing = (step: { kind: string }) => !['press', 'swipe', 'mouse'].includes(step.kind);

  async function screenBefore(step: { kind: string; within?: string }): Promise<Snapshot | null> {
    if (!CHANGES_ENABLED) return null;
    // Only a claim over the whole screen is sure to look first with an exact capture.
    const exactFirst = ['expect', 'wait'].includes(step.kind) && !step.within;
    const needsOwnCapture = !capturesBeforeActing(step) || (adapter.approximateTargets && !lastScreen && !exactFirst);
    return needsOwnCapture ? capture() : null;
  }

  async function changesSince(before: Snapshot | null | undefined): Promise<{ changed?: AriaChanges }> {
    if (!before) return {};
    const after = lastScreen = await capture();
    return after ? { changed: ariaChanges(before, after) } : {};
  }

  server.registerTool('step', {
    description: config.describe.step + CHANGES_NOTE,
    inputSchema: { step: z.record(z.string(), z.unknown()) },
  }, ({ step }) => queue(async () => {
    requireOpen();
    const parsed = session.parse(step);
    const tokensBefore = session.tokens;
    const ownBaseline = await screenBefore(parsed as { kind: string; within?: string });
    // The position the step takes in the transcript if it passes; the file is set by `save`.
    session.parameters = parametersOf({ env: {}, hooks: data });
    const result = await session.run({ ...withPlaceholders(parsed), at: { file: '', index: transcript.length } } as typeof parsed);
    recorder.endStep(result);
    results.push(result);
    if (result.status === 'pass') transcript.push(await asSaved(step, parsed as { kind: string; value?: string }));
    const changed = CHANGES_ENABLED ? await changesSince(ownBaseline ?? session.firstSnapshot ?? lastScreen) : {};
    return ok({ ...result, jevTokens: session.tokens - tokensBefore, ...changed });
  }));

  /**
   * The step as written, except a literal typed into a secure text field, or a value that was typed into one before
   * (a confirm field that is not secure): that becomes an `${env.*}` placeholder (SecretNames in src/core/save.ts).
   */
  async function asSaved(step: Record<string, unknown>, parsed: { kind: string; value?: string }): Promise<Record<string, unknown>> {
    if (parsed.kind !== 'fill') return step;
    return secrets.savedFill(step, parsed.value, () => session.filledSecret);
  }

  server.registerTool('find', {
    description: config.describe.find,
    inputSchema: { kind: z.enum(config.kinds), target: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, ({ kind, target }) => queue(async () => {
    requireOpen();
    // An approximate capture could report a covered element as found. A region find is exact anyway: only claim
    // regions are picked approximately, and asking would make the next step's target capture exact for nothing.
    if (kind !== 'region') adapter.preferExact?.();
    const [resolved] = await session.find(kind, [withPlaceholders(target)]);
    return ok({ found: resolved.element !== null, detail: resolved.detail, confidence: resolved.confidence, jevTokens: resolved.tokens });
  }));

  server.registerTool('snapshot', {
    description: config.describe.snapshot + SNAPSHOT_MODES_DESCRIPTION,
    inputSchema: { within: z.string().optional(), ...SnapshotOptions },
    annotations: { readOnlyHint: true },
  }, ({ within, maxChars, mode, intent }) => queue(async () => {
    requireOpen();
    const started = performance.now();
    const tokensBefore = session.tokens;
    const snap = await session.snapshot(withOptionalPlaceholders(within));
    const view = await snapshotView(snap, { maxChars, mode, intent }, ai.describe);
    const usage = mode !== 'raw' && 'jevTokens' in view ? {
      jevTokens: view.jevTokens === null ? null : view.jevTokens + session.tokens - tokensBefore,
      ms: { ...view.ms, total: performance.now() - started },
    } : {};
    return ok({ ...view, ...usage });
  }));

  server.registerTool('ask', {
    description: ASK_DESCRIPTION,
    inputSchema: { claims: AskClaims, within: z.string().min(1).optional() },
    annotations: { readOnlyHint: true },
  }, ({ claims, within }) => queue(async () => {
    requireOpen();
    const tokensBefore = session.tokens;
    const { snapshot, probabilities, ms } = await session.ask(withPlaceholders(claims), withOptionalPlaceholders(within));
    return ok({ ...askResult(claims, probabilities, snapshot), jevTokens: session.tokens - tokensBefore, ms });
  }));

  if (READ_ENABLED) server.registerTool('read', {
    description: READ_DESCRIPTION,
    inputSchema: { question: z.string().min(1), within: z.string().min(1).optional() },
    annotations: { readOnlyHint: true },
  }, ({ question, within }) => queue(async () => {
    requireOpen();
    const started = performance.now();
    const tokensBefore = session.tokens;
    const { tokens: _, ...answer } = await session.read(withPlaceholders(question), withOptionalPlaceholders(within));
    return ok({ ...answer, jevTokens: session.tokens - tokensBefore, ms: Math.round(performance.now() - started) });
  }));

  server.registerTool('screenshot', {
    description: config.describe.screenshot,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => queue(async () => {
    requireOpen();
    return { content: [{ type: 'image' as const, mimeType: 'image/png', data: (await adapter.screenshot()).toString('base64') }] };
  }));

  server.registerTool('save', {
    description: config.describe.save,
    inputSchema: { path: z.string().min(1), name: z.string().min(1).optional() },
  }, ({ path, name }) => queue(async () => {
    requireOpen();
    const file = resolve(path);
    const env = secrets.env();
    const doc = {
      name: name ?? spec.name,
      ...config.saved(spec),
      ...(spec.goal ? { goal: spec.goal } : {}),
      ...(spec.hooks ? { hooks: relative(dirname(file), spec.hooks) } : {}),
      ...env,
      steps: transcript,
    };
    const lock = writeSaved(file, doc, recorder.recorded);
    return ok({ path: file, steps: transcript.length, ...lock, ...env });
  }));

  server.registerTool('close', { description: config.describe.close, inputSchema: {} }, () => queue(async () => {
    await close();
    return ok({ closed: true });
  }));

  return { server, close: () => queue(close) };
}

export async function serveNative({ server, close }: { server: McpServer; close: () => Promise<void> }) {
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    try {
      await close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    await server.close();
  }
  server.server.onclose = () => void shutdown();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void shutdown());
  // The SDK's stdio transport does not close on end of input, and a host's signal does not always arrive: under
  // npx, a shell sits between the host and this process. A closed input means the host is gone.
  process.stdin.once('end', () => void shutdown());
  await server.connect(new StdioServerTransport());
}
