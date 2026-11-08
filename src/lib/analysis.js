// Analyses a whole transcript once: per sentence a translation and every
// word/expression of difficulty 2+, with type, translation and breakdown.
// Results are cached per video so filtering by level later is instant.
import { analyzeSentences, BadAnswerError, errorKind, needsKey } from './ai.js';
import { getProvider } from './providers/index.js';
import { normalizeWord } from './storage.js';

export const BATCH_SIZE = 10;
const CONCURRENCY = 2;
const KEEP_VIDEOS = 30;

export function makeBatches(count, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < count; i += size) out.push(Array.from({ length: Math.min(size, count - i) }, (_, k) => i + k));
  return out;
}

// Batches starting with the one that holds `startId`, then the rest of the
// video, then the part before it, so lines near the viewer come first.
export function orderFrom(batches, startId) {
  const i = batches.findIndex((b) => b.includes(startId));
  return i > 0 ? [...batches.slice(i), ...batches.slice(0, i)] : batches;
}

const PAUSE_MS = { limit: 60000, busy: 20000 };
const MISSING_TRIES = 2;

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
  constructor({ settings, videoId, sentences, onUpdate, startId = 0 }) {
    this.settings = settings;
    this.sentences = sentences;
    this.startId = startId;
    this.key = cacheKey(videoId, settings.learningLang, settings.nativeLang);
    this.onUpdate = onUpdate ?? (() => {});
    this.results = new Map(); // sentence id -> { translation, items }
    this.failed = new Map(); // sentence id -> error message
    this.missing = new Map(); // sentence id -> times the AI left it out
    this.queue = []; // arrays of sentence ids waiting
    this.running = 0;
    this.waiters = new Map(); // sentence id -> [resolve]
    this.stopped = false;
    this.abort = new AbortController();
    // { kind: 'key' | 'limit' | 'busy', message, until? } while analysis is held up.
    this.error = null;
    this.halted = false; // true until the user fixes the key and retries
    this.pausedUntil = 0;
    this.model = '';
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
    this.model = cached?.model ?? '';
    await rememberKey(this.key);
    const size = Number(this.settings.batchSize) || BATCH_SIZE;
    this.queue = orderFrom(makeBatches(this.total, size), this.startId)
      .map((b) => b.filter((id) => !this.results.has(id)))
      .filter((b) => b.length);
    if (this.queue.length && needsKey(this.settings)) {
      this.hold({ kind: 'key', message: `Add your ${getProvider(this.settings.provider).name} key in Settings to see hard words and translations.` });
    }
    this.onUpdate([]);
    this.pump();
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.timer);
  }

  // Resolves when the sentence is analysed, has failed, or analysis is held up
  // by a key problem.
  ensure(id) {
    if (this.results.has(id) || this.failed.has(id) || this.halted) return Promise.resolve();
    // Move its batch to the front so the reader never waits long.
    const i = this.queue.findIndex((b) => b.includes(id));
    if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
    return new Promise((resolve) => {
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
    });
  }

  // Retry button: failed lines go back in the queue and a held-up analysis resumes.
  retry() {
    const ids = [...this.failed.keys()].sort((a, b) => a - b);
    this.failed.clear();
    for (let i = 0; i < ids.length; i += BATCH_SIZE) this.queue.push(ids.slice(i, i + BATCH_SIZE));
    this.error = null;
    this.halted = false;
    this.pausedUntil = 0;
    clearTimeout(this.timer);
    if (this.queue.length && needsKey(this.settings)) {
      this.hold({ kind: 'key', message: `Add your ${getProvider(this.settings.provider).name} key in Settings to see hard words and translations.` });
    }
    this.onUpdate([]);
    this.pump();
  }

  // Stops sending requests: until retry() for a key problem, or for a while
  // for a limit or busy service, then continues by itself.
  hold(error) {
    if (error.kind === 'key') {
      this.halted = true;
      this.error = error;
      // Nobody should wait for lines that will not come until the key is fixed.
      for (const [id] of this.waiters) this.settle([id]);
      return;
    }
    const until = Date.now() + PAUSE_MS[error.kind];
    if (until <= this.pausedUntil) return;
    this.pausedUntil = until;
    this.error = { ...error, until };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.error = null;
      this.pausedUntil = 0;
      this.onUpdate([]);
      this.pump();
    }, PAUSE_MS[error.kind]);
  }

  settle(ids) {
    for (const id of ids) {
      for (const resolve of this.waiters.get(id) ?? []) resolve();
      this.waiters.delete(id);
    }
  }

  pump() {
    while (!this.stopped && !this.halted && Date.now() >= this.pausedUntil && this.running < CONCURRENCY && this.queue.length) {
      const ids = this.queue.shift();
      this.running++;
      this.runBatch(ids).finally(() => {
        this.running--;
        this.onUpdate(ids);
        this.pump();
      });
    }
  }

  async save() {
    await chrome.storage.local.set({ [this.key]: { results: [...this.results.values()], model: this.model, at: Date.now() } });
  }

  async runBatch(ids, attempt = 1) {
    const input = ids.map((id) => ({ id, text: this.sentences[id].text }));
    try {
      const { results, model } = await analyzeSentences(this.settings, input, { signal: this.abort.signal });
      if (this.stopped) return;
      this.model = model || this.model;
      const again = [];
      for (const r of results) {
        if (!r.missing) {
          this.results.set(r.id, r);
          continue;
        }
        // The AI skipped this line: ask again a couple of times, then give up quietly.
        const n = (this.missing.get(r.id) ?? 0) + 1;
        this.missing.set(r.id, n);
        if (n <= MISSING_TRIES) again.push(r.id);
        else this.results.set(r.id, { id: r.id, translation: '', items: [] });
      }
      if (again.length) this.queue.unshift(again);
      await this.save();
      this.settle(ids.filter((id) => this.results.has(id)));
    } catch (e) {
      if (this.stopped || e.cancelled) return;
      if (e instanceof BadAnswerError && attempt === 1) return this.runBatch(ids, 2);
      if (e instanceof BadAnswerError && ids.length > 2) {
        // Smaller pieces are much less likely to come back garbled.
        const half = Math.ceil(ids.length / 2);
        await this.runBatch(ids.slice(0, half), 1);
        await this.runBatch(ids.slice(half), 1);
        return;
      }
      const kind = errorKind(e);
      if (kind === 'key' || kind === 'limit' || kind === 'busy') {
        this.queue.unshift(ids); // keep them; they run when analysis continues
        this.hold({ kind, message: e.message });
        return;
      }
      for (const id of ids) this.failed.set(id, e.message);
      this.settle(ids);
    }
  }
}
