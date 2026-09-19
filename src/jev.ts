import { experimental_evaluate as evaluate } from 'ai';
import { TypeSafeClient, noul, choice } from '@typesafe-ai/sdk';
import type { Candidate } from './page.js';

export const GATEWAY_MODEL = 'typesafe-ai/jev';
export const TYPESAFE_MODEL = 'jev-latest';

export type Provider = 'typesafe' | 'gateway';

export function selectProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  const requested = env.JEV_PROVIDER;
  if (requested !== undefined) {
    if (requested !== 'typesafe' && requested !== 'gateway') {
      throw new Error(`JEV_PROVIDER must be "typesafe" or "gateway", got "${requested}".`);
    }
    if (requested === 'typesafe' && !env.TYPESAFE_API_KEY) {
      throw new Error('JEV_PROVIDER=typesafe requires TYPESAFE_API_KEY to be set.');
    }
    if (requested === 'gateway' && !env.AI_GATEWAY_API_KEY) {
      throw new Error('JEV_PROVIDER=gateway requires AI_GATEWAY_API_KEY to be set.');
    }
    return requested;
  }
  if (env.TYPESAFE_API_KEY) return 'typesafe';
  if (env.AI_GATEWAY_API_KEY) return 'gateway';
  throw new Error(
    'Set TYPESAFE_API_KEY (TypeSafe direct) or AI_GATEWAY_API_KEY (Vercel AI Gateway), ' +
      'in the environment or in a .env file next to where you run the CLI.'
  );
}

// Resolved and built lazily so a unit test importing this module never needs a key set.
let cachedProvider: Provider | undefined;
let typesafeClient: TypeSafeClient | undefined;

function provider(): Provider {
  if (!cachedProvider) cachedProvider = selectProvider();
  return cachedProvider;
}

function typesafe(): TypeSafeClient {
  if (!typesafeClient) typesafeClient = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY });
  return typesafeClient;
}

// ponytail: the free-tier gateway rate-limits bursts of calls; the SDK's own retries are too
// quick to outlast that window, so wait out one window and try again. Drop this once on a paid
// tier, or replace with real backoff/jitter if a bigger suite still trips it.
const RATE_LIMIT_BACKOFF_MS = 65_000;

const UPSTREAM_BACKOFF_MS = 10_000; // gateway 5xx "temporarily unavailable": the SDK's own retries are seconds apart

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  // Upstream 5xx cluster on the largest payloads (≈15–20k tokens), so allow three retries with doubling
  // backoff (10s, 20s, 40s); a rate limit gets one wait of a full window.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      // ponytail: TypeSafeClient's APIError exposes `status`; cast past the plain Error type to read it.
      const status = (err as any)?.status;
      const rateLimited = /rate.?limit/i.test(msg) || status === 429;
      const upstream = /temporarily unavailable|internal server/i.test(msg) || (typeof status === 'number' && status >= 500);
      if (rateLimited && attempt === 0) await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
      else if (upstream && attempt < 3) await new Promise((r) => setTimeout(r, UPSTREAM_BACKOFF_MS * 2 ** attempt));
      else throw err;
    }
  }
}

// A too-long TypeSafe body isn't confirmed against a live call (no key available while writing this);
// matching on 422 + keyword is a best-effort guess — see RISKS in the handoff report.
function isTooLong(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/max_tokens_exceeded/.test(err.message)) return true;
  const status = (err as any)?.status;
  return status === 422 && /max_tokens_exceeded|too (long|large)|token/i.test(err.message);
}

interface ChoiceQuestion {
  kind: 'choice';
  name: string;
  instructions: string;
  criteria: Record<string, string>;
}
interface BooleanQuestion {
  kind: 'boolean';
  name: string;
  instructions: string;
}

interface AskResult {
  tokens: number;
  choice?: string;
  probabilities?: Record<string, number>;
  probability?: number;
}

// The one call path both pickElement and judge go through: builds a provider-neutral question,
// dispatches on the resolved provider, and normalizes the answer shape the two backends disagree on.
async function ask(state: unknown, question: ChoiceQuestion | BooleanQuestion): Promise<AskResult> {
  if (provider() === 'gateway') {
    const { answers, usage } = await withRateLimitRetry(() =>
      evaluate({
        model: GATEWAY_MODEL,
        // ponytail: state is plain JSON at runtime; the SDK's JSONObject type wants an index
        // signature that our named interfaces don't declare, so cast past it here.
        state: state as any,
        questions: {
          [question.name]:
            question.kind === 'choice'
              ? { type: 'choice', instructions: question.instructions, criteria: question.criteria }
              : { type: 'boolean', instructions: question.instructions },
        },
      })
    );
    const a = (answers as any)[question.name];
    const tokens = usage.totalTokens ?? 0;
    return question.kind === 'choice'
      ? { tokens, choice: a.choice, probabilities: a.probabilities ?? {} }
      : { tokens, probability: a.probability };
  }

  const { answers, usage } = await withRateLimitRetry(() =>
    typesafe().systemOne({
      model: TYPESAFE_MODEL,
      state: state as any,
      questions: {
        [question.name]:
          question.kind === 'choice' ? choice(question.instructions, question.criteria) : noul(question.instructions),
      },
    })
  );
  const a = (answers as any)[question.name];
  const tokens = usage.input_tokens + usage.output_tokens;
  return question.kind === 'choice'
    ? { tokens, choice: a.choice, probabilities: a.probabilities ?? {} }
    : { tokens, probability: a.noul };
}

export interface PickResult {
  id: number | null;
  probability: number;
  probabilities: Record<string, number>; // option key ('none' or candidate id) → p
  tokens: number;
}

export async function pickElement(candidates: Candidate[], instruction: string): Promise<PickResult> {
  const criteria: Record<string, string> = { none: 'No listed element matches the instruction' };
  for (const c of candidates) criteria[String(c.id)] = c.desc;

  // `today` lets instructions like "the earliest day after today" have one answer instead of many.
  const state = { instruction, today: new Date().toISOString().slice(0, 10), elements: candidates };
  const { choice: picked, probabilities, tokens } = await ask(state, {
    kind: 'choice',
    name: 'pick',
    instructions: 'Which element does the instruction refer to? Pick `none` if no element matches.',
    criteria,
  });

  const id = picked === 'none' ? null : Number(picked);
  const probability = probabilities?.[picked!] ?? 0;
  return { id, probability, probabilities: probabilities ?? {}, tokens };
}

export interface JudgeResult {
  probability: number;
  tokens: number;
}

export async function judge(state: unknown, expectation: string): Promise<JudgeResult> {
  let s = state as { aria?: string } & Record<string, unknown>;
  for (;;) {
    try {
      const { probability, tokens } = await ask(s, { kind: 'boolean', name: 'holds', instructions: expectation });
      return { probability: probability ?? 0, tokens };
    } catch (err) {
      // A char cap can't guarantee the model's token limit (dense tables ≈ 2x tokens per char): halve and retry.
      if (!isTooLong(err) || typeof s.aria !== 'string' || s.aria.length < 4000) throw err;
      const half = s.aria.slice(0, Math.floor(s.aria.length / 2));
      s = { ...s, aria: half };
      console.error(`jev-e2e: state too long for the model, aria cut to ${half.length} chars — scope the expect with \`within\` for precision`);
    }
  }
}

export type Decision = 'pass' | 'fail' | 'inconclusive';

// ponytail: fixed thresholds, make them CLI flags if a real suite needs tuning
const EXPECT_PASS = 0.9;
const EXPECT_FAIL = 0.1;
const PICK_ACCEPT = 0.5;

export function decide(p: number, kind: 'expect' | 'pick'): Decision {
  if (kind === 'expect') {
    if (p >= EXPECT_PASS) return 'pass';
    if (p <= EXPECT_FAIL) return 'fail';
    return 'inconclusive';
  }
  return p >= PICK_ACCEPT ? 'pass' : 'inconclusive';
}
