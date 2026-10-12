import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMobileNode, nodeIdentity, parseIdentity, type MobileNode } from './tree.js';

// Captured handles are rechecked with these two helpers before a native action
// (AppiumAdapter.checkHandle). XML parsing and candidate filters live in adapter.test.ts.
function node(over: Partial<MobileNode> & Pick<MobileNode, 'path'>): MobileNode {
  return { attrs: {}, role: 'android.widget.Button', name: 'OK', visible: true, enabled: true, children: [], ...over };
}

const labeled = node({
  path: '/*[1]',
  role: 'android.widget.EditText',
  name: 'Email',
  attrs: { 'resource-id': 'email', name: 'email-name', label: 'Email', 'content-desc': 'Email address', text: 'a@b.c' },
});

test('nodeIdentity ignores value and checked state and keeps role, name, and native ids', () => {
  const changedValue = node({
    ...labeled,
    visible: false,
    enabled: false,
    attrs: { ...labeled.attrs, value: 'secret', checked: 'true', selected: 'true', password: 'true' },
  });
  assert.equal(nodeIdentity(changedValue), nodeIdentity(labeled));
  assert.equal(
    nodeIdentity(node({ path: '/*[1]', attrs: { text: 'Hi' } })),
    nodeIdentity(node({ path: '/*[1]', attrs: { text: 'Hi', 'resource-id': '', name: '', label: '', 'content-desc': '' } })),
  );

  assert.notEqual(nodeIdentity(node({ ...labeled, role: 'android.widget.Button' })), nodeIdentity(labeled));
  assert.notEqual(nodeIdentity(node({ ...labeled, name: 'Phone' })), nodeIdentity(labeled));
  for (const key of ['resource-id', 'name', 'label', 'content-desc', 'text'] as const)
    assert.notEqual(nodeIdentity(node({ ...labeled, attrs: { ...labeled.attrs, [key]: 'other' } })), nodeIdentity(labeled), key);
});

test('parseIdentity reads the role, the displayed name, the name attribute and the label, and skips the resource id', () => {
  // iOS rechecks a target from the lookup response (AppiumAdapter.resolveIos). The resource id sits between the
  // displayed name and the name attribute, so a shift would compare the wrong fields.
  const identity = nodeIdentity(node({
    path: '/*[1]',
    role: 'XCUIElementTypeButton',
    name: 'Sign in',
    attrs: { 'resource-id': 'rid', name: 'sign-in', label: 'Sign in button', 'content-desc': 'desc', text: 'typed' },
  }));
  assert.deepEqual(parseIdentity(identity), {
    role: 'XCUIElementTypeButton', name: 'Sign in', nativeName: 'sign-in', label: 'Sign in button',
  });
  assert.deepEqual(parseIdentity(nodeIdentity(node({ path: '/*[1]', name: 'Say "hi"', attrs: { name: 'a"b' } }))), {
    role: 'android.widget.Button', name: 'Say "hi"', nativeName: 'a"b', label: '',
  });
});

test('findMobileNode returns the node at a path and does not treat /*[1] as a prefix of /*[10]', () => {
  const child = node({ path: '/*[1]/*[2]', name: 'child' });
  const nested = node({ path: '/*[10]/*[1]', name: 'nested' });
  const ten = node({ path: '/*[10]', name: 'ten', children: [nested] });
  const roots = [node({ path: '/*[1]', children: [node({ path: '/*[1]/*[1]', name: 'first' }), child] }), ten];

  assert.equal(findMobileNode(roots, '/*[1]/*[2]'), child);
  assert.equal(findMobileNode(roots, '/*[10]/*[1]'), nested);
  assert.equal(findMobileNode(roots, '/*[1]'), roots[0]);
  assert.equal(findMobileNode(roots, '/*[10]'), ten);
  assert.equal(findMobileNode(roots, '/*[2]'), undefined);
  assert.equal(findMobileNode(roots, '/*[1]/*[3]'), undefined);
  assert.equal(findMobileNode([], '/*[1]'), undefined);
});
