// Shared test fake; the .test name keeps it out of the package (package.json "files" skips *.test.js).
import type { Intelligence } from './automation.js';

/**
 * Jev without a key: each target picks candidate 0 at 0.95 (10 tokens, all on the first target), each claim
 * passes at 0.95 (7 tokens), and a smart snapshot sees an 'other' screen (100 tokens). `overrides` replace single
 * calls. There is no `ask` unless an override gives one, so no prompt is routed.
 */
export function fakeIntelligence(overrides: Partial<Intelligence> = {}): Intelligence {
  return {
    pick: async (_candidates, targets) => targets.map((_, i) => ({ id: 0, probability: .95, probabilities: { '0': .95 }, tokens: i === 0 ? 10 : 0 })),
    judge: async (_state, claims) => ({ probabilities: claims.map(() => .95), tokens: 7 }),
    describe: async () => ({ screen: { type: 'other', probability: .99, confidence: .99 }, signals: {}, relevance: [], tokens: 100 }),
    ...overrides,
  };
}

/** Jev for a run that must make no model call: pick and judge throw `<mode> called <call>`. */
export function refusingIntelligence(mode: string): Intelligence {
  const refuse = (call: string) => async (): Promise<never> => { throw new Error(`${mode} called ${call}`); };
  return { pick: refuse('pick'), judge: refuse('judge') };
}
