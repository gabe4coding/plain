/**
 * Evidence routing shared by the browser, desktop and mobile engines: which prompts need rendered geometry
 * (src/jev/evidence.ts). Groups are queued per spec or batch and classified in one request when a step first needs
 * an answer; each group keeps its own route. A group queued after that (a later MCP `step`) gets its own request.
 */
import { DIRECTIONS, parseScroll } from './direction.js';

export interface EvidenceRoutes {
  pending: Map<string, string[]>;
  decided: Map<string, Promise<boolean>>;
}

export const evidenceRoutes = (): EvidenceRoutes => ({ pending: new Map(), decided: new Map() });

/** The fields of a browser, desktop or mobile step that hold descriptions. */
export type DescribedStep = { kind: string; target?: unknown; source?: unknown; within?: unknown; expectations?: unknown; condition?: unknown };

const NO_DESCRIPTION = new Set(['goto', 'press', 'mouse']);

const text = (value: unknown): string[] => (typeof value === 'string' && value ? [value] : []);

/** Only descriptions, never entered values, files, keys or URLs. css= selectors need no route. */
export function promptGroups(step: DescribedStep): string[][] {
  if (NO_DESCRIPTION.has(step.kind)) return [];
  const targets = (prompts: string[]) => prompts.filter((prompt) => !prompt.startsWith('css='));
  const groups: string[][] = [];
  if (step.kind === 'expect') {
    groups.push(Array.isArray(step.expectations) ? step.expectations.filter((claim): claim is string => typeof claim === 'string') : []);
    groups.push(targets(text(step.within)));
  } else if (step.kind === 'wait') {
    if (typeof step.condition === 'string' && !step.condition.startsWith('css=')) {
      groups.push([step.condition], targets(text(step.within)));
    }
  } else if (step.kind === 'drag') {
    groups.push(targets([...text(step.source), ...text(step.target)]));
  } else if (step.kind === 'swipe') {
    groups.push(targets(text(step.within)));
  } else if (step.kind === 'scroll') {
    // A desktop or mobile scroll target starts with its direction, which is not a spatial relation between elements.
    groups.push(targets(text(step.target).map((target) => parseScroll(target, DIRECTIONS)?.target ?? target)));
  } else {
    groups.push(targets(text(step.target)));
  }
  return groups.filter((group) => group.length > 0);
}

export function prepareRoutes(routes: EvidenceRoutes, groups: string[][]): void {
  for (const prompts of groups) {
    if (!prompts.length) continue;
    const key = JSON.stringify(prompts);
    if (!routes.decided.has(key)) routes.pending.set(key, prompts);
  }
}

/** Whether `prompts` need geometry; the first call classifies every queued group in one request (`classify`). */
export async function routeNeedsLayout(routes: EvidenceRoutes, prompts: string[],
  classify: (groups: string[][]) => Promise<boolean[]>): Promise<boolean> {
  const key = JSON.stringify(prompts);
  const existing = routes.decided.get(key);
  if (existing) return existing;
  prepareRoutes(routes, [prompts]);
  const pending = [...routes.pending.entries()];
  routes.pending.clear();
  const batch = classify(pending.map(([, group]) => group));
  for (const [index, [groupKey, group]] of pending.entries()) {
    const route = batch.then((spatial) => spatial[index]).catch((error: unknown) => {
      routes.decided.delete(groupKey);
      routes.pending.set(groupKey, group);
      throw error;
    });
    // A later group may never execute after a failed step. Its rejected route still needs an observer.
    void route.catch(() => {});
    routes.decided.set(groupKey, route);
  }
  return routes.decided.get(key)!;
}
