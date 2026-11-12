import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal in-memory chrome.storage for code that saves settings and words.
let store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
      },
      async set(obj) {
        Object.assign(store, structuredClone(obj));
      },
      async remove(keys) {
        for (const k of [].concat(keys)) delete store[k];
      }
    }
  }
};
beforeEach(() => (store = {}));

const { markKnown, undoKnown, getSettings, rememberVideo, getHistory, videoUrl } = await import('../src/lib/storage.js');
const { errorKind, explainTerm } = await import('../src/lib/ai.js');
const { inWindow, makeBatches, TranscriptAnalysis } = await import('../src/lib/analysis.js');
const { deckWords, speakTag } = await import('../src/lib/anki.js');
const { ProviderError } = await import('../src/lib/providers/http.js');

test('"I know it" can be undone step by step, newest first', async () => {
  await markKnown(['Reluctant']);
  await markKnown(['blow it', 'blew it']);
  assert.deepEqual(await markKnown(['reluctant']), []); // already known: no new undo step
  assert.deepEqual(store.knownWords, ['reluctant', 'blow it', 'blew it']);
  assert.deepEqual(await undoKnown(), ['blow it', 'blew it']);
  assert.deepEqual(store.knownWords, ['reluctant']);
  assert.deepEqual(await undoKnown(), ['reluctant']);
  assert.deepEqual(await undoKnown(), []);
});

test('old settings are upgraded', async () => {
  store.settings = { provider: 'deepl', showSentenceTranslation: true, level: 6 };
  const s = await getSettings();
  assert.equal(s.provider, 'gemini');
  assert.equal(s.level, 5);
  assert.equal(s.showSentenceTranslation, 'all');
});

test('recent videos keep one entry per video, newest first', async () => {
  await rememberVideo({ videoId: 'a', title: 'A', ms: 1000 });
  await rememberVideo({ videoId: 'b', title: 'B', ms: 0, shorts: true });
  await rememberVideo({ videoId: 'a', title: 'A', ms: 95000 });
  const h = await getHistory();
  assert.deepEqual(h.map((x) => [x.videoId, x.ms]), [['a', 95000], ['b', 0]]);
  assert.equal(videoUrl(h[0]), 'https://www.youtube.com/watch?v=a&t=95s');
  assert.equal(videoUrl(h[1]), 'https://www.youtube.com/shorts/b');
});

test('errorKind tells key, limit and other problems apart', () => {
  assert.equal(errorKind(new ProviderError('401: bad', 401)), 'key');
  assert.equal(errorKind(new ProviderError('400: API key not valid. Please pass a valid API key.', 400)), 'key');
  assert.equal(errorKind(new ProviderError('429: quota', 429)), 'limit');
  assert.equal(errorKind(new ProviderError('500: oops', 500)), '');
});

// 30 lines of 10 s each.
const lines = Array.from({ length: 30 }, (_, id) => ({ id, text: `line ${id}`, start: id * 10000, end: id * 10000 + 9000 }));

test('only lines a few minutes ahead of the video are in the window', () => {
  const b = makeBatches(30, 10);
  assert.deepEqual(b.map((ids) => inWindow(ids, lines, 0, 60000)), [true, false, false]);
  assert.deepEqual(b.map((ids) => inWindow(ids, lines, 95000, 60000)), [true, true, false]);
  assert.deepEqual(b.map((ids) => inWindow(ids, lines, 250000, 60000)), [false, false, true]);
});

test('analysis follows the video and does lines elsewhere only when asked', async () => {
  store.settings = { setupDone: true, provider: 'ollama', providers: { ollama: { host: 'http://localhost:11434', model: 'm' } } };
  const asked = [];
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).messages[1].content;
    const ids = [...prompt.matchAll(/^(\d+): line/gm)].map((m) => Number(m[1]));
    asked.push(ids[0]);
    const sentences = ids.map((id) => ({ id, translation: 't', items: [] }));
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ sentences }) } }));
  };
  const long = Array.from({ length: 100 }, (_, id) => ({ id, text: `line ${id}`, start: id * 10000, end: id * 10000 + 9000 }));
  const a = new TranscriptAnalysis({ settings: await getSettings(), videoId: 'v', sentences: long, ms: 0 });
  await a.start();
  const idle = async () => {
    while (a.running) await new Promise((r) => setTimeout(r, 5));
  };
  await idle();
  // 5 minutes = lines 0..30: four batches, nothing further.
  assert.deepEqual([...asked].sort((x, y) => x - y), [0, 10, 20, 30]);
  assert.equal(a.results.has(50), false);
  // Prepare (or a click) asks for a line far ahead: only its batch is done.
  await a.ensure(75);
  await idle();
  assert.equal(a.results.has(75), true);
  assert.equal(asked.length, 5);
  // The viewer seeks: the window moves with them.
  a.setPosition(600000);
  await idle();
  assert.equal(a.results.has(60), true);
  assert.equal(a.results.has(45), false);
  a.stop();
});

test('words already in Anki are read from the deck, whatever made the cards', async () => {
  globalThis.fetch = async (_url, init) => {
    const { action, params } = JSON.parse(init.body);
    if (action === 'findNotes') {
      assert.match(params.query, /deck:My deck/);
      return new Response(JSON.stringify({ result: [1, 2, 3], error: null }));
    }
    const notes = [
      { fields: { Word: { value: 'Blow it', order: 0 }, Translation: { value: 'x', order: 1 } } },
      { fields: { Front: { value: '<b>reluctant</b>&nbsp;', order: 0 } } },
      { fields: { Back: { value: 'ignored', order: 1 }, Front: { value: '', order: 0 } } }
    ];
    return new Response(JSON.stringify({ result: notes, error: null }));
  };
  assert.deepEqual(await deckWords({ url: 'http://127.0.0.1:8765', deck: 'My deck' }), ['blow it', 'reluctant']);
});

test('the card speaks the word in the learning language', () => {
  assert.equal(speakTag('en'), '{{tts en_US:Word}}');
  assert.equal(speakTag('xx'), '');
});

test('the backup AI answers while the main AI is out of its limit', async () => {
  store.settings = {
    provider: 'gemini',
    backupProvider: 'ollama',
    providers: { gemini: { apiKey: 'k' }, ollama: { host: 'http://localhost:11434' } }
  };
  store.aiState = { gemini: { models: ['gemini-3.6-flash'] }, ollama: { models: ['llama3.2'] } };
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url).host);
    if (String(url).includes('generativelanguage')) return new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
    const item = { text: 'reluctant', lemma: 'reluctant', kind: 'word', level: 4, translation: 'неохочий' };
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ item, sentenceTranslation: 'x' }) } }));
  };
  const settings = await getSettings();
  const r = await explainTerm(settings, { term: 'reluctant', sentence: 'I was reluctant.' });
  assert.equal(r.item.translation, 'неохочий');
  assert.deepEqual(calls, ['generativelanguage.googleapis.com', 'localhost:11434']);
  // While the main AI is paused, the backup goes first.
  calls.length = 0;
  await explainTerm(settings, { term: 'reluctant', sentence: 'I was reluctant.' });
  assert.deepEqual(calls, ['localhost:11434']);
});
