import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppiumAdapter, mobileCapabilities } from './adapter.js';
import { HiddenTargetError } from '../core/automation.js';
import { parseMobileTree, mobileFrame, type MobileElement, type MobileKind } from './tree.js';
import { appiumFixture, ELEMENT, lookupNode, withoutAttributes } from './appium-fixture.test.js';

const android = `<?xml version="1.0"?><hierarchy rotation="0"><android.widget.FrameLayout enabled="true">
  <android.view.ViewGroup clickable="true" enabled="true"><android.widget.TextView text="Sign in &amp; continue" enabled="true"/></android.view.ViewGroup>
  <android.widget.EditText content-desc="Email" text="" enabled="true"/>
  <android.widget.Switch content-desc="Preview" checkable="true" checked="false" enabled="true"/>
  <android.widget.ScrollView content-desc="Results" scrollable="true" enabled="true"><android.widget.TextView text="First result"/></android.widget.ScrollView>
  <android.widget.Button text="Disabled" enabled="false"/>
  <android.widget.Button text="Hidden" displayed="false"/>
</android.widget.FrameLayout></hierarchy>`;
const ios = `<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Fixture" enabled="true" visible="true">
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="Sign in &amp; continue" name="sign-in" enabled="true" visible="true"/>
  <XCUIElementTypeTextField type="XCUIElementTypeTextField" label="Email" value="" enabled="true" visible="true"/>
  <XCUIElementTypeSwitch type="XCUIElementTypeSwitch" label="Preview" value="0" enabled="true" visible="true"/>
  <XCUIElementTypeScrollView type="XCUIElementTypeScrollView" label="Results" enabled="true" visible="true"><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="First result" visible="true"/></XCUIElementTypeScrollView>
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="Disabled" enabled="false" visible="true"/>
  <XCUIElementTypeButton type="XCUIElementTypeButton" label="Hidden" enabled="true" visible="false"/>
  <XCUIElementTypePickerWheel type="XCUIElementTypePickerWheel" value="11 o’clock" enabled="true" visible="true"/>
</XCUIElementTypeApplication></AppiumAUT>`;

for (const [platform, xml] of [['android', android], ['ios', ios]] as const) {
  test(`${platform} source preserves paths, decoded labels, grouping and actionable filters`, () => {
    const tree = parseMobileTree(xml);
    const frame = mobileFrame(tree.roots, 'click', { url: 'mobile://fixture', title: 'Fixture' }, 1);
    assert.match(frame.snapshot.aria, /Sign in & continue/);
    assert.ok(frame.candidates.some(c => c.desc.includes('Sign in & continue')));
    assert.ok(!frame.candidates.some(c => /Disabled|Hidden/.test(c.desc.split(' in ')[0])));
    const inputs = mobileFrame(tree.roots, 'fill', frame.snapshot, 1);
    assert.equal(inputs.candidates.length, platform === 'ios' ? 2 : 1);
    assert.equal(inputs.elements.get(0)?.path, platform === 'ios' ? '/*[1]/*[2]' : '/*[1]/*[1]/*[2]');
    assert.equal(mobileFrame(tree.roots, 'check', frame.snapshot, 1).candidates.length, 1);
    assert.equal(mobileFrame(tree.roots, 'scroll', frame.snapshot, 1).candidates.length, 1);
  });
}
test('source rejects malformed XML and entities; caps candidates and reports truncation', () => {
  assert.throws(() => parseMobileTree('<hierarchy>'), /invalid XML/);
  assert.throws(() => parseMobileTree('<!DOCTYPE foo><foo/>'), /DTD/);
  const tree = parseMobileTree(`<hierarchy>${'<android.widget.Button text="Row"/>'.repeat(1100)}</hierarchy>`);
  const frame = mobileFrame(tree.roots, 'click', { url: '', title: '' }, 1);
  assert.equal(frame.candidates.length, 1016);
  assert.equal(frame.snapshot.truncated, true);
});
test('password text does not leak through inherited container names', () => {
  for (const source of [
    '<hierarchy><android.view.ViewGroup clickable="true"><android.widget.EditText password="true" content-desc="Password" text="sensitive-value"/></android.view.ViewGroup></hierarchy>',
    '<AppiumAUT><XCUIElementTypeOther accessible="true"><XCUIElementTypeSecureTextField label="Password" value="sensitive-value"/></XCUIElementTypeOther></AppiumAUT>',
  ]) {
    const tree = parseMobileTree(source);
    const frame = mobileFrame(tree.roots, 'click', { url: '', title: '' }, 1);
    assert.doesNotMatch(JSON.stringify({ snapshot: frame.snapshot, candidates: frame.candidates }), /sensitive-value/);
  }
});
test('Android input values are preserved alongside accessibility labels without marking labels unchecked', () => {
  const tree = parseMobileTree('<hierarchy><android.widget.EditText content-desc="Message" text="hello" checked="false"/><android.widget.TextView text="Title" checked="false"/></hierarchy>');
  const frame = mobileFrame(tree.roots, 'fill', { url: '', title: '' }, 1);
  assert.match(frame.snapshot.aria, /android.widget.EditText "Message" value="hello"/);
  assert.doesNotMatch(frame.snapshot.aria, /checked=false/);
});
test('iOS visible controls survive invisible layout ancestors without exposing hidden controls', () => {
  const tree = parseMobileTree(`<AppiumAUT><XCUIElementTypeApplication visible="true">
    <XCUIElementTypeOther visible="false" label="Hidden layout">
      <XCUIElementTypeOther visible="false">
        <XCUIElementTypeTextField name="title-field" value="Title" visible="true" enabled="true"/>
        <XCUIElementTypeButton label="Choose date" visible="true" enabled="true"/>
        <XCUIElementTypeButton label="Behind the dialog" visible="false" enabled="true"/>
        <XCUIElementTypeTextField label="No explicit visibility"/>
      </XCUIElementTypeOther>
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication></AppiumAUT>`);
  const frame = mobileFrame(tree.roots, 'fill', { url: '', title: '' }, 1);
  assert.equal(frame.candidates.length, 1);
  assert.equal(frame.elements.get(0)?.path, '/*[1]/*[1]/*[1]/*[1]');
  assert.match(frame.snapshot.aria, /title-field.*value="Title"/);
  assert.match(frame.snapshot.aria, /Choose date/);
  assert.doesNotMatch(frame.snapshot.aria, /Hidden layout|Behind the dialog|No explicit visibility/);
  const clicks = mobileFrame(tree.roots, 'click', frame.snapshot, 1);
  assert.equal(clicks.candidates.length, 2);
});
test('Android visibility stays inherited even when a descendant reports displayed=true', () => {
  const tree = parseMobileTree('<hierarchy><android.view.ViewGroup displayed="false"><android.widget.EditText content-desc="Hidden input" displayed="true"/><android.widget.Button text="Hidden button" visible="true"/></android.view.ViewGroup></hierarchy>');
  const frame = mobileFrame(tree.roots, 'click', { url: '', title: '' }, 1);
  assert.equal(frame.candidates.length, 0);
  assert.doesNotMatch(frame.snapshot.aria, /Hidden input|Hidden button/);
});
test('mobile session capabilities pin platform, device, native context and preserve app data', () => {
  const target = { platform: 'ios' as const, device: 'udid', app: 'com.example.fixture' };
  assert.equal(mobileCapabilities(target)['appium:noReset'], true);
  for (const key of ['platformName', 'appium:udid', 'appium:fullReset', 'appium:options', 'appium:autoWebview', 'appium:app'])
    assert.throws(() => mobileCapabilities({ ...target, capabilities: { [key]: true } }), /managed/);
  assert.equal(mobileCapabilities({ ...target, capabilities: { 'appium:xcodeOrgId': 'TEAM' } })['appium:xcodeOrgId'], 'TEAM');
});

test('iOS class chains count each type among siblings, from below the application', () => {
  const xml = `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="A"><XCUIElementTypeWindow type="XCUIElementTypeWindow">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="One"/><XCUIElementTypeOther type="XCUIElementTypeOther">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Two"/></XCUIElementTypeOther><XCUIElementTypeButton type="XCUIElementTypeButton" label="Three"/>
  </XCUIElementTypeWindow></XCUIElementTypeApplication></AppiumAUT>`;
  const chains = mobileFrame(parseMobileTree(xml).roots, 'click', { url: '', title: '' }, 0).candidates
    .map(c => c.desc.split('"')[1]);
  const elements = [...mobileFrame(parseMobileTree(xml).roots, 'click', { url: '', title: '' }, 0).elements.values()].map(e => e.chain);
  assert.deepEqual(chains, ['One', 'Two', 'Three']);
  assert.deepEqual(elements, ['XCUIElementTypeWindow[1]/XCUIElementTypeButton[1]', 'XCUIElementTypeWindow[1]/XCUIElementTypeOther[1]/XCUIElementTypeButton[1]',
    'XCUIElementTypeWindow[1]/XCUIElementTypeButton[2]']);
  assert.equal(mobileFrame(parseMobileTree(android).roots, 'click', { url: '', title: '' }, 0).elements.get(0)?.chain, undefined, 'Android has no class chains');
});

test('an unnamed non-clickable child with its clickable parent\'s bounds (a Compose role marker) is not a separate candidate', () => {
  const xml = `<hierarchy><android.view.View class="android.view.View" clickable="true" enabled="true" bounds="[0,0][100,50]">
    <android.widget.TextView class="android.widget.TextView" text="Add email" clickable="false" enabled="true" bounds="[10,10][90,40]"/>
    <android.widget.Button class="android.widget.Button" text="" clickable="false" enabled="true" bounds="[0,0][100,50]"/>
  </android.view.View><android.widget.Button class="android.widget.Button" text="" clickable="false" enabled="true" bounds="[0,60][100,110]"/></hierarchy>`;
  const descs = mobileFrame(parseMobileTree(xml).roots, 'click', { url: '', title: '' }, 0).candidates.map(c => c.desc);
  assert.deepEqual(descs, ['android.view.View "Add email" in hierarchy "Add email"', 'android.widget.TextView "Add email" in android.view.View "Add email"',
    'android.widget.Button "" in hierarchy "Add email"'], 'a same-looking button elsewhere stays');
});

test('bounds visibility keeps on-screen nodes and drops empty or scrolled-out ones', () => {
  const xml = `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="A" x="0" y="0" width="400" height="800">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Shown" x="10" y="10" width="50" height="20"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Empty" x="10" y="40" width="0" height="20"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Below" x="10" y="900" width="50" height="20"/>
    <XCUIElementTypeScrollView type="XCUIElementTypeScrollView" label="List" x="0" y="100" width="400" height="200">
      <XCUIElementTypeCell type="XCUIElementTypeCell" label="In view" x="0" y="120" width="400" height="40"/>
      <XCUIElementTypeCell type="XCUIElementTypeCell" label="Scrolled out" x="0" y="400" width="400" height="40"/>
    </XCUIElementTypeScrollView>
    <XCUIElementTypeWebView type="XCUIElementTypeWebView" label="Page" x="0" y="400" width="400" height="200">
      <XCUIElementTypeLink type="XCUIElementTypeLink" label="Web in view" x="10" y="420" width="100" height="20"/>
      <XCUIElementTypeLink type="XCUIElementTypeLink" label="Web scrolled out" x="10" y="700" width="100" height="20"/>
    </XCUIElementTypeWebView></XCUIElementTypeApplication></AppiumAUT>`;
  const labels = (bounds: boolean) => mobileFrame(parseMobileTree(xml, { boundsVisibility: bounds }).roots, 'click', { url: '', title: '' }, 0).candidates.map(c => c.desc.split('"')[1]);
  assert.deepEqual(labels(true), ['Shown', 'In view', 'Web in view'], 'a web view clips its page like a scroll view');
  assert.equal(labels(false).length, 7, 'without the option, a source lacking `visible` shows every node');
});

// Exercise the actual WebdriverIO transport against a local W3C/Appium server. No device or model key.
for (const platform of ['android', 'ios'] as const) {
  test(`${platform} Appium transport: actions, state, gestures, stale targets, and cleanup`, async () => {
    let source = platform === 'ios' ? ios : android;
    let checked = false;
    const server = await appiumFixture(platform, () => source, ({ method, path, body }) => {
      // iOS reads leave out costly attributes: `visible` for targets, `accessible` for claims and regions.
      if (path.endsWith('/execute/sync') && body.script === 'mobile: source') {
        const excluded: string = body.args[0].excludedAttributes;
        assert.equal(platform, 'ios'); assert.ok(['visible', 'accessible', 'visible,accessible'].includes(excluded));
        return undefined;
      }
      if (path.endsWith('/element') && method === 'POST') {
        // XCUITest answers with the attributes the session asked for (elementResponseAttributes).
        const node = platform === 'ios' ? lookupNode(source, body) : undefined;
        return node ? { [ELEMENT]: 'control', type: node.role, enabled: node.enabled, rect: { x: 0, y: 0, width: 10, height: 10 },
          'attribute/name': node.attrs.name ?? null, 'attribute/label': node.attrs.label ?? null, 'attribute/visible': node.visible } : { [ELEMENT]: 'control' };
      }
      if (/\/attribute\//.test(path)) return platform === 'ios' ? (checked ? '1' : '0') : String(checked);
      if (path.endsWith('/click')) checked = !checked;
      else if (path.endsWith('/window/rect')) return { x: 0, y: 0, width: 400, height: 800 };
      else if (path.endsWith('/screenshot')) return Buffer.from('png fixture').toString('base64');
      return undefined;
    });
    const { requests } = server;
    const adapter = new AppiumAdapter(server.url, 1000);
    async function target(kind: MobileKind): Promise<MobileElement> {
      const frame = await adapter.capture(kind); return frame.elements.get(0)!;
    }
    try {
      await adapter.open({ platform, device: 'fixture-device', app: 'com.example.fixture' });
      const caps = requests.find(r => r.path === '/wd/hub/session')!.body.capabilities.alwaysMatch;
      assert.equal(caps['appium:udid'], 'fixture-device');
      assert.equal(caps['appium:noReset'], true);
      assert.equal(caps['appium:automationName'], platform === 'ios' ? 'XCUITest' : 'UiAutomator2');
      assert.ok(requests.some(r => r.path.endsWith('/appium/device/activate_app') && r.body.appId === 'com.example.fixture'));
      const early = await adapter.captureEarly('click');
      const settings = requests.filter(r => r.path.endsWith('/appium/settings'));
      if (platform === 'ios') { assert.equal(early, null); assert.equal(settings.length, 0, 'no quick read on iOS'); }
      else {
        assert.deepEqual(early?.candidates, (await adapter.capture('click')).candidates);
        // Read the session's idle timeout once, switch it off for one source read, then restore it.
        assert.deepEqual(settings.map(r => [r.method, r.body.settings?.waitForIdleTimeout]), [['GET', undefined], ['POST', 0], ['POST', 10000]]);
        const i = requests.findIndex(r => r.method === 'POST' && r.body.settings?.waitForIdleTimeout === 0);
        assert.ok(requests[i + 1].path.endsWith('/source'));
      }
      await adapter.act('fill', await target('fill'), 'hello');
      // iOS looks targets up by class chain (quicker than XPath there), Android by XPath.
      assert.deepEqual([requests.find(r => r.path.endsWith('/element'))?.body.using, requests.find(r => r.path.endsWith('/element'))?.body.value],
        platform === 'ios' ? ['-ios class chain', 'XCUIElementTypeTextField[1]'] : ['xpath', '/*[1]/*[1]/*[2]']);
      assert.ok(requests.some(r => r.path.endsWith('/value') && r.body.text === 'hello'));
      // A secure text field: XCUIElementTypeSecureTextField on iOS, password="true" on Android.
      assert.equal(adapter.secret(await target('fill')), false);
      source = platform === 'ios'
        ? ios.replace('<XCUIElementTypeTextField type="XCUIElementTypeTextField"', '<XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField"')
        : android.replace('<android.widget.EditText content-desc="Email"', '<android.widget.EditText password="true" content-desc="Email"');
      assert.equal(adapter.secret(await target('fill')), true);
      source = platform === 'ios' ? ios : android;
      assert.ok(requests.some(r => r.path.endsWith('/clear')));
      const sourceReads = () => requests.filter(r => r.body.args?.[0]?.excludedAttributes?.startsWith('visible')).length;
      if (platform === 'ios') {
        // A self-named target is revalidated from the lookup's response alone.
        assert.equal(caps['appium:shouldUseCompactResponses'], false);
        assert.equal(sourceReads(), 0);
        const inputs = await adapter.capture('fill');
        const wheel = inputs.candidates.find(c => c.desc.includes('PickerWheel'))!;
        assert.match(wheel.desc, /11 o’clock/);
        await adapter.act('fill', inputs.elements.get(wheel.id)!, '14');
        assert.equal(requests.filter(r => r.path.endsWith('/clear')).length, 1, 'Picker wheels must not be cleared');
        assert.equal(sourceReads(), 1, 'a target named only by its children is revalidated against the tree');
        assert.equal(requests.filter(r => r.path.endsWith('/value')).at(-1)?.body.text, '14');
      }
      const control = await target('check');
      checked = false;
      await adapter.act('check', control); await adapter.act('check', control); await adapter.act('uncheck', control);
      assert.equal(requests.filter(r => r.path.endsWith('/click')).length, 2);
      await adapter.act('longpress', await target('click'));
      await adapter.act('dblclick', await target('click'));
      await adapter.gesture('scroll', 'down', await target('scroll'));
      await adapter.gesture('swipe', 'left');
      const commands = requests.filter(r => r.path.endsWith('/execute/sync')).map(r => r.body);
      assert.ok(commands.some(c => c.script === `mobile: ${platform === 'ios' ? 'touchAndHold' : 'longClickGesture'}` && c.args[0].duration === (platform === 'ios' ? 1 : 1000)));
      assert.ok(commands.some(c => c.script === `mobile: ${platform === 'ios' ? 'doubleTap' : 'doubleClickGesture'}`));
      assert.ok(commands.some(c => c.script === `mobile: ${platform === 'ios' ? 'scroll' : 'scrollGesture'}` && c.args[0].direction === 'down' && c.args[0].elementId === 'control'));
      assert.ok(commands.some(c => c.script === `mobile: ${platform === 'ios' ? 'swipe' : 'swipeGesture'}` && c.args[0].direction === 'left'));
      const scoped = await adapter.capture('region', await target('scroll'));
      assert.match(scoped.snapshot.aria, /First result/); assert.doesNotMatch(scoped.snapshot.aria, /Email/);
      assert.equal((await adapter.screenshot()).toString(), 'png fixture');
      await adapter.press('Home');
      if (platform === 'ios') await assert.rejects(adapter.press('Back'), /unsupported on iOS/);
      else { await adapter.press('Back'); assert.ok(requests.some(r => r.body.script === 'mobile: pressKey' && r.body.args[0].keycode === 4)); }
      const stale = await target('click');
      const before = requests.filter(r => r.path.endsWith('/click')).length;
      source = source.replaceAll('Sign in &amp; continue', 'Different control');
      await assert.rejects(adapter.act('tap', stale), /UI changed/);
      assert.equal(requests.filter(r => r.path.endsWith('/click')).length, before);
      await adapter.close();
      await assert.rejects(adapter.capture('region'), /call open first/);
      assert.equal(requests.filter(r => r.method === 'DELETE').length, 1);
      await adapter.open({ platform, device: 'fixture-device', app: 'com.example.fixture' });
      source = platform === 'ios' ? ios : android;
      await assert.rejects(adapter.act('tap', stale), /UI changed/);
      if (platform === 'ios') {
        // fastTargets: target captures skip `visible`; the lookup reports a covered pick, and the next capture is exact.
        const fast = new AppiumAdapter(server.url, 1000, undefined, true);
        await fast.open({ platform, device: 'fixture-device', app: 'com.example.fixture' });
        const reads = () => requests.filter(r => r.path.endsWith('/source') || r.body.args?.[0]?.excludedAttributes === 'accessible').length;
        const exactBefore = reads();
        const frame = await fast.capture('click');
        assert.equal(reads(), exactBefore, 'a target capture reads the source without `visible`');
        const hidden = frame.candidates.find(c => c.desc.includes('"Hidden"'))!;
        await assert.rejects(fast.act('tap', frame.elements.get(hidden.id)!), HiddenTargetError);
        assert.ok(!(await fast.capture('click')).candidates.some(c => c.desc.includes('"Hidden"')));
        assert.equal(reads(), exactBefore + 1, 'after a hidden pick the next target capture is exact');
        await fast.capture('region');
        assert.equal(reads(), exactBefore + 2, 'claims always see the exact tree');
        // A region pick may use the fast tree; the first exact look inside it confirms it shows something.
        const regions = await fast.capture('region', undefined, { regionPick: true });
        assert.equal(regions.approximate, true); assert.equal(reads(), exactBefore + 2);
        const regionOf = (label: string) => regions.elements.get(regions.candidates.find(c => c.desc.includes(`"${label}"`))!.id)!;
        assert.match((await fast.capture('region', regionOf('Results'))).snapshot.aria, /First result/);
        assert.ok(!regions.candidates.some(c => c.desc.includes('"Email"')), 'an approximate region pick lists containers only');
        const coveredSource = source;
        source = source.replace('label="Results" enabled="true" visible="true"', 'label="Results" enabled="true" visible="false"')
          .replace('label="First result" visible="true"', 'label="First result" visible="false"');
        await assert.rejects(fast.capture('region', regionOf('Results')), HiddenTargetError);
        source = coveredSource;
        assert.equal((await fast.capture('region', undefined, { regionPick: true })).approximate, undefined, 'then the next pick is exact');
        await fast.close();
      }
    } finally { await adapter.close(); await server.close(); }
  });
}

test('iOS resolve fails closed on string or missing lookup visibility, and does not treat size as visible', async () => {
  // bool: the attribute path's "true" string still acts. string-false / missing: fail closed.
  // no-type: elementResponseAttributes ignored; the tree's visible decides, not width/height.
  // no-type-bare: that tree also lacks `visible`, so a positive size is not enough.
  let mode: 'string-true' | 'string-false' | 'missing' | 'no-type' | 'no-type-bare' = 'string-true';
  const server = await appiumFixture('ios', () => ios, ({ method, path, body }) => {
    if (path.endsWith('/execute/sync') && body.script === 'mobile: source') {
      const value = withoutAttributes(ios, body.args[0].excludedAttributes);
      return mode === 'no-type-bare' ? value.replaceAll(/ visible="[^"]*"/g, '') : value;
    }
    if (!path.endsWith('/element') || method !== 'POST') return undefined;
    if (mode === 'no-type' || mode === 'no-type-bare') return { [ELEMENT]: 'control' }; // id only: ref.type stays undefined
    const node = lookupNode(ios, body);
    if (!node) return { error: 'no such element' };
    const value: Record<string, unknown> = { [ELEMENT]: 'control', type: node.role, enabled: node.enabled, rect: { x: 0, y: 0, width: 10, height: 10 },
      'attribute/name': node.attrs.name ?? null, 'attribute/label': node.attrs.label ?? null };
    if (mode === 'string-true') value['attribute/visible'] = 'true';
    if (mode === 'string-false') value['attribute/visible'] = 'false';
    return value;
  });
  const { requests } = server;
  const fast = new AppiumAdapter(server.url, 1000, undefined, true);
  const clicks = () => requests.filter(r => r.path.endsWith('/click')).length;
  const exactSources = () => requests.filter(r => r.method === 'GET' && r.path.endsWith('/source')).length;
  const approxSources = () => requests.filter(r => r.body.args?.[0]?.excludedAttributes === 'visible').length;
  try {
    await fast.open({ platform: 'ios', device: 'fixture-device', app: 'com.example.fixture' });
    const frame = await fast.capture('click');
    const el = (label: string) => frame.elements.get(frame.candidates.find(c => c.desc.includes(`"${label}"`))!.id)!;
    const signIn = el('Sign in & continue');
    const hidden = el('Hidden');
    await fast.act('tap', signIn);
    assert.equal(clicks(), 1, 'a lookup visible of "true" is visible');
    const approxAfterTrue = approxSources();
    await fast.capture('click');
    assert.equal(approxSources(), approxAfterTrue + 1, 'accepting "true" does not force an exact capture');

    mode = 'string-false';
    const clicksBeforeFalse = clicks();
    const exactBeforeFalse = exactSources();
    await assert.rejects(fast.act('tap', signIn), HiddenTargetError);
    assert.equal(clicks(), clicksBeforeFalse, '"false" is not visible, even with a positive rect');
    await fast.capture('click');
    assert.equal(exactSources(), exactBeforeFalse + 1, 'string "false" falls back to an exact capture');

    mode = 'missing';
    const clicksBeforeMissing = clicks();
    const exactBeforeMissing = exactSources();
    await assert.rejects(fast.act('tap', signIn), HiddenTargetError);
    assert.equal(clicks(), clicksBeforeMissing, 'a missing attribute/visible is not treated as visible');
    const exactFrame = await fast.capture('click');
    assert.equal(exactSources(), exactBeforeMissing + 1, 'a missing visibility flag falls back to an exact capture');
    // The exact capture already showed the target visible: a server that leaves the flag out does not block it.
    await fast.act('tap', exactFrame.elements.get(exactFrame.candidates.find(c => c.desc.includes('"Sign in & continue"'))!.id)!);
    assert.equal(clicks(), clicksBeforeMissing + 1, 'a pick from an exact capture acts without the flag');

    mode = 'no-type';
    const clicksBeforeHidden = clicks();
    const start = requests.length;
    await assert.rejects(fast.act('tap', hidden), HiddenTargetError);
    assert.equal(clicks(), clicksBeforeHidden, 'a positive size does not make a visible="false" node visible');
    assert.ok(requests.slice(start).some(r => r.body.args?.[0]?.excludedAttributes === 'accessible'),
      'the no-type fallback reads a tree that still has visible');
    const exactBeforeBare = exactSources();
    await fast.capture('click');
    assert.equal(exactSources(), exactBeforeBare + 1, 'a not-visible no-type pick retargets exactly');

    mode = 'no-type';
    await fast.act('tap', signIn);
    assert.equal(clicks(), clicksBeforeHidden + 1, 'the no-type fallback acts when the tree node is visible');
    const approxBefore = approxSources();
    await fast.capture('click');
    assert.equal(approxSources(), approxBefore + 1, 'a visible no-type node does not force an exact capture');

    mode = 'no-type-bare';
    const clicksBeforeBare = clicks();
    const exactBeforeStrip = exactSources();
    await assert.rejects(fast.act('tap', signIn), HiddenTargetError);
    assert.equal(clicks(), clicksBeforeBare, 'without the tree visible flag, size is not enough');
    await fast.capture('click');
    assert.equal(exactSources(), exactBeforeStrip + 1, 'a missing tree visible flag forces an exact retarget');
  } finally { await fast.close(); await server.close(); }
});

test('iOS waits after fill and a tap on a text control until the keyboard is on screen, and only then', async () => {
  // iOS 27 keeps the keyboard below the screen, visible="false", for about a second after typing returns.
  let keyboard: 'absent' | 'never' | number = 3; // a number: how many more lookups still report it hidden
  const server = await appiumFixture('ios', () => ios, ({ method, path, body }) => {
    if (path.endsWith('/element') && body.value === '**/XCUIElementTypeKeyboard') {
      if (keyboard === 'absent') return { error: 'no such element' };
      const hidden = keyboard === 'never' || keyboard-- > 0;
      return { [ELEMENT]: 'keyboard', type: 'XCUIElementTypeKeyboard', enabled: true,
        rect: { x: 0, y: hidden ? 891 : 590, width: 402, height: 226 }, 'attribute/visible': !hidden };
    }
    if (path.endsWith('/execute/sync')) return null; // this server has no `mobile: source`
    if (!path.endsWith('/element') || method !== 'POST') return undefined;
    assert.equal(body.using, '-ios class chain', 'iOS finds a control by its class chain, not by xpath');
    const node = lookupNode(ios, body)!;
    return { [ELEMENT]: 'control', type: node.role, enabled: node.enabled, rect: { x: 0, y: 0, width: 10, height: 10 },
      'attribute/name': node.attrs.name ?? null, 'attribute/label': node.attrs.label ?? null, 'attribute/visible': node.visible };
  });
  const { requests } = server;
  const adapter = new AppiumAdapter(server.url, 1000);
  const isLookup = (r: { body: Record<string, any> }) => r.body.value === '**/XCUIElementTypeKeyboard';
  const lookups = () => requests.filter(isLookup).length;
  const element = async (kind: MobileKind, label: string) => {
    const frame = await adapter.capture(kind);
    return frame.elements.get(frame.candidates.find(c => c.desc.startsWith(label))!.id)!;
  };
  try {
    await adapter.open({ platform: 'ios', device: 'fixture-device', app: 'com.example.fixture' });
    const field = await element('fill', 'XCUIElementTypeTextField "Email"');
    await adapter.act('fill', field, 'hello');
    assert.equal(lookups(), 4, 'fill returns once the keyboard reports visible, not while it waits below the screen');
    assert.ok(requests.findIndex(isLookup) > requests.findIndex(r => r.path.endsWith('/value')), 'the wait follows the typing');

    keyboard = 2;
    await adapter.act('tap', await element('click', 'XCUIElementTypeTextField "Email"'));
    assert.equal(lookups(), 7, 'a tap on a text control waits for the keyboard too');
    await adapter.act('tap', await element('click', 'XCUIElementTypeButton "Sign in & continue"'));
    assert.equal(lookups(), 7, 'a tap on any other control does not look for the keyboard');

    keyboard = 'absent';
    await adapter.act('fill', field, 'again');
    assert.equal(lookups(), 8, 'no keyboard (a hardware keyboard): one lookup, no wait');

    keyboard = 'never';
    const started = Date.now();
    await adapter.act('fill', field, 'capped');
    const waited = Date.now() - started;
    assert.ok(waited >= 1000 && waited < 2500, `a keyboard that never shows ends the wait at the action timeout (${waited} ms)`);
  } finally { await adapter.close(); await server.close(); }
});
