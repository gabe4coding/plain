import { z } from 'zod';
import { experimental_evaluate as evaluate, APICallError } from 'ai';
import { TypeSafeClient, UnprocessableEntityError, noul, choice } from '@typesafe-ai/sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const ProviderSchema = z.enum(['typesafe', 'gateway']);
// One documented place for a key, read by the CLI and by both plugin hosts (src/cli.ts loads it after the cwd .env).
// It exists because Codex passes plugin MCP servers no shell environment at all.
export const USER_ENV_FILE = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'plainwright', '.env');
export const MODEL_BY_PROVIDER = {
    // Pinned: decide()'s thresholds and the README's phrasing rules were tuned against this
    // version. `jev-latest` resolved to 1.13.0 as of 2026-09-19 — bump deliberately, re-tune after.
    typesafe: 'jev-1.13.0',
    gateway: 'typesafe-ai/jev',
};
export function selectProvider(env = process.env) {
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
    if (env.TYPESAFE_API_KEY)
        return 'typesafe';
    if (env.AI_GATEWAY_API_KEY)
        return 'gateway';
    throw new Error('Set TYPESAFE_API_KEY (TypeSafe direct) or AI_GATEWAY_API_KEY (Vercel AI Gateway) in the environment, ' +
        `in ${USER_ENV_FILE}, or in a .env file in the current directory.`);
}
// Resolved and built lazily so a unit test importing this module never needs a key set.
let cachedProvider;
let typesafeClient;
export function provider() {
    if (!cachedProvider)
        cachedProvider = selectProvider();
    return cachedProvider;
}
function typesafe() {
    if (!typesafeClient) {
        typesafeClient = new TypeSafeClient({
            apiKey: process.env.TYPESAFE_API_KEY,
            // Per attempt. The SDK default is 10 s; large picks (~20k tokens) have taken 17–49 s live.
            timeout: 60_000,
            // The SDK already retries 408/429/5xx (incl. 529 Overloaded) with jittered backoff and honors
            // Retry-After. Widened so a free-tier rate-limit window (~60 s) and 5xx bursts are outlasted.
            retry: { maxRetries: 4, backoffInitialMs: 10_000, backoffMaxMs: 65_000, maxRetryAfterMs: 65_000 },
        });
    }
    return typesafeClient;
}
// ponytail: the free-tier gateway rate-limits bursts of calls; the SDK's own retries are too
// quick to outlast that window, so wait out one window and try again. Drop this once on a paid
// tier, or replace with real backoff/jitter if a bigger suite still trips it.
const RATE_LIMIT_BACKOFF_MS = 65_000;
const UPSTREAM_BACKOFF_MS = 10_000; // gateway 5xx "temporarily unavailable": the SDK's own retries are seconds apart
// The gateway path (Vercel AI SDK) keeps its own retry loop: its backoff is seconds-scale and
// can't outlast a free-tier rate-limit window (~60s) or a 5xx burst the way the TypeSafe SDK's
// own retry policy (configured above, seen by callTypesafe only) can. Used only around
// callGateway — callTypesafe relies entirely on the client's built-in retries.
async function withGatewayRetry(fn) {
    // Upstream 5xx cluster on the largest payloads (≈15–20k tokens), so allow three retries with doubling
    // backoff (10s, 20s, 40s); a rate limit gets one wait of a full window.
    for (let attempt = 0;; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            const status = APICallError.isInstance(err) ? err.statusCode : undefined;
            const msg = err instanceof Error ? err.message : '';
            const rateLimited = status === 429 || /rate.?limit/i.test(msg);
            const upstream = (typeof status === 'number' && status >= 500) || /temporarily unavailable|internal server/i.test(msg);
            if (rateLimited && attempt === 0)
                await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
            else if (upstream && attempt < 3)
                await new Promise((r) => setTimeout(r, UPSTREAM_BACKOFF_MS * 2 ** attempt));
            else
                throw err;
        }
    }
}
export function isTooLong(err) {
    if (err instanceof UnprocessableEntityError) {
        // ponytail: the too-long 422 body is undocumented (the docs only give the limits: 64k tokens per
        // request, 32k for state + longest question). Match status + keyword until a live sample confirms it.
        return /max_tokens_exceeded|too (long|large)|token/i.test(JSON.stringify(err.body ?? err.message));
    }
    return err instanceof Error && /max_tokens_exceeded/.test(err.message); // gateway wording, seen live
}
export const QuestionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('choice'), instructions: z.string(), criteria: z.record(z.string(), z.string()) }),
    z.object({ kind: z.literal('boolean'), instructions: z.string() }),
]);
// Raw shape an answer comes back in from either backend, before ask() normalizes it. `confidence`
// only ever comes from a Choice answer (TypeSafe's `ChoiceResponse`); carried through, not decided on.
export const AskAnswerSchema = z.object({
    choice: z.string().optional(),
    probabilities: z.record(z.string(), z.number()).optional(),
    probability: z.number().optional(),
    confidence: z.number().optional(),
});
const RawAnswerSchema = AskAnswerSchema.extend({ noul: z.number().optional() });
const RawAnswersSchema = z.record(z.string(), RawAnswerSchema);
async function callGateway(state, questions) {
    const keys = questions.map((_, i) => `q${i}`);
    const { answers, usage } = await evaluate({
        model: MODEL_BY_PROVIDER.gateway,
        // ponytail: state is plain JSON at runtime; the SDK's JSONObject type wants an index
        // signature that our named interfaces don't declare, so cast past it here.
        state: state,
        questions: Object.fromEntries(questions.map((q, i) => [
            keys[i],
            q.kind === 'choice'
                ? { type: 'choice', instructions: q.instructions, criteria: q.criteria }
                : { type: 'boolean', instructions: q.instructions },
        ])),
    });
    const raw = RawAnswersSchema.parse(answers);
    return { answers: keys.map((k) => raw[k]), tokens: usage.totalTokens ?? 0 };
}
async function callTypesafe(state, questions) {
    const keys = questions.map((_, i) => `q${i}`);
    const { answers, usage } = await typesafe().systemOne({
        model: MODEL_BY_PROVIDER.typesafe,
        state: state,
        questions: Object.fromEntries(questions.map((q, i) => [keys[i], q.kind === 'choice' ? choice(q.instructions, q.criteria) : noul(q.instructions)])),
    });
    const raw = RawAnswersSchema.parse(answers);
    return { answers: keys.map((k) => raw[k]), tokens: usage.input_tokens + usage.output_tokens };
}
// The one call path pickElements and judge both go through: dispatches on the resolved provider
// and normalizes the answer shape the two backends disagree on, in request order.
async function ask(state, questions) {
    const { answers, tokens } = provider() === 'gateway' ? await withGatewayRetry(() => callGateway(state, questions)) : await callTypesafe(state, questions);
    return {
        tokens,
        answers: answers.map((answer, i) => questions[i].kind === 'choice'
            ? { choice: answer.choice, probabilities: answer.probabilities ?? {}, confidence: answer.confidence }
            : { probability: answer.probability ?? answer.noul, confidence: answer.confidence }),
    };
}
// A Jev Choice question accepts at most 255 options, one of which is `none`. More candidates than this are
// split into equal chunks, one request each, in parallel (see pickElements).
export const MAX_PICK_CANDIDATES = 254;
// Hard ceiling on what the page walker hands over: 4 parallel requests per pick. page.ts orders candidates
// (dialog first, nav/footer last) so a page past this loses link farms, not controls.
// ponytail: past this, target the step with css= or scope it with `within`.
export const MAX_CANDIDATES = MAX_PICK_CANDIDATES * 4;
export const PickResultSchema = z.object({
    id: z.number().nullable(),
    probability: z.number(), // p of the chosen option
    confidence: z.number().optional(), // TypeSafe Choice confidence; absent on the gateway path
    probabilities: z.record(z.string(), z.number()), // option key → p
    tokens: z.number(), // whole-request tokens on the FIRST result, 0 on the others
});
// One Choice question per instruction, all sharing the same criteria and one request. Descriptions
// are deliberately sent twice (state.elements and criteria). Measured 2026-09-19 with them only in
// criteria: pick tokens -40% on a 192-candidate page, but pick p -0.05 on average and up to -0.33;
// for a test tool a wrong pick costs more than the tokens.
async function pickChunk(candidates, instructions, page) {
    const criteria = { none: 'No listed element matches the instruction' };
    for (const c of candidates)
        criteria[String(c.id)] = c.desc;
    // `instructions` as a list (not folded into each question's text) plus `today` lets a step like
    // "the earliest day after today" have one answer instead of one per instruction wording.
    const state = {
        url: page.url,
        title: page.title,
        today: new Date().toISOString().slice(0, 10),
        instructions,
        elements: candidates,
    };
    const questions = instructions.map((_, i) => ({
        kind: 'choice',
        instructions: `Which element does \`instructions[${i}]\` refer to? Pick \`none\` if no listed element matches.`,
        criteria,
    }));
    const { tokens, answers } = await ask(state, questions);
    return answers.map((answer, i) => {
        const { choice: picked, probabilities, confidence } = answer;
        const id = picked === 'none' ? null : Number(picked);
        const probability = probabilities?.[picked] ?? 0;
        return { id, probability, confidence, probabilities: probabilities ?? {}, tokens: i === 0 ? tokens : 0 };
    });
}
// Up to MAX_PICK_CANDIDATES: one request, as before. Past it: equal chunks, one request each, run in
// parallel so a dense page costs one round trip (and one request's tokens per chunk), then merged.
export async function pickElements(candidates, instructions, page) {
    if (candidates.length <= MAX_PICK_CANDIDATES)
        return pickChunk(candidates, instructions, page);
    const chunkCount = Math.ceil(candidates.length / MAX_PICK_CANDIDATES);
    const size = Math.ceil(candidates.length / chunkCount);
    const chunks = Array.from({ length: chunkCount }, (_, i) => candidates.slice(i * size, (i + 1) * size));
    return mergePicks(await Promise.all(chunks.map((chunk) => pickChunk(chunk, instructions, page))));
}
// Merges per-chunk answers into one PickResult per instruction. Candidate ids are page-global, so the
// probability maps combine cleanly; `none` is taken from the chunk whose answer wins. When several chunks
// are each sure of a different element, a single question would have split the probability between them
// and stayed below the acceptance threshold — reproduce that split so decide() still says inconclusive
// and the detail shows both guesses.
export function mergePicks(perChunk) {
    const score = (a) => a.confidence ?? a.probability;
    const tokens = perChunk.reduce((sum, results) => sum + results[0].tokens, 0);
    return perChunk[0].map((_, i) => {
        const answers = perChunk.map((results) => results[i]);
        const found = answers.filter((a) => a.id !== null).sort((a, b) => score(b) - score(a));
        // All `none`: the least sure chunk has the most telling top guesses for the detail line.
        const best = found[0] ?? [...answers].sort((a, b) => score(a) - score(b))[0];
        const probabilities = {};
        for (const a of answers)
            for (const [k, p] of Object.entries(a.probabilities))
                if (k !== 'none')
                    probabilities[k] = p;
        probabilities.none = best.probabilities.none ?? 0;
        const split = Math.max(1, found.filter((a) => decide(score(a), 'pick') === 'pass').length);
        return {
            id: best.id,
            probability: best.probability / split,
            confidence: best.confidence === undefined ? undefined : best.confidence / split,
            probabilities,
            tokens: i === 0 ? tokens : 0,
        };
    });
}
// One Noul per claim, one request. The too-long-state halving retry lives in steps.ts's
// judgeSnapshot, which knows the Snapshot shape and can re-derive `aria` for the next attempt.
// Errors here propagate to the caller.
export async function judge(state, claims) {
    const { tokens, answers } = await ask(state, claims.map((c) => ({ kind: 'boolean', instructions: c })));
    return { probabilities: answers.map((a) => a.probability ?? 0), tokens };
}
export const DecisionSchema = z.enum(['pass', 'fail', 'inconclusive']);
// ponytail: fixed thresholds, make them CLI flags if a real suite needs tuning
const EXPECT_PASS = 0.9;
const EXPECT_FAIL = 0.1;
const PICK_ACCEPT = 0.5;
export function decide(p, kind) {
    if (kind === 'expect') {
        if (p >= EXPECT_PASS)
            return 'pass';
        if (p <= EXPECT_FAIL)
            return 'fail';
        return 'inconclusive';
    }
    return p >= PICK_ACCEPT ? 'pass' : 'inconclusive';
}
