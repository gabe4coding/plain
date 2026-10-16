import { z } from 'zod';

// An element as Jev sees it. A leaf module: `src/jev/` imports it, so it imports nothing from `src/`.

export const CandidateSchema = z.object({
  id: z.number(),
  desc: z.string(),
  frameIndex: z.number().optional(),
  /** Rendered edges, requested for spatial targets: main viewport CSS pixels in the browser, screen coordinates on native. */
  bounds: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** Rendered edges of an element. */
export type Bounds = NonNullable<Candidate['bounds']>;

/**
 * Bounds as Jev reads them: whole pixels. A fraction costs Jev tokens and changes no relation it can judge; measured
 * relations (neighborRelations) use the exact edges.
 */
const roundBounds = (b: Bounds): Bounds =>
  ({ left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) });
export const boundsText = (b: Bounds): string => JSON.stringify(roundBounds(b));
