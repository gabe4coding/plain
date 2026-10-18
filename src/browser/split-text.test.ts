import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTextHint } from './split-text.js';

const split = '- strong: "2"\n- text: items left';

test('splitTextHint matches words the tree splits across lines and skips a phrase or one line', () => {
  assert.equal(splitTextHint('the footer says 2 items left', split), true);
  assert.equal(splitTextHint('the counter shows 2 items left', '- text: 2 items left'), false);
  assert.equal(splitTextHint('the Login button is shown', '- button "Login"'), false);
  assert.equal(splitTextHint('the total is 20', '- text: 2\n- text: items'), false);
  assert.equal(splitTextHint('hello', split), false);
  assert.equal(splitTextHint('the button A is to the left of the button B', '- button "A"\n- button "B"'), false);
});
