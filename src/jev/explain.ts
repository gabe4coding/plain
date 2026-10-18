import { image } from '@typesafe-ai/sdk';
import { type Answers, type AskOptions, type Question } from './ask.js';
import { provider } from './provider.js';

/** TypeSafe rejects an image whose sides fall outside this range. It does not resize. */
export const IMAGE_MIN_PX = 280;
export const IMAGE_MAX_PX = 1568;
export const IMAGE_MAX_BYTES = 16 * 1024 * 1024;

export const SCREENSHOT_GATEWAY = 'screenshot: not sent (the Vercel AI Gateway path has no image support)';
export const SCREENSHOT_SIZE = 'screenshot: not sent (each side must be 280 to 1568 px)';
export const SCREENSHOT_BYTES = 'screenshot: not sent (the file is over 16 MiB)';

const HOLDS = 'holds';
const CONTRADICTED = 'contradicted';
const NOT_VISIBLE = 'not visible';

const CRITERIA: Record<string, string> = {
  [HOLDS]: 'The screenshot shows that the claim is true.',
  [CONTRADICTED]: 'The screenshot shows that the claim is false.',
  [NOT_VISIBLE]: 'The screenshot does not show the part of the page the claim is about.',
};

type ExplainAsk = (state: unknown, questions: Question[], options?: AskOptions) => Promise<Answers>;

/** True on TypeSafe, false on the gateway, null when no provider is configured. */
export function imageBackend(): boolean | null {
  try {
    return provider() === 'typesafe';
  } catch {
    return null;
  }
}

/**
 * What a failure screenshot shows, for the step detail. The line never changes the verdict.
 * The gateway, a size TypeSafe rejects, an unreadable file or a failed call yields a skip line or null.
 */
export async function explainFailure(claims: string[], png: Uint8Array, options: {
  supported: boolean;
  ask: ExplainAsk;
}): Promise<{ line: string; tokens: number } | null> {
  if (!claims.length) return null;
  if (!options.supported) return { line: SCREENSHOT_GATEWAY, tokens: 0 };
  if (png.byteLength > IMAGE_MAX_BYTES) return { line: SCREENSHOT_BYTES, tokens: 0 };
  const size = imageDimensions(png);
  if (!size) return null;
  if (size.width < IMAGE_MIN_PX || size.height < IMAGE_MIN_PX || size.width > IMAGE_MAX_PX || size.height > IMAGE_MAX_PX) {
    return { line: SCREENSHOT_SIZE, tokens: 0 };
  }
  try {
    const { answers, tokens } = await options.ask({
      screenshot: image(png),
      note: 'Viewport screenshot taken when the check did not pass.',
    }, claims.map((claim) => ({
      kind: 'choice' as const,
      instructions: `What does the screenshot show about this claim: ${claim}?`,
      criteria: CRITERIA,
    })), { images: true });
    const parts = claims.flatMap((claim, i) => {
      const answer = answers[i];
      const label = answer?.choice;
      if (label !== HOLDS && label !== CONTRADICTED && label !== NOT_VISIBLE) return [];
      const probability = answer.probabilities?.[label];
      if (probability === undefined) return [];
      const shown = `${label} (p=${probability.toFixed(2)})`;
      return [claims.length === 1 ? shown : `"${claim}" ${shown}`];
    });
    if (!parts.length) return null;
    return { line: `screenshot: ${parts.join('; ')}`, tokens };
  } catch {
    return null;
  }
}

/** PNG or JPEG pixel size, or null when the bytes are not one of those. */
function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  return null;
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) return null;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + length;
  }
  return null;
}
