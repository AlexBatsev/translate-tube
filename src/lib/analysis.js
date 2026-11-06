// Analyses a whole transcript once: per sentence a translation and every
// word/expression of difficulty 2+, with type, translation and breakdown.
// Results are cached per video so filtering by level later is instant.
import { analyzeSentences, BadAnswerError } from './ai.js';
import { normalizeWord } from './storage.js';

export const BATCH_SIZE = 10;
const CONCURRENCY = 2;
const KEEP_VIDEOS = 30;

export function makeBatches(count, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < count; i += size) out.push(Array.from({ length: Math.min(size, count - i) }, (_, k) => i + k));
  return out;
}

// Items shown as "hard" for a learner level (1..6). Level 6 still shows the
// rarest items, so the filter never becomes empty by definition.
export function isHardFor(item, level) {
  return item.level > Math.min(Number(level) || 3, 5);
}

export function visibleItems(items, level, known) {
  return (items ?? []).filter(
    (it) => isHardFor(it, level) && !known.has(normalizeWord(it.lemma)) && !known.has(normalizeWord(it.text))
  );
}

function cacheKey(videoId, from, to) {
  return `analysis:v2:${videoId}:${from}:${to}`;
}

async function rememberKey(key) {
  const { analysisIndex = [] } = await chrome.storage.local.get('analysisIndex');
  const next = [key, ...analysisIndex.filter((k) => k !== key)];
  const drop = next.slice(KEEP_VIDEOS);
  await chrome.storage.local.set({ analysisIndex: next.slice(0, KEEP_VIDEOS) });
  if (drop.length) await chrome.storage.local.remove(drop);
}

export class TranscriptAnalysis {
  constructor({ settings, videoId, sentences, onUpdate }) {
    this.settings = settings;
    this.sentences = sentences;
    this.key = cacheKey(videoId, settings.learningLang, settings.nativeLang);
    this.onUpdate = onUpdate ?? (() => {});
    this.results = new Map(); // sentence id -> { translation, items }
    this.failed = new Map(); // sentence id -> error message
    this.queue = []; // arrays of sentence ids waiting
    this.running = 0;
    this.waiters = new Map(); // sentence id -> [resolve]
    this.stopped = false;
  }

  get done() {
    return this.results.size;
  }

  get total() {
    return this.sentences.length;
  }

  async start() {
    const cached = (await chrome.storage.local.get(this.key))[this.key];
    for (const r of cached?.results ?? []) this.results.set(r.id, r);
    await rememberKey(this.key);
    this.queue = makeBatches(this.total).map((b) => b.filter((id) => !this.results.has(id))).filter((b) => b.length);
    this.onUpdate();
    this.pump();
  }

  stop() {
    this.stopped = true;
  }

  // Resolves when the sentence is analysed or has failed.
  ensure(id) {
    if (this.results.has(id) || this.failed.has(id)) return Promise.resolve();
    // Move its batch to the front so the reader never waits long.
    const i = this.queue.findIndex((b) => b.includes(id));
    if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
    return new Promise((resolve) => {
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
    });
  }

  retryFailed() {
    const ids = [...this.failed.keys()].sort((a, b) => a - b);
    this.failed.clear();
    for (let i = 0; i < ids.length; i += BATCH_SIZE) this.queue.push(ids.slice(i, i + BATCH_SIZE));
    this.onUpdate();
    this.pump();
  }

  settle(ids) {
    for (const id of ids) {
      for (const resolve of this.waiters.get(id) ?? []) resolve();
      this.waiters.delete(id);
    }
  }

  pump() {
    while (!this.stopped && this.running < CONCURRENCY && this.queue.length) {
      const ids = this.queue.shift();
      this.running++;
      this.runBatch(ids).finally(() => {
        this.running--;
        this.onUpdate();
        this.pump();
      });
    }
  }

  async runBatch(ids, attempt = 1) {
    const input = ids.map((id) => ({ id, text: this.sentences[id].text }));
    try {
      const out = await analyzeSentences(this.settings, input);
      if (this.stopped) return;
      for (const r of out) this.results.set(r.id, r);
      await chrome.storage.local.set({ [this.key]: { results: [...this.results.values()], at: Date.now() } });
      this.settle(ids);
    } catch (e) {
      if (this.stopped) return;
      if (e instanceof BadAnswerError && attempt === 1) return this.runBatch(ids, 2);
      if (e instanceof BadAnswerError && ids.length > 2) {
        // Smaller pieces are much less likely to come back garbled.
        const half = Math.ceil(ids.length / 2);
        await this.runBatch(ids.slice(0, half), 1);
        await this.runBatch(ids.slice(half), 1);
        return;
      }
      for (const id of ids) this.failed.set(id, e.message);
      this.settle(ids);
    }
  }
}
