// Analyses a transcript a few minutes ahead of the viewer: per sentence a
// translation and every word/expression of difficulty 2+, with type and
// translation. Lines further away are analysed only when someone asks for
// them (Prepare, or seeking in the video). Results are cached per video, so
// filtering by level later is instant.
import { analyzeSentences, noteFor, BadAnswerError, errorKind, needsKey } from './ai.js';
import { getProvider } from './providers/index.js';
import { normalizeWord } from './storage.js';

export const BATCH_SIZE = 10;
// How far ahead of the video position lines are analysed without being asked.
export const WINDOW_MS = 5 * 60000;
const CONCURRENCY = 2;
const KEEP_VIDEOS = 30;
const SAVE_DELAY_MS = 1500;

export function makeBatches(count, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < count; i += size) out.push(Array.from({ length: Math.min(size, count - i) }, (_, k) => i + k));
  return out;
}

// True when any line of the batch plays between `ms` and `ms + windowMs`.
export function inWindow(ids, sentences, ms, windowMs = WINDOW_MS) {
  return ids.some((id) => sentences[id].end >= ms && sentences[id].start <= ms + windowMs);
}

const PAUSE_MS = { limit: 60000, busy: 20000 };
const MISSING_TRIES = 2;

// Items shown as "hard" for a learner level (1..5): everything rated above it.
export function isHardFor(item, level) {
  return item.level > Math.min(Math.max(Number(level) || 3, 1), 5);
}

function inSet(item, set) {
  return set.has(normalizeWord(item.lemma)) || set.has(normalizeWord(item.text));
}

// Already in the learner's cards (by dictionary form or as written).
export function inDeck(item, deck) {
  return inSet(item, deck);
}

// Items offered as new: hard for the level, not known, not in the cards yet.
export function visibleItems(items, level, known, deck = new Set()) {
  return (items ?? []).filter((it) => isHardFor(it, level) && !inSet(it, known) && !inSet(it, deck));
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
  constructor({ settings, videoId, sentences, onUpdate, ms = 0 }) {
    this.settings = settings;
    this.sentences = sentences;
    this.ms = ms; // where the video is now
    this.key = cacheKey(videoId, settings.learningLang, settings.nativeLang);
    this.onUpdate = onUpdate ?? (() => {});
    this.results = new Map(); // sentence id -> { translation, items }
    this.failed = new Map(); // sentence id -> error message
    this.missing = new Map(); // sentence id -> times the AI left it out
    this.queue = []; // arrays of sentence ids not analysed yet
    this.asked = new Set(); // sentence ids someone asked for, wherever the video is
    this.running = 0;
    this.waiters = new Map(); // sentence id -> [resolve]
    this.notes = new WeakMap(); // item -> promise of its memory note
    this.stopped = false;
    this.abort = new AbortController();
    // { kind: 'key' | 'limit' | 'busy', message, until? } while analysis is held up.
    this.error = null;
    this.halted = false; // true until the user fixes the key and retries
    this.pausedUntil = 0;
    this.model = '';
  }

  async start() {
    const cached = (await chrome.storage.local.get(this.key))[this.key];
    for (const r of cached?.results ?? []) this.results.set(r.id, r);
    this.model = cached?.model ?? '';
    await rememberKey(this.key);
    this.queue = makeBatches(this.sentences.length)
      .map((b) => b.filter((id) => !this.results.has(id)))
      .filter((b) => b.length);
    this.checkKey();
    this.onUpdate([]);
    this.pump();
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.timer);
    if (this.saveTimer) this.saveNow();
  }

  // Called as the video plays or the viewer seeks.
  setPosition(ms) {
    this.ms = ms;
    this.pump();
  }

  // Asks for a line outside the window without waiting for it.
  want(id) {
    if (id < 0 || id >= this.sentences.length || this.results.has(id) || this.failed.has(id)) return;
    this.asked.add(id);
    this.pump();
  }

  // Resolves when the sentence is analysed, has failed, or analysis is held up
  // by a key problem.
  ensure(id) {
    if (this.results.has(id) || this.failed.has(id) || this.halted) return Promise.resolve();
    const done = new Promise((resolve) => {
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
    });
    this.want(id);
    return done;
  }

  // The memory note of an analysed item, asked from the AI the first time
  // it is needed. Resolves to '' when it cannot be had.
  note(item, sentence) {
    if (item.note) return Promise.resolve(item.note);
    if (!this.notes.has(item)) {
      this.notes.set(
        item,
        noteFor(this.settings, { lemma: item.lemma || item.text, translation: item.translation, sentence }).then(
          (note) => {
            item.note = note;
            if (note) this.saveSoon();
            return note;
          },
          () => ''
        )
      );
    }
    return this.notes.get(item);
  }

  checkKey() {
    if (this.queue.length && needsKey(this.settings)) {
      this.hold({ kind: 'key', message: `Add your ${getProvider(this.settings.provider).name} key in Settings to see hard words and translations.` });
    }
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
    this.checkKey();
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
      this.asked.delete(id);
      for (const resolve of this.waiters.get(id) ?? []) resolve();
      this.waiters.delete(id);
    }
  }

  // The next batch worth analysing now: one that holds a line someone asked
  // for, else the first one inside the window ahead of the video.
  takeNext() {
    let i = this.queue.findIndex((b) => b.some((id) => this.asked.has(id)));
    if (i < 0) i = this.queue.findIndex((b) => inWindow(b, this.sentences, this.ms));
    return i < 0 ? null : this.queue.splice(i, 1)[0];
  }

  pump() {
    while (!this.stopped && !this.halted && Date.now() >= this.pausedUntil && this.running < CONCURRENCY) {
      const ids = this.takeNext();
      if (!ids) break;
      if (!this.running) this.onUpdate([]); // show that analysis is at work
      this.running++;
      this.runBatch(ids).finally(() => {
        this.running--;
        this.onUpdate(ids);
        this.pump();
      });
    }
  }

  // Saving rewrites the whole video, so a burst of results is saved once.
  saveSoon() {
    this.saveTimer ??= setTimeout(() => this.saveNow(), SAVE_DELAY_MS);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      await chrome.storage.local.set({ [this.key]: { results: [...this.results.values()], model: this.model, at: Date.now() } });
    } catch {
      /* the results stay in memory for this session */
    }
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
      this.saveSoon();
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
