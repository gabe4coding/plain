import { experimental_evaluate as evaluate } from 'ai';
import type { Candidate } from './page.js';

const MODEL = 'typesafe-ai/jev';

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
      const rateLimited = /rate.?limit/i.test(msg);
      const upstream = /temporarily unavailable|internal server/i.test(msg);
      if (rateLimited && attempt === 0) await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
      else if (upstream && attempt < 3) await new Promise((r) => setTimeout(r, UPSTREAM_BACKOFF_MS * 2 ** attempt));
      else throw err;
    }
  }
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

  const { answers, usage } = await withRateLimitRetry(() =>
    evaluate({
      model: MODEL,
      // ponytail: state is plain JSON at runtime; the SDK's JSONObject type wants an index
      // signature that our named interfaces don't declare, so cast past it here.
      // `today` lets instructions like "the earliest day after today" have one answer instead of many.
      state: { instruction, today: new Date().toISOString().slice(0, 10), elements: candidates } as any,
      questions: {
        pick: {
          type: 'choice',
          instructions: 'Which element does the instruction refer to? Pick `none` if no element matches.',
          criteria,
        },
      },
    })
  );

  const a = answers.pick;
  const id = a.choice === 'none' ? null : Number(a.choice);
  const probability = a.probabilities?.[a.choice] ?? 0;
  return { id, probability, probabilities: a.probabilities ?? {}, tokens: usage.totalTokens ?? 0 };
}

export interface JudgeResult {
  probability: number;
  tokens: number;
}

export async function judge(state: unknown, expectation: string): Promise<JudgeResult> {
  const ask = (s: unknown) =>
    withRateLimitRetry(() =>
      evaluate({
        model: MODEL,
        state: s as any,
        questions: {
          holds: { type: 'boolean', instructions: expectation },
        },
      })
    );
  let s = state as { aria?: string } & Record<string, unknown>;
  for (;;) {
    try {
      const { answers, usage } = await ask(s);
      return { probability: answers.holds.probability, tokens: usage.totalTokens ?? 0 };
    } catch (err) {
      // A char cap can't guarantee the model's token limit (dense tables ≈ 2x tokens per char): halve and retry.
      const tooLong = err instanceof Error && /max_tokens_exceeded/.test(err.message);
      if (!tooLong || typeof s.aria !== 'string' || s.aria.length < 4000) throw err;
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
