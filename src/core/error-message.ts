// A leaf, so spec loading (`include.ts`) can use it without an import cycle through `results.ts`.

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
