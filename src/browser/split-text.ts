import { sureSpatial } from '../jev/evidence.js';

/** Shown beside a failed text or count check whose words sit on different lines of the tree. It does not change the verdict. */
export const SPLIT_TEXT_HINT = 'hint: the accessibility tree splits this text across elements. Name the element that shows it (for example "the counter shows 2 items left") instead of one phrase or a landmark the tree does not have';

/** "2 items left" is a count. The word left there is not a spatial relation. */
const COUNT_LEFT = /\b(?:items?|\d+)\s+left\b/gi;

const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at', 'for',
  'and', 'or', 'with', 'that', 'this', 'it', 'its', 'says', 'say', 'said', 'shows', 'show', 'shown', 'there', 'has', 'have', 'page']);

/**
 * True when two neighboring content words of `claim` both occur in `aria`, but not as that phrase and not on one
 * line. A button named Login does not match: both words share the button's line.
 */
export function splitTextHint(claim: string, aria: string): boolean {
  if (sureSpatial(claim.replace(COUNT_LEFT, 'count'))) return false;
  const words = (claim.match(/[a-z0-9]+(?:\.[a-z0-9]+)*/gi) ?? [])
    .map((word) => word.toLowerCase()).filter((word) => !STOP.has(word));
  const lines = aria.split('\n');
  for (let i = 0; i < words.length - 1; i++) {
    const left = words[i];
    const right = words[i + 1];
    if (hasPhrase(aria, left, right)) continue;
    const leftLines = lines.filter((line) => hasWord(line, left));
    const rightLines = lines.filter((line) => hasWord(line, right));
    if (!leftLines.length || !rightLines.length) continue;
    if (lines.some((line) => hasWord(line, left) && hasWord(line, right))) continue;
    return true;
  }
  return false;
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(word)}(?:[^a-z0-9]|$)`, 'i').test(text);
}

function hasPhrase(text: string, left: string, right: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(left)} ${escapeRegExp(right)}(?:[^a-z0-9]|$)`, 'i').test(text);
}

const escapeRegExp = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
