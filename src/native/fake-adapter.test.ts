// Shared test fakes; the .test name keeps them out of the package (package.json "files" skips *.test.js).
import type { Frame } from '../core/automation.js';
import type { Candidate } from '../core/candidate.js';
import type { ComputerAdapter } from '../computer/adapter.js';
import type { MobileAdapter } from '../mobile/adapter.js';
import type { MobileTarget } from '../mobile/spec.js';
import type { NativeAdapter } from './session.js';

/**
 * A screen the test sets: `text` is its tree and `controls` its candidates, each with the element `handle(candidate)`.
 * `log` holds each capture, action and press in order; `onAct` runs after an action is logged, and a press of
 * `failKey` throws.
 */
export class FakeNativeAdapter implements NativeAdapter<string, string> {
  log: unknown[] = [];
  title = 'Fixture';
  text = 'Ready';
  controls: Candidate[] = [{ id: 0, desc: 'button Preview' }];
  handle: (candidate: Candidate) => string = () => 'control';
  onAct: (...args: unknown[]) => void | Promise<void> = () => {};
  closed = 0;
  constructor(readonly url: string, readonly failKey?: string) {}
  async capture(kind: unknown, within?: string): Promise<Frame<string>> {
    this.log.push(['capture', kind, within]);
    return { snapshot: { url: this.url, title: this.title, aria: this.text, truncated: false }, candidates: this.controls,
      elements: new Map(this.controls.map((c) => [c.id, this.handle(c)])) };
  }
  async act(...args: unknown[]) { this.log.push(args); await this.onAct(...args); }
  async press(key: string) { this.log.push(['press', key]); if (key === this.failKey) throw new Error('input failed'); }
  async screenshot() { return Buffer.from('png'); }
  async close() { this.closed++; }
}

/** The desktop fake: one app, named by `title` (pid 42); a press of `bad` fails. */
export class FakeComputerAdapter extends FakeNativeAdapter implements ComputerAdapter<string> {
  constructor() { super('desktop://42', 'bad'); }
  async apps() { return [{ name: this.title, pid: 42 }]; }
  async open(target: unknown) { this.log.push(target); return { name: this.title, pid: 42 }; }
  async mouse(x: number, y: number) { this.log.push(['mouse', x, y]); }
  async drag(...args: unknown[]) { this.log.push(['drag', ...args]); }
  async scroll(...args: unknown[]) { this.log.push(['scroll', ...args]); }
}

/** The mobile fake: `open` returns its target; a press of `Enter` fails. */
export class FakeMobileAdapter extends FakeNativeAdapter implements MobileAdapter<string> {
  constructor() { super('mobile://42', 'Enter'); }
  async open(target: MobileTarget) { this.log.push(target); return target; }
  async gesture(...args: unknown[]) { this.log.push(['gesture', ...args]); }
}
