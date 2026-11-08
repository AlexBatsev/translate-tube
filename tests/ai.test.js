import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLoose, buildAnalyzePrompt, shouldTryNextModel, isRetired, failureReason, normalizeItem, parseJsonStrict, BadAnswerError } from '../src/lib/ai.js';
import { rankModels, versionKey, PROVIDERS } from '../src/lib/providers/index.js';
import { ProviderError } from '../src/lib/providers/http.js';
import { levelFromCheck, parseWordList, SELF_CHECK } from '../src/lib/level.js';
import { normalizeWord } from '../src/lib/storage.js';

test('parseJsonLoose handles code fences and chatter', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.throws(() => parseJsonLoose('nope'));
});

test('analyze prompt lists sentences with ids and asks for levels and kinds', () => {
  const p = buildAnalyzePrompt([{ id: 4, text: 'Hi there' }]);
  assert.match(p, /4: Hi there/);
  assert.match(p, /"level": difficulty 1-6/);
  assert.match(p, /phrasal verb/);
});

test('parseJsonStrict throws BadAnswerError on garbage', () => {
  assert.throws(() => parseJsonStrict('{"a": "b"c"}'), BadAnswerError);
});

test('normalizeItem clamps level, keeps parts for phrases only, drops items not in the sentence', () => {
  const s = 'He blew it at the nook and cranny.';
  const a = normalizeItem({ text: 'blew it', lemma: 'blow it', level: 9, kind: 'Idiom', parts: [{ text: 'blow', translation: 'дути' }, { text: 'x' }] }, s);
  assert.equal(a.level, 6);
  assert.equal(a.kind, 'idiom');
  assert.deepEqual(a.parts, [{ text: 'blow', translation: 'дути' }]);
  assert.deepEqual(normalizeItem({ text: 'nook', parts: [{ text: 'nook', translation: 'куток' }] }, s).parts, []);
  assert.equal(normalizeItem({ text: 'banana' }, s), null);
  assert.equal(normalizeItem({ text: 'nook and cranny' }, s).kind, 'fixed phrase');
});

test('retired models are recognised and reasons are short', () => {
  const gone = new ProviderError('404: models/gemini-2.5-flash is no longer available', 404);
  assert.equal(isRetired(gone), true);
  assert.equal(failureReason(gone), 'retired');
  assert.equal(failureReason(new ProviderError('503: high demand', 503)), 'busy');
  assert.equal(failureReason(new ProviderError('x', 0, { timeout: true })), 'no answer');
  assert.equal(isRetired(new ProviderError('503: high demand', 503)), false);
});

test('versionKey ignores dates and sizes', () => {
  assert.deepEqual(versionKey('gemini-3.6-flash'), [3, 6]);
  assert.deepEqual(versionKey('claude-haiku-4-5-20251001'), [4, 5]);
});

test('rankModels puts the newest stable fast model first', () => {
  const gemini = PROVIDERS.find((p) => p.id === 'gemini');
  const r = rankModels(gemini, ['gemini-2.5-flash', 'gemini-3.8-flash-preview', 'gemini-3.6-flash', 'gemini-3.7-pro', 'gemini-3.7-flash', 'gemini-3.7-flash-lite']);
  assert.deepEqual(r.slice(0, 4), ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-3.7-flash-lite']);
  assert.equal(r.at(-1), 'gemini-3.8-flash-preview');
  const claude = PROVIDERS.find((p) => p.id === 'claude');
  assert.equal(rankModels(claude, ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5'])[0], 'claude-haiku-5-5');
});

test('shouldTryNextModel: retired, overloaded and silent models yes; bad key no', () => {
  assert.equal(shouldTryNextModel(new ProviderError('404: no longer available', 404)), true);
  assert.equal(shouldTryNextModel(new ProviderError('503: high demand', 503)), true);
  assert.equal(shouldTryNextModel(new ProviderError('No answer', 0, { timeout: true })), true);
  assert.equal(shouldTryNextModel(new ProviderError('400: Developer instruction is not enabled for this model', 400)), true);
  assert.equal(shouldTryNextModel(new ProviderError('400: API key not valid', 400)), false);
  assert.equal(shouldTryNextModel(new ProviderError('401: unauthorized', 401)), false);
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
