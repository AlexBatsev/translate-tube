import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCard, boldTerm, videoLink, cardsToTsv } from '../src/lib/card.js';

test('videoLink starts a second early', () => {
  assert.equal(videoLink('abc', 65400), 'https://www.youtube.com/watch?v=abc&t=64s');
  assert.equal(videoLink('abc', 200), 'https://www.youtube.com/watch?v=abc&t=0s');
});

test('boldTerm bolds the whole word only and escapes html', () => {
  assert.equal(boldTerm('The cat <3 cats', 'cat'), 'The <b>cat</b> &lt;3 cats');
  assert.equal(boldTerm('Concatenate the cat', 'cat'), 'Concatenate the <b>cat</b>');
});

test('buildCard fills every note field', () => {
  const c = buildCard({ term: 'kick off', translation: 'почати', note: 'n', sentence: 'We kick off now.', sentenceTranslation: 's', videoId: 'v1', videoTitle: 'T', ms: 3000 });
  assert.equal(c.Sentence, 'We <b>kick off</b> now.');
  assert.equal(c.VideoLink, 'https://www.youtube.com/watch?v=v1&t=2s');
  assert.equal(Object.keys(c).length, 7);
});

test('buildCard shows the dictionary form but bolds the form from the video', () => {
  const c = buildCard({ term: 'blow it', surface: 'blew it', translation: 'x', sentence: 'I totally blew it today.' });
  assert.equal(c.Word, 'blow it');
  assert.equal(c.Sentence, 'I totally <b>blew it</b> today.');
});

test('cardsToTsv writes Anki import headers', () => {
  const tsv = cardsToTsv([{ fields: buildCard({ term: 'a\tb', translation: 'x' }) }], 'Deck');
  const lines = tsv.trim().split('\n');
  assert.equal(lines[2], '#notetype:Translate Tube');
  assert.equal(lines[5].split('\t').length, 8);
  assert.ok(lines[5].startsWith('a b\t'));
});
