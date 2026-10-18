import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isOlderNode, nodeVersionMessage } from '../bin/node-check.mjs';

test('nodeVersionMessage names the command, the minimum and the running version', () => {
  assert.equal(nodeVersionMessage('20.19.0'),
    'plain requires Node.js 22 or newer. This process is Node.js 20.19.0.\nInstall Node.js 22 or newer and run the command again.');
  assert.equal(nodeVersionMessage('20.19.0', '22', 'plain-computer'),
    'plain-computer requires Node.js 22 or newer. This process is Node.js 20.19.0.\nInstall Node.js 22 or newer and run the command again.');
  assert.equal(nodeVersionMessage('20.19.0', '22', 'plain-mobile'),
    'plain-mobile requires Node.js 22 or newer. This process is Node.js 20.19.0.\nInstall Node.js 22 or newer and run the command again.');
  assert.equal(nodeVersionMessage('22.14.0', '22.19', 'plain-mobile'),
    'plain-mobile requires Node.js 22.19 or newer. This process is Node.js 22.14.0.\nInstall Node.js 22.19 or newer and run the command again.');
});

test('isOlderNode compares dotted versions and treats a missing part as zero', () => {
  assert.equal(isOlderNode('20.19.0', '22'), true);
  assert.equal(isOlderNode('22.0.0', '22'), false);
  assert.equal(isOlderNode('22.14.0', '22.19'), true);
  assert.equal(isOlderNode('22.19.0', '22.19'), false);
  assert.equal(isOlderNode('24.1.0', '22'), false);
});

test('refuseOldNode prints the message and exits when the process is older than the minimum', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { refuseOldNode } from './bin/node-check.mjs';
    Object.defineProperty(process.versions, 'node', { value: '20.19.0' });
    refuseOldNode();
    console.log('still running');
  `], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plain requires Node\.js 22 or newer\. This process is Node\.js 20\.19\.0\./);
  assert.doesNotMatch(result.stdout, /still running/);
});
