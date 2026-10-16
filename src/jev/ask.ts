import { z } from 'zod';
import { TypeSafeClient, UnprocessableEntityError, BadRequestError, noul, choice } from '@typesafe-ai/sdk';
import { Agent, setGlobalDispatcher } from 'undici';
import { apiKey, MODEL_BY_PROVIDER, provider } from './provider.js';

// Node's default pool drops a connection after 4 s idle, and the next model calls on a new connection are
// ~350 ms slower. Idle sockets are unref'd, so they never keep the process alive.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }));

export type Question =
  | { kind: 'choice'; instructions: string; criteria: Record<string, string> }
  | { kind: 'boolean'; instructions: string };

/** An answer from either provider. `confidence` comes only with a TypeSafe Choice answer. */
export const AskAnswerSchema = z.object({
  choice: z.string().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  probability: z.number().optional(),
  confidence: z.number().optional(),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export interface Answers { tokens: number; answers: AskAnswer[] }

/** A Choice question takes 255 options, and one of them is `none`. */
export const MAX_CHOICE_OPTIONS = 254;

/** Equal chunks of at most MAX_CHOICE_OPTIONS items: one Choice question each. */
export function choiceChunks<T>(items: T[]): T[][] {
  const chunkCount = Math.ceil(items.length / MAX_CHOICE_OPTIONS);
  const size = Math.ceil(items.length / chunkCount);
  return Array.from({ length: chunkCount }, (_, i) => items.slice(i * size, (i + 1) * size));
}

/** One Jev request. The answers come back in question order and in the same shape for both providers. */
export async function ask(state: unknown, questions: Question[]): Promise<Answers> {
  const { answers, tokens } = provider() === 'gateway'
    ? await withGatewayRetry(() => callGateway(state, questions))
    : await callTypesafe(state, questions);
  return {
    tokens,
    answers: answers.map((answer, i) =>
      questions[i].kind === 'choice'
        ? { choice: answer.choice, probabilities: answer.probabilities ?? {}, confidence: answer.confidence }
        : { probability: answer.probability ?? answer.noul, confidence: answer.confidence }
    ),
  };
}

/** The request is over the model's token limit: a smaller state may pass, a retry of the same one never does. */
export function isTooLong(error: unknown): boolean {
  if (error instanceof UnprocessableEntityError) {
    return /max_tokens_exceeded|too (long|large)|token/i.test(JSON.stringify(error.body ?? error.message));
  }
  // Any other 400 is a malformed request, which a smaller state cannot fix.
  if (error instanceof BadRequestError) return /"error_type":"max_tokens_exceeded"/.test(JSON.stringify(error.body ?? {}));
  return error instanceof Error && /max_tokens_exceeded/.test(error.message);
}

/**
 * Sends two tiny questions while the browser launches, so the first real calls find warm connections: only a
 * model request removes the first-call delay, not a plain GET. Two, because back-to-back calls use two
 * connections. Fire and forget: no retries, a short timeout, and a failure costs nothing.
 */
export function warmUp(): void {
  let chosen;
  try {
    chosen = provider();
  } catch {
    return; // no key: the first real call reports it
  }
  const questions: Question[] = [{ kind: 'boolean', instructions: 'The state is empty.' }];
  for (let i = 0; i < 2; i++) {
    const call = chosen === 'typesafe'
      ? callTypesafe({}, questions, { retry: { maxRetries: 0 }, timeout: 10_000 })
      : callGateway({}, questions);
    call.catch(() => {});
  }
}

const RawAnswerSchema = AskAnswerSchema.extend({ noul: z.number().optional() });
const RawAnswersSchema = z.record(z.string(), RawAnswerSchema);
type RawAnswer = z.infer<typeof RawAnswerSchema>;
interface RawAnswers { answers: RawAnswer[]; tokens: number }

const questionKeys = (questions: Question[]) => questions.map((_, i) => `q${i}`);

function inKeyOrder(keys: string[], answers: unknown): RawAnswer[] {
  const byKey = RawAnswersSchema.parse(answers);
  return keys.map((key) => byKey[key]);
}

let typesafeClient: TypeSafeClient | undefined;

function typesafe(): TypeSafeClient {
  return (typesafeClient ??= new TypeSafeClient({
    apiKey: apiKey('typesafe'),
    timeout: 60_000, // per attempt: large picks have taken up to 49 s
    // The SDK retries 408/429/5xx and honors Retry-After; widened to outlast a free-tier rate-limit window.
    retry: { maxRetries: 4, backoffInitialMs: 10_000, backoffMaxMs: 65_000, maxRetryAfterMs: 65_000 },
  }));
}

async function callTypesafe(state: unknown, questions: Question[],
  options?: Parameters<TypeSafeClient['systemOne']>[1]): Promise<RawAnswers> {
  const keys = questionKeys(questions);
  const { answers, usage } = await typesafe().systemOne({
    model: MODEL_BY_PROVIDER.typesafe,
    state: state as any,
    questions: Object.fromEntries(questions.map((question, i) => [
      keys[i],
      question.kind === 'choice' ? choice(question.instructions, question.criteria) : noul(question.instructions),
    ])),
  }, options);
  return { answers: inKeyOrder(keys, answers), tokens: usage.input_tokens + usage.output_tokens };
}

async function callGateway(state: unknown, questions: Question[]): Promise<RawAnswers> {
  const keys = questionKeys(questions);
  const { experimental_evaluate: evaluate } = await import('ai'); // only the gateway needs the AI SDK
  const { answers, usage } = await evaluate({
    model: MODEL_BY_PROVIDER.gateway,
    state: state as any, // plain JSON; the SDK's JSONObject type wants an index signature
    questions: Object.fromEntries(questions.map((question, i) => [
      keys[i],
      question.kind === 'choice'
        ? { type: 'choice', instructions: question.instructions, criteria: question.criteria }
        : { type: 'boolean', instructions: question.instructions },
    ])),
  });
  return { answers: inKeyOrder(keys, answers), tokens: usage.totalTokens ?? 0 };
}

const RATE_LIMIT_WAIT_MS = 65_000;
const UPSTREAM_ERROR_WAIT_MS = 10_000;
const UPSTREAM_ERROR_RETRIES = 3;

/** The AI SDK's own retries are seconds apart: too short for a rate-limit window or a burst of 5xx errors. */
async function withGatewayRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const { APICallError } = await import('ai');
      const status = APICallError.isInstance(error) ? error.statusCode : undefined;
      const message = error instanceof Error ? error.message : '';
      const rateLimited = status === 429 || /rate.?limit/i.test(message);
      const upstreamError = (typeof status === 'number' && status >= 500) || /temporarily unavailable|internal server/i.test(message);
      if (rateLimited && attempt === 0) await sleep(RATE_LIMIT_WAIT_MS);
      else if (upstreamError && attempt < UPSTREAM_ERROR_RETRIES) await sleep(UPSTREAM_ERROR_WAIT_MS * 2 ** attempt);
      else throw error;
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
