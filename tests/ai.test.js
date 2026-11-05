import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLoose, buildAnalyzePrompt } from '../src/lib/ai.js';
import { pickModel } from '../src/lib/providers/index.js';
import { levelFromCheck, parseWordList, SELF_CHECK } from '../src/lib/level.js';
import { normalizeWord } from '../src/lib/storage.js';

test('parseJsonLoose handles code fences and chatter', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.throws(() => parseJsonLoose('nope'));
});

test('analyze prompt lists sentences with ids and known words', () => {
  const p = buildAnalyzePrompt([{ id: 4, text: 'Hi there' }], { known: ['hi'] });
  assert.match(p, /4: Hi there/);
  assert.match(p, /never list them\): hi/);
});

test('pickModel keeps the current model, else prefers matches', () => {
  const p = { defaultModel: 'x', preferredModels: [/flash$/] };
  assert.equal(pickModel(p, ['a', 'b-flash'], 'a'), 'a');
  assert.equal(pickModel(p, ['a', 'b-flash', 'c-flash'], 'gone'), 'c-flash');
  assert.equal(pickModel(p, ['a', 'x'], ''), 'x');
});

test('levelFromCheck stops at the first weak band', () => {
  const b = SELF_CHECK.en;
  assert.equal(levelFromCheck(b, new Set()), 1);
  assert.equal(levelFromCheck(b, new Set([...b[0], ...b[1], ...b[2].slice(0, 4)])), 3);
  assert.equal(levelFromCheck(b, new Set([...b[0], ...b[2], ...b[3]])), 1);
});

test('parseWordList takes the first column', () => {
  assert.deepEqual(parseWordList('# h\nPoppet — малятко\ngive up\tздатися\napple, яблуко\n\n'), ['Poppet', 'give up', 'apple']);
});

test('normalizeWord lowercases and trims punctuation', () => {
  assert.equal(normalizeWord('“Don’t,”'), "don't");
});
