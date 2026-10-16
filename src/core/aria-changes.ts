import { switchOn } from './env.js';

export interface AriaChanges {
  /** Only when it changed. */
  title?: string;
  /** Only when it changed. */
  url?: string;
  /** New tree lines in page order, up to ADDED_CHARS. */
  added: string[];
  /** New lines past the cap. */
  addedOmitted: number;
  removed: number;
}

/**
 * Step and batch results in every MCP server carry `changed`, so the agent reads the outcome there instead of
 * calling snapshot or ask (docs/benchmarks/agent-changes.md). PLAIN_CHANGES=0 turns it off.
 */
export const changesEnabled = (): boolean => switchOn('PLAIN_CHANGES');
export const changesNote = (): string => !changesEnabled() ? '' : ' The result also has `changed`: the page title/URL if they changed, and the accessibility-tree ' +
  'lines the action added (`added`, in page order, capped) and how many it removed. Read it before calling snapshot or ask.';

/** Roughly one compact snapshot: after a navigation, `added` shows the top of the new page. */
const ADDED_CHARS = 1500;

type Capture = { title: string; url: string; aria: string };

/** What an action changed: a diff of the two trees' lines, counted as multisets. */
export function ariaChanges(before: Capture, after: Capture, cap = ADDED_CHARS): AriaChanges {
  const linesOf = (aria: string) => aria.split('\n').filter((line) => line.trim() !== '');
  const unmatched = new Map<string, number>();
  for (const line of linesOf(before.aria)) unmatched.set(line, (unmatched.get(line) ?? 0) + 1);

  const added: string[] = [];
  let chars = 0;
  let omitted = 0;
  for (const line of linesOf(after.aria)) {
    const count = unmatched.get(line) ?? 0;
    if (count > 0) {
      unmatched.set(line, count - 1);
    } else if (chars + line.length + 1 > cap) {
      omitted++;
    } else {
      added.push(line);
      chars += line.length + 1;
    }
  }
  const removed = [...unmatched.values()].reduce((sum, count) => sum + count, 0);
  return {
    ...(after.title !== before.title ? { title: after.title } : {}),
    ...(after.url !== before.url ? { url: after.url } : {}),
    added,
    addedOmitted: omitted,
    removed,
  };
}
