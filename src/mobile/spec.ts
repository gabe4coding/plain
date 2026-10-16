import { z } from 'zod';
import {
  parseStep, rejectCss, rejectUnknownKeys, loadNativeSpec, stepKind, STEP_KINDS, TagsSchema, type LoadOptions, type Step, type StepSource,
} from '../core/spec.js';
import { label } from '../core/results.js';
import { DIRECTIONS, requireScroll, type Scroll } from '../core/direction.js';

const nonEmptyText = z.string().trim().min(1);

export const MobileTargetSchema = z.object({
  platform: z.enum(['ios', 'android']),
  /** An explicit UDID or ADB serial: another device is never chosen silently. */
  device: nonEmptyText,
  /** An installed bundle ID or package name, not a binary to install. */
  app: nonEmptyText,
  capabilities: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type MobileTarget = z.infer<typeof MobileTargetSchema>;

/**
 * The directions of both mobile gestures (one `Direction` in the adapter): a scroll direction names where the
 * content moves, a swipe direction where the finger moves.
 */
const MOBILE_DIRECTIONS = DIRECTIONS;
export type Direction = (typeof MOBILE_DIRECTIONS)[number];
const DirectionSchema = z.enum(MOBILE_DIRECTIONS);

/** The direction and the target of a mobile `scroll` step's value. */
export const mobileScroll = (text: string): Scroll<Direction> => requireScroll(text, MOBILE_DIRECTIONS, 'Mobile');

type SharedMobileStep = Extract<Step, { kind: 'click' | 'fill' | 'dblclick' | 'check' | 'uncheck' | 'scroll' | 'press' | 'wait' | 'expect' }>;
type LoaderFields = { optional?: boolean; origin?: string; at?: StepSource };
export type MobileStep = SharedMobileStep
  | ({ kind: 'tap'; target: string } & LoaderFields)
  | ({ kind: 'longpress'; target: string } & LoaderFields)
  | ({ kind: 'swipe'; direction: Direction; within?: string } & LoaderFields);

const SHARED_KINDS = new Set(['click', 'fill', 'dblclick', 'check', 'uncheck', 'scroll', 'press', 'wait', 'expect']);
const MOBILE_KINDS = ['tap', 'longpress', 'swipe', ...SHARED_KINDS];
const KEYS = ['Back', 'Home', 'Enter', 'HideKeyboard'];

export interface MobileSpec extends MobileTarget {
  name: string;
  dir: string;
  hooks?: string;
  goal?: string;
  env: Record<string, unknown>;
  tags?: string[];
  timeout?: number;
  steps: MobileStep[];
}

const MobileSpecSchema = MobileTargetSchema.extend({
  name: nonEmptyText,
  hooks: nonEmptyText.optional(),
  goal: nonEmptyText.optional(),
  env: z.record(z.string(), z.unknown()).default({}),
  steps: z.array(z.unknown()).min(1),
  tags: TagsSchema,
  timeout: z.number().int().positive().optional(),
}).strict();

export function loadMobileSpec(file: string, opts?: LoadOptions): MobileSpec {
  return loadNativeSpec(file, MobileSpecSchema, parseMobileStep, opts);
}

/** `allowPlaceholders`: a `${...}` in a scroll target or a key is checked only after interpolation. */
export function validateMobileStep(step: MobileStep, allowPlaceholders = false): MobileStep {
  rejectCss(step, 'mobile');
  const templated = (value: string) => allowPlaceholders && value.includes('${');
  if (step.kind === 'scroll' && !templated(step.target)) mobileScroll(step.target);
  if (step.kind === 'press' && !templated(step.key) && !KEYS.includes(step.key)) {
    throw new Error('Mobile press supports Back (Android only), Home, Enter (Android only), or HideKeyboard');
  }
  return step;
}

export function parseMobileStep(raw: unknown, where = 'mobile', index = 0): MobileStep {
  const mapping = z.record(z.string(), z.unknown()).parse(raw);
  // Browser-only kinds are known keys too, so they get the "not supported on mobile" error below.
  const kind = stepKind(mapping, `${where}: step ${index}`, [...new Set([...MOBILE_KINDS, ...STEP_KINDS])], MOBILE_KINDS);
  const optional = mapping.optional === true;
  if (kind === 'tap' || kind === 'longpress') return validateMobileStep({ kind, target: nonEmptyText.parse(mapping[kind]), optional });
  if (kind === 'swipe') {
    const value = typeof mapping.swipe === 'string' ? { direction: mapping.swipe } : mapping.swipe;
    rejectUnknownKeys(value, ['direction', 'within'], `${where}: step ${index} "swipe"`);
    const swipe = z.object({ direction: DirectionSchema, within: nonEmptyText.optional() }).strict().parse(value);
    return validateMobileStep({ kind, ...swipe, optional });
  }
  if (!SHARED_KINDS.has(kind)) {
    throw new Error(`${kind} is not supported on mobile; use tap, click, fill, dblclick, longpress, check, uncheck, scroll, swipe, press, wait or expect`);
  }
  return validateMobileStep(parseStep(where, index, raw) as SharedMobileStep, true);
}

export function mobileLabel(step: MobileStep): string {
  const origin = 'origin' in step && step.origin ? `${step.origin} › ` : '';
  if (step.kind === 'tap' || step.kind === 'longpress') return `${origin}${step.kind} ${JSON.stringify(step.target)}`;
  if (step.kind === 'swipe') return `${origin}swipe ${step.direction}${step.within ? ` within ${JSON.stringify(step.within)}` : ''}`;
  return label(step);
}
