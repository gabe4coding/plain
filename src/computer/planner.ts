import { ask as jevAsk, type Question, type AskAnswer } from '../jev/ask.js';
import { directionIn } from '../core/direction.js';
import { DESKTOP_DIRECTIONS, scrollStep } from './spec.js';

// Turns one spoken or typed sentence ("open Notes, then type milk and eggs in the body and press command S")
// into plan items. Jev never writes text: code proposes the options (where a new instruction may start, which
// action, which words of the sentence), Jev picks, and every argument is copied verbatim from what was said.

export type PlanItem =
  | { kind: 'open'; app: string }
  | { kind: 'step'; step: Record<string, unknown>; risky: boolean }
  | { kind: 'ask'; claim: string }
  | { kind: 'stop' }
  | { kind: 'unknown'; text: string; reason: string };
export type Ask = (state: unknown, questions: Question[]) => Promise<{ tokens: number; answers: AskAnswer[] }>;

/**
 * Sentence ends and sequencing words always start a new instruction; "and" and commas are ambiguous ("type milk
 * and eggs" against "... and press Enter"), so Jev decides those. Not the dot in tom@example.com, and not "next",
 * which is as often part of a target ("the next field").
 */
const HARD_SPLIT = /(?:[.;!?](?=\s|$)|,?\s+(?:and\s+)?(?:then|after\s+that|finally)\b)\s*/i;
const SOFT_SPLIT = /,\s*(?:and\s+)?|\s+and\s+/gi;
const LEAD = /^(?:and\s+then|and|then|after\s+that|finally|please|now|ok(?:ay)?)[\s,]+/i;
const TYPE_VERB = /^(?:now\s+|please\s+)*(?:type|write|enter|put|insert|fill\s+in|fill)\b\s*/i;
const MAX_SPAN_WORDS = 14;
/** 64 readings: under a Choice's 255 options. */
const MAX_SOFT_CUTS = 6;
const ACTION_CONFIDENCE = 0.5;
const RISKY_AT = 0.5;

const ACTIONS: Record<string, string> = {
  open: 'Launch, open or switch to an application',
  click: 'Click, tap, select or push a control on screen',
  dblclick: 'Double-click something',
  rightclick: 'Right-click something',
  fill: 'Type, write, enter or put text into a field',
  press: 'Press a keyboard key or shortcut',
  scroll: 'Scroll a view up, down, left or right',
  ask: 'Ask a yes/no question about what is on screen, or check whether something is true',
  stop: 'End the session (stop, quit, goodbye)',
  other: 'Another action on the computer that is none of the above, such as deleting, saving or copying something',
  none: 'Not an instruction for the computer',
};

const ARGUMENTS = {
  target: 'which words name the control or field to act on? For typing, the field typed into, not the text. Keep words like "the" and "button".',
  value: 'if it asks to type or write text, which words are exactly the text to type?',
  app: 'if it asks to open or switch to an application, which words name the application?',
  keys: 'if it asks to press keys, which words name the key or shortcut?',
} as const;

/** Only the directions a desktop scroll step takes. */
const SCROLL_CHOICES = Object.fromEntries(DESKTOP_DIRECTIONS.map((direction) => [direction, direction[0].toUpperCase() + direction.slice(1)]));

const KEYS: Record<string, string> = {
  enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  command: 'Meta', cmd: 'Meta', control: 'Control', ctrl: 'Control', option: 'Alt', alt: 'Alt', shift: 'Shift',
};

/**
 * Two Jev requests: where the sentence splits, then every piece's action and arguments. A third only when the
 * split was wrong: a piece that is "not an instruction" right after a piece that failed ("write inside the text
 * field" | "hello, how are you") is joined back, and the pieces are routed again.
 */
export async function plan(text: string, ask: Ask = jevAsk): Promise<{ items: PlanItem[]; tokens: number }> {
  const { segments, tokens: splitTokens } = await split(text.trim(), ask);
  if (!segments.length) return { items: [], tokens: splitTokens };
  const first = await route(segments, ask);
  const joined: string[] = [];
  first.items.forEach((item, i) => {
    const previous = first.items[i - 1];
    const continuesFailedPiece = i > 0 && item.kind === 'unknown' && item.reason === 'not an instruction' && previous.kind === 'unknown';
    if (continuesFailedPiece) joined[joined.length - 1] += `, ${segments[i]}`;
    else joined.push(segments[i]);
  });
  if (joined.length === segments.length) return { items: first.items, tokens: splitTokens + first.tokens };
  const second = await route(joined, ask);
  return { items: second.items, tokens: splitTokens + first.tokens + second.tokens };
}

/** "command a" → "Meta+a", "enter" → "Enter". */
export function keysFrom(spoken: string): string {
  return spoken.toLowerCase().split(/[\s+-]+/).filter((word) => word && !['key', 'the', 'plus'].includes(word))
    .map((word) => KEYS[word] ?? (word.length === 1 ? word : word[0].toUpperCase() + word.slice(1))).join('+');
}

/**
 * Every run of 1 to MAX_SPAN_WORDS consecutive words: the options an argument is picked from. Punctuation is
 * trimmed at the span's edges only, so typed text keeps its own commas ("Hello, how are you").
 */
export function spans(segment: string, limit = 250): string[] {
  const words = segment.split(/\s+/).filter(Boolean);
  const found = new Set<string>();
  for (let length = 1; length <= Math.min(words.length, MAX_SPAN_WORDS); length++) {
    for (let i = 0; i + length <= words.length; i++) {
      // Double quotes are dictation emphasis (Click on "Create Note" button), never text.
      const span = words.slice(i, i + length).join(' ').replace(/["“”]/g, '').replace(/^'+|['.,;:!?]+$/g, '');
      if (span) found.add(span);
    }
  }
  return [...found].slice(0, limit);
}

/** The pieces after the hard split, each with the soft boundaries Jev decides. */
export function candidates(text: string): { piece: string; cuts: [number, number][] }[] {
  const pieces = text.split(HARD_SPLIT).map((part) => part.replace(LEAD, '').replace(/^[\s,]+|[\s,]+$/g, '')).filter(Boolean);
  return pieces.map((piece) => ({
    piece,
    cuts: [...piece.matchAll(SOFT_SPLIT)]
      .filter((match) => match.index! > 0 && match.index! + match[0].length < piece.length)
      .map((match): [number, number] => [match.index!, match.index! + match[0].length]),
  }));
}

/**
 * Every combination of a piece's soft boundaries, as lists of instructions. Jev compares whole readings, so
 * "type salt | pepper in the search box" loses to "type salt and pepper in the search box" as a unit.
 */
export function readings(piece: string, cuts: [number, number][]): string[][] {
  const used = cuts.slice(0, MAX_SOFT_CUTS);
  const all: string[][] = [];
  for (let mask = 0; mask < 1 << used.length; mask++) {
    const parts: string[] = [];
    let start = 0;
    used.forEach(([cutStart, cutEnd], i) => {
      if (mask & (1 << i)) {
        parts.push(piece.slice(start, cutStart));
        start = cutEnd;
      }
    });
    parts.push(piece.slice(start));
    all.push(parts.map((part) => part.replace(LEAD, '').trim()).filter(Boolean));
  }
  return all;
}

/** One Choice per ambiguous piece, among its readings. */
async function split(text: string, ask: Ask): Promise<{ segments: string[]; tokens: number }> {
  const parts = candidates(text).map(({ piece, cuts }) => ({ piece, options: readings(piece, cuts) }));
  const ambiguous = parts.filter((part) => part.options.length > 1);
  if (!ambiguous.length) return { segments: parts.map((part) => part.piece), tokens: 0 };
  const questions: Question[] = ambiguous.map((part, i) => ({
    kind: 'choice',
    instructions: `\`pieces[${i}]\` is part of a spoken command for a computer. Which reading splits it into its separate ` +
      'actions correctly? Each action is one thing to do (open, click, type text into a field, press keys, scroll, ask); ' +
      'words that belong to the text to type or to a control\'s name stay together.',
    criteria: Object.fromEntries(part.options.map((reading, j) => [`r${j}`, reading.map((step, k) => `${k + 1}. ${step}`).join('  ')])),
  }));
  const { tokens, answers } = await ask({ utterance: text, pieces: ambiguous.map((part) => part.piece) }, questions);
  const chosen = new Map(ambiguous.map((part, i) => [part, part.options[Number((answers[i].choice ?? 'r0').slice(1))] ?? part.options[0]]));
  return { segments: parts.flatMap((part) => chosen.get(part) ?? [part.piece]), tokens };
}

/**
 * One request for every segment: the action, argument spans for every action it could be, the scroll direction
 * and whether it is hard to undo. Code keeps only the answers the chosen action uses.
 */
async function route(segments: string[], ask: Ask): Promise<{ items: PlanItem[]; tokens: number }> {
  const questions: Question[] = [];
  const questionIndex: Record<string, number>[] = [];
  const spanOptions = segments.map((segment) => Object.fromEntries(spans(segment).map((span, j) => [`s${j}`, span])));
  segments.forEach((_, i) => {
    const indexOf: Record<string, number> = {};
    const add = (key: string, question: Question) => { indexOf[key] = questions.push(question) - 1; };
    add('action', { kind: 'choice', instructions: `What does \`segments[${i}]\` ask the computer to do?`, criteria: ACTIONS });
    for (const [key, what] of Object.entries(ARGUMENTS)) {
      add(key, {
        kind: 'choice',
        instructions: `In \`segments[${i}]\` (a spoken computer command), ${what} Answer with the exact words, or none.`,
        criteria: { ...spanOptions[i], none: 'No such words' },
      });
    }
    add('dir', {
      kind: 'choice',
      instructions: `If \`segments[${i}]\` asks to scroll, in which direction?`,
      criteria: { ...SCROLL_CHOICES, none: 'Not a scroll' },
    });
    add('risky', { kind: 'boolean', instructions: `Would doing \`segments[${i}]\` send, publish, pay, buy, delete or otherwise do something hard to undo?` });
    questionIndex.push(indexOf);
  });

  const { tokens, answers } = await ask({ segments }, questions);
  const items = segments.map((segment, i) => itemFor(segment, (key) => answers[questionIndex[i][key]], spanOptions[i]));
  return { items, tokens };
}

function itemFor(segment: string, answer: (key: string) => AskAnswer, spanOptions: Record<string, string>): PlanItem {
  // No confidence gate on spans: overlapping options ("the OK button", "OK button") split the probability between
  // equally good answers. For the same reason `none` wins only against all the spans together.
  const pick = (key: string) => {
    const { probabilities } = answer(key);
    const ranked = Object.entries(probabilities ?? {}).filter(([option]) => option !== 'none').sort((a, b) => b[1] - a[1]);
    const mass = ranked.reduce((sum, [, p]) => sum + p, 0);
    return ranked.length && mass > (probabilities?.none ?? 0) ? spanOptions[ranked[0][0]] : undefined;
  };
  const action = answer('action');
  const kind = (action.confidence ?? 1) >= ACTION_CONFIDENCE ? action.choice : 'unsure';
  const risky = (answer('risky').probability ?? 0) >= RISKY_AT;
  const unknown = (reason: string): PlanItem => ({ kind: 'unknown', text: segment, reason });

  switch (kind) {
    case 'stop':
      return { kind: 'stop' };
    case 'open': {
      const app = pick('app')?.replace(/\s+app$/i, '');
      return app ? { kind: 'open', app } : unknown('no application named');
    }
    case 'ask': {
      const claim = segment.replace(/^(check|verify|see|tell me)\s+(if|whether|that)\s+/i, '');
      return { kind: 'ask', claim: claim !== segment || segment.endsWith('?') ? claim : `${segment}?` };
    }
    case 'click':
    case 'dblclick':
    case 'rightclick': {
      const target = pick('target');
      return target ? { kind: 'step', step: { [kind]: target }, risky } : unknown('no control named');
    }
    case 'fill': {
      // No field named: the one that has focus (candidates carry a focused flag).
      const named = pick('target');
      // A field named but no words judged to be the text (a misheard word): the text is what is left once the
      // verb and the field go.
      const value = pick('value') ?? (named ? rest(segment, named) : undefined);
      const target = named ?? (value && 'the focused text field');
      return target && value ? { kind: 'step', step: { fill: { target, value } }, risky } : unknown('say the text to type');
    }
    case 'press': {
      const keys = pick('keys');
      return keys ? { kind: 'step', step: { press: keysFrom(keys) }, risky } : unknown('no key named');
    }
    case 'scroll': {
      const direction = directionIn(answer('dir').choice, DESKTOP_DIRECTIONS);
      if (!direction) return unknown('no direction');
      return { kind: 'step', step: scrollStep({ direction, target: pick('target') ?? 'the window' }), risky: false };
    }
    case 'other':
      return unknown('say which button or key does it');
    case 'unsure':
      return unknown('not sure what to do');
    default:
      return unknown('not an instruction');
  }
}

/** A fill's text by subtraction: the segment without its typing verb and the field phrase. */
export function rest(segment: string, target: string): string | undefined {
  const plain = segment.replace(/["“”]/g, '');
  const at = plain.toLowerCase().indexOf(target.toLowerCase());
  if (at < 0) return undefined;
  const before = plain.slice(0, at).replace(/\s*(?:in|into|inside|on|to)(?:\s+the)?\s*$/i, '');
  const after = plain.slice(at + target.length);
  const text = `${before} ${after}`.trim()
    .replace(TYPE_VERB, '')
    .replace(/^\s*(?:in|into|inside|on)\s+/i, '')
    .trim()
    .replace(/^[,:]+|[.,;:!?]+$/g, '')
    .trim();
  return text || undefined;
}
