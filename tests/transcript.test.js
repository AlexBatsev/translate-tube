import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson3, buildSentences, sentenceAt, tokenize, markHighlights, findPhrases } from '../src/lib/transcript.js';

const asr = {
  events: [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'so' }, { utf8: ' we', tOffsetMs: 400 }, { utf8: ' kicked', tOffsetMs: 800 }, { utf8: ' off.', tOffsetMs: 1200 }] },
    { tStartMs: 2000, segs: [{ utf8: '\n' }] },
    { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: 'It&#39;s' }, { utf8: ' raining', tOffsetMs: 500 }] },
    { tStartMs: 9000, dDurationMs: 1000, segs: [{ utf8: '[Music]' }] },
    { tStartMs: 12000, dDurationMs: 1000, segs: [{ utf8: 'Bye!' }] }
  ]
};

test('parseJson3 keeps word timings and decodes entities', () => {
  const p = parseJson3(asr);
  assert.equal(p[0].text, 'so');
  assert.equal(p[1].start, 400);
  assert.equal(p[3].end, 3000);
  assert.equal(p[4].text, "It's");
});

test('buildSentences splits on punctuation and long gaps', () => {
  const s = buildSentences(parseJson3(asr));
  assert.deepEqual(s.map((x) => x.text), ['so we kicked off.', "It's raining", 'Bye!']);
  assert.equal(s[1].start, 3000);
  assert.equal(s[2].id, 2);
});

test('buildSentences caps very long unpunctuated runs', () => {
  const pieces = Array.from({ length: 60 }, (_, i) => ({ text: ` w${i}`, start: i * 100, end: i * 100 + 90 }));
  const s = buildSentences(pieces, { maxWords: 20 });
  assert.equal(s.length, 3);
});

test('sentenceAt finds the sentence playing at a time', () => {
  const s = [{ start: 0 }, { start: 1000 }, { start: 5000 }];
  assert.equal(sentenceAt(s, -5), -1);
  assert.equal(sentenceAt(s, 0), 0);
  assert.equal(sentenceAt(s, 4999), 1);
  assert.equal(sentenceAt(s, 9999), 2);
});

test('tokenize keeps apostrophes and hyphens inside words', () => {
  const t = tokenize("Don't over-think it, ok?");
  assert.deepEqual(t.filter((x) => x.word).map((x) => x.text), ["Don't", 'over-think', 'it', 'ok']);
  assert.equal(t.map((x) => x.text).join(''), "Don't over-think it, ok?");
});

test('markHighlights marks multi-word phrases', () => {
  const t = tokenize('Let us break the ice, then break it again.');
  const m = markHighlights(t, ['break the ice', 'again']);
  const marked = t.filter((_, i) => m[i] === 0).map((x) => x.text).join('');
  assert.equal(marked, 'break the ice');
  assert.equal(t[m.indexOf(1)].text, 'again');
});

test('findPhrases finds non-overlapping ranges in order', () => {
  const r = findPhrases('Сьогодні ми розпочали сезон з тріском.', ['з тріском', 'розпочали', '', 'відсутнє']);
  assert.deepEqual(r.map((x) => x.index), [1, 0]);
  assert.equal('Сьогодні ми розпочали сезон з тріском.'.slice(r[0].start, r[0].end), 'розпочали');
});
