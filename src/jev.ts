import { experimental_evaluate as evaluate } from 'ai';
import { TypeSafeClient, noul, choice } from '@typesafe-ai/sdk';
import type { Candidate } from './page.js';

export type Provider = 'typesafe' | 'gateway';

export const MODEL_BY_PROVIDER: Record<Provider, string> = {
  typesafe: 'jev-latest',
  gateway: 'typesafe-ai/jev',
};

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

export function provider(): Provider {
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

// ponytail: TypeSafeClient's APIError exposes `status`; cast past the plain Error type to read it.
function httpStatus(err: unknown): number | undefined {
  const status = (err as any)?.status;
  return typeof status === 'number' ? status : undefined;
}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  // Upstream 5xx cluster on the largest payloads (≈15–20k tokens), so allow three retries with doubling
  // backoff (10s, 20s, 40s); a rate limit gets one wait of a full window.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const status = httpStatus(err);
      const rateLimited = /rate.?limit/i.test(msg) || status === 429;
      const upstream = /temporarily unavailable|internal server/i.test(msg) || (typeof status === 'number' && status >= 500);
      if (rateLimited && attempt === 0) await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
      else if (upstream && attempt < 3) await new Promise((r) => setTimeout(r, UPSTREAM_BACKOFF_MS * 2 ** attempt));
      else throw err;
    }
  }
}

// The 422 body shape for a too-long TypeSafe request is a best-effort guess, not confirmed against
// a live too-long TypeSafe response — matching on status + keyword is what's checkable without one.
export function isTooLong(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/max_tokens_exceeded/.test(err.message)) return true;
  return httpStatus(err) === 422 && /max_tokens_exceeded|too (long|large)|token/i.test(err.message);
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

// Raw shape an answer comes back in from either backend, before ask() normalizes it.
interface RawAnswer {
  choice?: string;
  probabilities?: Record<string, number>;
  probability?: number;
  noul?: number;
}

async function callGateway(
  state: unknown,
  question: ChoiceQuestion | BooleanQuestion
): Promise<{ answer: RawAnswer; tokens: number }> {
  const { answers, usage } = await evaluate({
    model: MODEL_BY_PROVIDER.gateway,
    // ponytail: state is plain JSON at runtime; the SDK's JSONObject type wants an index
    // signature that our named interfaces don't declare, so cast past it here.
    state: state as any,
    questions: {
      [question.name]:
        question.kind === 'choice'
          ? { type: 'choice', instructions: question.instructions, criteria: question.criteria }
          : { type: 'boolean', instructions: question.instructions },
    },
  });
  const answer = (answers as Record<string, RawAnswer>)[question.name];
  return { answer, tokens: usage.totalTokens ?? 0 };
}

async function callTypesafe(
  state: unknown,
  question: ChoiceQuestion | BooleanQuestion
): Promise<{ answer: RawAnswer; tokens: number }> {
  const { answers, usage } = await typesafe().systemOne({
    model: MODEL_BY_PROVIDER.typesafe,
    state: state as any,
    questions: {
      [question.name]:
        question.kind === 'choice' ? choice(question.instructions, question.criteria) : noul(question.instructions),
    },
  });
  const answer = (answers as Record<string, RawAnswer>)[question.name];
  return { answer, tokens: usage.input_tokens + usage.output_tokens };
}

// The one call path both pickElement and judge go through: builds a provider-neutral question,
// dispatches on the resolved provider, and normalizes the answer shape the two backends disagree on.
async function ask(state: unknown, question: ChoiceQuestion | BooleanQuestion): Promise<AskResult> {
  const { answer, tokens } = await withRateLimitRetry(() =>
    provider() === 'gateway' ? callGateway(state, question) : callTypesafe(state, question)
  );
  return question.kind === 'choice'
    ? { tokens, choice: answer.choice, probabilities: answer.probabilities ?? {} }
    : { tokens, probability: answer.probability ?? answer.noul };
}

// Hard ceiling: a Jev Choice question accepts at most 255 options, one of which is `none`. Selector-matched
// elements are listed first, cursor:pointer extras last, so a dense page loses extras, not real controls.
// ponytail: no pagination — if the real controls alone exceed this, target the step with css= instead.
export const MAX_PICK_CANDIDATES = 254;

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

// One-shot: the too-long-state halving retry lives in runner.ts's judgeSnapshot, which knows the
// Snapshot shape and can re-derive `aria` for the next attempt. Errors here propagate to the caller.
export async function judge(state: unknown, expectation: string): Promise<JudgeResult> {
  const { probability, tokens } = await ask(state, { kind: 'boolean', name: 'holds', instructions: expectation });
  return { probability: probability ?? 0, tokens };
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
