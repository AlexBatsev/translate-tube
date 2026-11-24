import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBatches, isHardFor, visibleItems } from '../src/lib/analysis.js';
import { draftToCards, groupByVideo } from '../src/lib/drafts.js';
import { noteHtml } from '../src/lib/card.js';

test('makeBatches splits ids into fixed-size groups', () => {
  assert.deepEqual(makeBatches(5, 2), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(makeBatches(0, 2), []);
});

test('visibleItems filters by level and known words', () => {
  const items = [
    { text: 'cat', lemma: 'cat', level: 2 },
    { text: 'blew it', lemma: 'blow it', level: 4 },
    { text: 'nook', lemma: 'nook', level: 6 }
  ];
  assert.deepEqual(visibleItems(items, 1, new Set()).map((i) => i.text), ['cat', 'blew it', 'nook']);
  assert.deepEqual(visibleItems(items, 3, new Set()).map((i) => i.text), ['blew it', 'nook']);
  assert.deepEqual(visibleItems(items, 3, new Set(['blow it'])).map((i) => i.text), ['nook']);
  // Words already in the cards are not offered again.
  assert.deepEqual(visibleItems(items, 1, new Set(), new Set(['blow it'])).map((i) => i.text), ['cat', 'nook']);
  // Every level changes what is shown; the top one still shows the rarest words.
  assert.equal(isHardFor({ level: 5 }, 4), true);
  assert.equal(isHardFor({ level: 5 }, 5), false);
  assert.equal(isHardFor({ level: 6 }, 5), true);
  assert.deepEqual(visibleItems(undefined, 3, new Set()), []);
});

const draft = {
  id: '1',
  term: 'nook and cranny',
  lemma: 'every nook and cranny',
  translation: 'кожен куточок',
  note: '',
  kind: 'idiom',
  parts: [
    { text: 'nook', translation: 'закуток', checked: true },
    { text: 'cranny', translation: 'щілина', checked: false }
  ],
  includeWhole: true,
  sentence: 'We searched every nook and cranny.',
  videoId: 'v1',
  videoTitle: 'One',
  ms: 1000
};

test('draftToCards makes the whole phrase plus each ticked word', () => {
  const cards = draftToCards(draft);
  assert.deepEqual(cards.map((c) => c.term), ['every nook and cranny', 'nook']);
  assert.equal(cards[0].surface, 'nook and cranny');
  assert.equal(cards[1].note, 'every nook and cranny — кожен куточок');
  assert.deepEqual(draftToCards({ ...draft, includeWhole: false }).map((c) => c.term), ['nook']);
});

test('groupByVideo keeps order of first appearance', () => {
  const g = groupByVideo([draft, { ...draft, id: '2', videoId: 'v2' }, { ...draft, id: '3' }]);
  assert.deepEqual(g.map((x) => [x.videoId, x.drafts.length]), [['v1', 2], ['v2', 1]]);
});

test('noteHtml shows kind, note and the word breakdown', () => {
  const h = noteHtml({ note: 'image', kind: 'idiom', parts: draft.parts });
  assert.match(h, /<i>idiom<\/i>/);
  assert.match(h, /nook — закуток<br>cranny — щілина/);
  assert.equal(noteHtml({ note: 'x', kind: 'word', parts: [] }), 'x');
});
