import { ask } from './ask.js';

/** One Noul question per claim, all in one request. `longContext` is the TypeSafe retry for a cut page. */
export async function judge(state: unknown, claims: string[], options?: { longContext?: boolean }): Promise<{ probabilities: number[]; tokens: number }> {
  const { tokens, answers } = await ask(state, claims.map((claim) => ({ kind: 'boolean', instructions: claim })),
    options?.longContext ? { longContext: true } : undefined);
  return { probabilities: answers.map((answer) => answer.probability ?? 0), tokens };
}
