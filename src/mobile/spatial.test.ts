import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppiumAdapter } from './adapter.js';
import { MobileSession, runMobileSpec } from './session.js';
import { loadMobileSpec } from './spec.js';
import type { MobileNode } from './tree.js';
import type { Snapshot } from '../core/automation.js';
import { fakeIntelligence } from '../core/fake-intelligence.test.js';
import { appiumFixture, ELEMENT, lookupNode } from './appium-fixture.test.js';

// Tree order is the reverse of the visual order: B comes first in the source but is drawn on the right.
const sources = {
  android: `<?xml version="1.0"?><hierarchy rotation="0"><android.widget.FrameLayout enabled="true" bounds="[0,0][400,800]">
  <android.widget.Button text="B" clickable="true" enabled="true" bounds="[300,100][380,150]"/>
  <android.widget.Button text="A" clickable="true" enabled="true" bounds="[20,100][100,150]"/>
  <android.widget.TextView text="Total" enabled="true" bounds="[20,300][100,330]"/>
</android.widget.FrameLayout></hierarchy>`,
  ios: `<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Fixture" enabled="true" visible="true" x="0" y="0" width="400" height="800">
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="B" name="b" enabled="true" visible="true" x="300" y="100" width="80" height="50"/>
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="A" name="a" enabled="true" visible="true" x="20" y="100" width="80" height="50"/>
  <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Total" enabled="true" visible="true" x="20" y="300" width="80" height="30"/>
</XCUIElementTypeApplication></AppiumAUT>`,
};

/** The Appium fixture for `platform`, with the clicked node names and the target reads without `visible`. */
async function appium(platform: 'android' | 'ios') {
  const ios = platform === 'ios';
  const clicked: string[] = [];
  /** Target reads without `visible` (iOS fast targets). */
  const fastReads: string[] = [];
  let found: MobileNode | undefined;
  const server = await appiumFixture(platform, () => sources[platform], ({ method, path, body }) => {
    if (path.endsWith('/execute/sync') && body.script === 'mobile: source') {
      const excluded: string = body.args[0].excludedAttributes;
      if (excluded.startsWith('visible')) fastReads.push(excluded);
      return undefined;
    }
    if (path.endsWith('/element') && method === 'POST') {
      found = lookupNode(sources[platform], body);
      return { [ELEMENT]: 'control', ...(ios && found ? { type: found.role, enabled: true,
        rect: { x: 0, y: 0, width: 80, height: 50 }, 'attribute/name': found.attrs.name ?? null, 'attribute/label': found.attrs.label ?? null,
        'attribute/visible': true } : {}) };
    }
    if (path.endsWith('/click')) clicked.push(found!.name);
    else if (path.endsWith('/window/rect')) return { x: 0, y: 0, width: 400, height: 800 };
    return undefined;
  });
  return { url: server.url, clicked, fastReads, close: server.close };
}

for (const platform of ['android', 'ios'] as const) {
  test(`${platform}: a spec routes once, picks and judges spatial prompts by bounds, and semantic prompts see no geometry`, async () => {
    const ios = platform === 'ios';
    const fixture = await appium(platform);
    const dir = mkdtempSync(join(tmpdir(), 'mobile-spatial-'));
    const routed: unknown[] = [];
    const ai = fakeIntelligence({
      ask: async (state, questions) => {
        routed.push(state);
        const { groups } = state as { groups: string[][] };
        return { tokens: 5, answers: questions.map((_, i) => ({
          choice: /left|right|edge/.test(groups[i].join(' ')) ? 'spatial' : 'semantic', confidence: 1 })) };
      },
      pick: async (candidates, targets, page) => targets.map((target) => {
        const spatial = target === 'the button nearest the edge';
        assert.equal(candidates.every((c) => c.bounds !== undefined), spatial, target);
        assert.equal(page.layout !== undefined, spatial);
        if (!spatial) {
          const named = candidates.find((c) => c.desc.includes('"B"'))!;
          return { id: named.id, probability: 1, probabilities: {}, tokens: 2 };
        }
        assert.equal(page.coordinates, ios ? 'iOS screen points' : 'Android screen pixels');
        // Tree order would give B; only the bounds give A.
        assert.match(candidates[0].desc, /"B"/);
        const left = candidates.filter((c) => /Button/.test(c.desc)).sort((a, b) => a.bounds!.left - b.bounds!.left)[0];
        return { id: left.id, probability: 1, probabilities: {}, tokens: 2 };
      }),
      judge: async (state, claims) => {
        const snap = state as Snapshot;
        assert.match(snap.layout!, /Button "A" is [^\n]*left of [^\n]*Button "B"[.;]/);
        assert.match(snap.layout!, /Total" bounds=\{"left":20,"top":300,"right":100,"bottom":330\}/);
        return { probabilities: claims.map(() => 1), tokens: 3 };
      },
    });
    const file = join(dir, 'spatial.yaml');
    writeFileSync(file, `name: spatial ${platform}
platform: ${platform}
device: fixture-device
app: com.example.fixture
steps:
  - tap: the button nearest the edge
  - tap: the button named B
  - expect: The A button is left of the B button
`);
    try {
      // fastTargets as the CLI sets it: iOS target captures leave out `visible` and keep their frames.
      const session = new MobileSession(new AppiumAdapter(fixture.url, 1000, undefined, true), 1000, ai);
      const result = await runMobileSpec(loadMobileSpec(file), session);
      assert.equal(result.status, 'pass', JSON.stringify(result.steps));
      assert.deepEqual(fixture.clicked, ['A', 'B']);
      // The fast tree also lists covered elements, so only the semantic tap may use it.
      assert.equal(fixture.fastReads.length, ios ? 1 : 0);
      // One classifier request for the whole spec: 'the button named B' has no spatial cue, the claim a sure one.
      assert.deepEqual(routed, [{ groups: [['the button nearest the edge']] }]);
      assert.equal(result.jevCalls, 4);
    } finally {
      await fixture.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
