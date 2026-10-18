import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainFailure, IMAGE_MAX_BYTES, IMAGE_MAX_PX, IMAGE_MIN_PX, SCREENSHOT_BYTES, SCREENSHOT_GATEWAY, SCREENSHOT_SIZE } from './explain.js';
import type { Answers, AskOptions, Question } from './ask.js';

type Asked = { state: { screenshot?: { type?: string } }; options?: AskOptions; count: number };
const boom = async (): Promise<Answers> => { throw new Error('image call failed'); };

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOF0 length covers the two length bytes plus the six bytes that follow them.
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01]);
}

function recordingAsk(answers: Answers['answers']): { ask: (state: unknown, questions: Question[], options?: AskOptions) => Promise<Answers>; asked: Asked } {
  const asked: Asked = { state: {}, count: 0 };
  const ask = async (state: unknown, _questions: Question[], options?: AskOptions): Promise<Answers> => {
    asked.count++;
    asked.state = state as Asked['state'];
    asked.options = options;
    return { tokens: 11, answers };
  };
  return { ask, asked };
}

test('explainFailure reports one claim, several claims, and a missing label as no line', async () => {
  const one = recordingAsk([{ choice: 'holds', probabilities: { holds: 0.98 } }]);
  const shot = png(1280, 720);
  assert.deepEqual(await explainFailure(['the total is 2'], shot, { supported: true, ask: one.ask }), { line: 'screenshot: holds (p=0.98)', tokens: 11 });
  assert.equal(one.asked.count, 1);
  assert.equal(one.asked.options?.images, true);
  assert.equal(one.asked.state.screenshot?.type, 'image');

  const many = recordingAsk([
    { choice: 'holds', probabilities: { holds: 0.98 } },
    { choice: 'not visible', probabilities: { 'not visible': 0.91 } },
  ]);
  assert.equal((await explainFailure(['the total is 2', 'the footer is shown'], png(IMAGE_MIN_PX, IMAGE_MAX_PX), { supported: true, ask: many.ask }))?.line,
    'screenshot: "the total is 2" holds (p=0.98); "the footer is shown" not visible (p=0.91)');

  const blank = recordingAsk([{ choice: 'other', probabilities: { other: 1 } }]);
  assert.equal(await explainFailure(['the total is 2'], jpeg(400, 300), { supported: true, ask: blank.ask }), null);
  assert.equal(blank.asked.count, 1);
});

test('explainFailure skips a gateway, a rejected size and an oversized file without calling the model', async () => {
  const asked = recordingAsk([]);
  assert.deepEqual(await explainFailure(['x'], png(1280, 720), { supported: false, ask: asked.ask }), { line: SCREENSHOT_GATEWAY, tokens: 0 });
  assert.deepEqual(await explainFailure(['x'], png(IMAGE_MIN_PX - 1, 400), { supported: true, ask: asked.ask }), { line: SCREENSHOT_SIZE, tokens: 0 });
  assert.deepEqual(await explainFailure(['x'], png(IMAGE_MAX_PX + 1, 400), { supported: true, ask: asked.ask }), { line: SCREENSHOT_SIZE, tokens: 0 });
  const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
  big.set(png(1280, 720));
  assert.deepEqual(await explainFailure(['x'], big, { supported: true, ask: asked.ask }), { line: SCREENSHOT_BYTES, tokens: 0 });
  assert.equal(asked.asked.count, 0);
});

test('explainFailure degrades when the image call throws or the bytes are not a PNG or JPEG', async () => {
  assert.equal(await explainFailure(['x'], png(1280, 720), { supported: true, ask: boom }), null);
  assert.equal(await explainFailure(['x'], new Uint8Array([1, 2, 3, 4]), { supported: true, ask: boom }), null);
  assert.equal(await explainFailure([], png(1280, 720), { supported: true, ask: boom }), null);
});
