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
const { orderFrom, makeBatches } = await import('../src/lib/analysis.js');
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
  store.settings = { provider: 'deepl', showSentenceTranslation: true };
  const s = await getSettings();
  assert.equal(s.provider, 'gemini');
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

test('analysis starts with the lines near the viewer', () => {
  const b = makeBatches(25, 10);
  assert.deepEqual(orderFrom(b, 14).map((x) => x[0]), [10, 20, 0]);
  assert.deepEqual(orderFrom(b, 0).map((x) => x[0]), [0, 10, 20]);
});

test('the backup AI answers while the main AI is out of its limit', async () => {
  store.settings = {
    provider: 'gemini',
    backupProvider: 'ollama',
    providers: { gemini: { apiKey: 'k', models: ['gemini-3.6-flash'] }, ollama: { host: 'http://localhost:11434', models: ['llama3.2'] } }
  };
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
