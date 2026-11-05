import { getSettings, getWordSets, addWords, normalizeWord } from '../lib/storage.js';
import { parseJson3, buildSentences, sentenceAt, tokenize, markHighlights } from '../lib/transcript.js';
import { explainTerm, analyzeSentences } from '../lib/ai.js';
import { getProvider } from '../lib/providers/index.js';
import { cardsToTsv, escapeHtml } from '../lib/card.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  words: { known: new Set(), deck: new Set() },
  tabId: null,
  videoId: null,
  title: '',
  sentences: [],
  activeIdx: -1,
  ms: 0,
  paused: true,
  follow: true,
  tab: 'transcript',
  popoverCard: null,
  loadingTranscript: false
};

// ---------- helpers ----------

function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

async function toTab(msg) {
  if (state.tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(state.tabId, msg);
  } catch {
    return null;
  }
}

async function bg(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || 'Something went wrong.');
  return r.result;
}

// ---------- tabs ----------

function showTab(name) {
  state.tab = name;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('.tab-body')) s.hidden = s.id !== `tab-${name}`;
  if (name === 'cards') renderCards();
  if (name === 'prepare' && prep.started) $('prep-card').focus();
}

document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---------- video tracking ----------

// ?tabId=N pins the panel to one tab (used when opening the panel page in a
// normal tab for debugging and automated tests).
const pinnedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

async function findTab() {
  if (pinnedTabId) {
    state.tabId = pinnedTabId;
    return chrome.tabs.get(pinnedTabId);
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const isYt = tab?.url?.startsWith('https://www.youtube.com/');
  state.tabId = isYt ? tab.id : null;
  return tab;
}

async function poll() {
  const info = await toTab({ type: 'tt:info' });
  if (!info) {
    if (state.tabId != null && !poll.injected) {
      poll.injected = true;
      await bg('bg:injectTab', { tabId: state.tabId }).catch(() => {});
    }
    if (!state.videoId) setTranscriptStatus('Open a YouTube video to see its transcript.');
    return;
  }
  if (info.videoId !== state.videoId) {
    state.videoId = info.videoId;
    state.title = info.title;
    $('video-title').textContent = info.videoId ? info.title : '';
    resetPrep();
    if (info.videoId) loadTranscript();
    else {
      state.sentences = [];
      renderTranscript();
      setTranscriptStatus('Open a YouTube video to see its transcript.');
    }
  }
  state.ms = info.ms;
  state.paused = info.paused;
  if (info.title && info.title !== state.title) {
    state.title = info.title;
    $('video-title').textContent = info.title;
  }
  updateActive();
}

chrome.tabs.onActivated.addListener(async () => {
  poll.injected = false;
  await findTab();
});
chrome.tabs.onUpdated.addListener(async (id, change) => {
  if (change.url || change.status === 'complete') await findTab();
});

// ---------- transcript ----------

function setTranscriptStatus(html) {
  $('transcript-status').innerHTML = html;
}

async function loadTranscript(retry = 0) {
  if (state.loadingTranscript) return;
  state.loadingTranscript = true;
  const videoId = state.videoId;
  state.sentences = [];
  renderTranscript();
  setTranscriptStatus('<span class="spinner"></span>Loading transcript…');
  try {
    const r = await toTab({ type: 'tt:transcript', lang: state.settings.learningLang });
    if (videoId !== state.videoId) return;
    if (!r?.ok) {
      if ((r?.reason === 'not-ready' || !r) && retry < 5) {
        state.loadingTranscript = false;
        setTimeout(() => loadTranscript(retry + 1), 1200);
        return;
      }
      const why = {
        'no-captions': 'This video has no subtitles, so there is no transcript.',
        'no-language': `No subtitles in your learning language. Available: ${escapeHtml((r.available || []).join(', '))}.`,
        blocked: 'YouTube did not return the subtitles. Press <b>C</b> on the video to turn subtitles on once, then <button id="retry-tr" class="link">try again</button>.',
        'not-ready': 'The video page is still loading. <button id="retry-tr" class="link">Try again</button>'
      }[r?.reason] ?? `Could not load the transcript. <button id="retry-tr" class="link">Try again</button>`;
      setTranscriptStatus(why);
      $('retry-tr')?.addEventListener('click', () => loadTranscript());
      return;
    }
    state.sentences = buildSentences(parseJson3(r.json));
    setTranscriptStatus(r.track.kind === 'asr' ? 'Auto-generated subtitles: sentences may be split imperfectly.' : '');
    renderTranscript();
    updateActive(true);
  } finally {
    state.loadingTranscript = false;
  }
}

function wordClass(word) {
  return state.words.deck.has(normalizeWord(word)) ? 'w deck' : 'w';
}

function sentenceHtml(text, highlights = [], currentHighlight = -1) {
  const tokens = tokenize(text);
  const marks = markHighlights(tokens, highlights);
  let html = '';
  let open = -1; // highlight group currently open
  tokens.forEach((t, i) => {
    if (marks[i] !== open) {
      if (open >= 0) html += '</span>';
      open = marks[i];
      if (open >= 0) html += `<span class="hard${open === currentHighlight ? ' current' : ''}" data-h="${open}">`;
    }
    html += t.word ? `<span class="${wordClass(t.text)}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text);
  });
  if (open >= 0) html += '</span>';
  return html;
}

function renderTranscript() {
  const el = $('transcript');
  el.innerHTML = state.sentences
    .map(
      (s) =>
        `<div class="line" data-id="${s.id}"><span class="ts" data-ms="${s.start}">${fmtTime(s.start)}</span><span class="tx">${sentenceHtml(s.text)}</span></div>`
    )
    .join('');
  state.activeIdx = -1;
}

function updateActive(force = false) {
  if (!state.sentences.length) return;
  const idx = sentenceAt(state.sentences, state.ms + 150);
  if (idx === state.activeIdx && !force) return;
  state.activeIdx = idx;
  const lines = $('transcript').children;
  for (let i = 0; i < lines.length; i++) {
    const d = i - idx;
    lines[i].className = `line${d === 0 ? ' active' : d < 0 ? ' past' : ''}${Math.abs(d) <= 2 && d !== 0 ? ' near' : ''}`;
  }
  if (state.follow && idx >= 0 && state.tab === 'transcript') {
    lines[idx]?.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
  }
}

// Stop following when the user scrolls by hand.
['wheel', 'touchmove'].forEach((ev) =>
  $('tab-transcript').addEventListener(ev, () => {
    state.follow = false;
    $('follow-now').hidden = false;
  }, { passive: true })
);
$('follow-now').addEventListener('click', () => {
  state.follow = true;
  $('follow-now').hidden = true;
  updateActive(true);
});

$('transcript').addEventListener('click', (e) => {
  const ts = e.target.closest('.ts');
  if (ts) {
    toTab({ type: 'tt:seek', ms: Number(ts.dataset.ms) });
    return;
  }
  const w = e.target.closest('.w');
  if (!w) return;
  const sel = window.getSelection();
  if (sel && String(sel).trim().length > 1) return; // handled by mouseup
  const line = w.closest('.line');
  openLookup(w.textContent, Number(line.dataset.id));
});

$('transcript').addEventListener('mouseup', () => {
  const sel = window.getSelection();
  const text = String(sel || '').replace(/\s+/g, ' ').trim();
  // Single words are handled by the click handler; this is for phrases.
  if (!text.includes(' ')) return;
  const line = sel.anchorNode?.parentElement?.closest('.line');
  if (!line) return;
  openLookup(text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''), Number(line.dataset.id));
});

// ---------- lookup popover ----------

async function openLookup(term, sentenceId) {
  const s = state.sentences[sentenceId];
  if (!s || !term) return;
  if (state.settings.pauseOnClick && !state.paused) toTab({ type: 'tt:pause' });
  const prev = state.sentences[sentenceId - 1]?.text;
  showPopover(`<div class="term">${escapeHtml(term)}</div><div class="status"><span class="spinner"></span>Translating in context…</div>`);
  const token = (openLookup.token = {});
  try {
    const r = await explainTerm(state.settings, { term, sentence: s.text, previous: prev });
    if (token !== openLookup.token) return;
    renderLookup({ ...r, sentence: s.text, ms: s.start });
  } catch (e) {
    if (token !== openLookup.token) return;
    showPopover(`<div class="term">${escapeHtml(term)}</div><div class="status"><span class="err">${escapeHtml(e.message)}</span></div>`);
  }
}

function renderLookup(card) {
  state.popoverCard = card;
  const inDeck = state.words.deck.has(normalizeWord(card.lemma || card.term));
  showPopover(`
    <div class="term">${escapeHtml(card.term)}${card.lemma && card.lemma.toLowerCase() !== card.term.toLowerCase() ? `<small>${escapeHtml(card.lemma)}</small>` : ''}${card.isIdiom ? '<small>idiom</small>' : ''}</div>
    <div class="translation">${escapeHtml(card.translation)}</div>
    ${card.note ? `<div class="note">${escapeHtml(card.note)}</div>` : ''}
    ${card.sentenceTranslation ? `<div class="sent-tr">${escapeHtml(card.sentenceTranslation)}</div>` : ''}
    <div class="row">
      <button class="primary" id="pop-add">${inDeck ? 'Add again' : 'Add to Anki'} <kbd>A</kbd></button>
      <button id="pop-replay">▶ Replay line</button>
      <button id="pop-known" class="link">I know this</button>
    </div>`);
  $('pop-add').addEventListener('click', () => addCard(card));
  $('pop-replay').addEventListener('click', () => {
    toTab({ type: 'tt:seek', ms: card.ms });
    toTab({ type: 'tt:play' });
  });
  $('pop-known').addEventListener('click', async () => {
    await addWords('knownWords', [card.lemma || card.term]);
    state.words = await getWordSets();
    toast('Marked as known');
    hidePopover();
  });
}

function showPopover(html) {
  $('popover-body').innerHTML = html;
  $('popover').hidden = false;
}

function hidePopover() {
  $('popover').hidden = true;
  state.popoverCard = null;
}

$('popover-close').addEventListener('click', hidePopover);

async function addCard(card) {
  try {
    const r = await bg('bg:addCard', {
      card: {
        term: card.term,
        lemma: card.lemma,
        translation: card.translation,
        note: card.note,
        sentence: card.sentence,
        sentenceTranslation: card.sentenceTranslation,
        videoId: state.videoId,
        videoTitle: state.title,
        ms: card.ms
      }
    });
    state.words = await getWordSets();
    toast(r.queued ? `Saved. Anki is closed, so it will be sent later (${r.left} waiting).` : `Added “${card.term}” to Anki`);
    refreshQueueCount();
    if (state.popoverCard === card) hidePopover();
    // Refresh underline styles for the newly added word.
    document.querySelectorAll('#transcript .w').forEach((w) => {
      if (state.words.deck.has(normalizeWord(w.textContent))) w.classList.add('deck');
    });
    return true;
  } catch (e) {
    toast(e.message, 4000);
    return false;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  if (state.tab === 'prepare' && prep.started) return; // prepare has its own keys
  if (!$('popover').hidden) {
    if (e.key === 'Escape') hidePopover();
    if ((e.key === 'a' || e.key === 'A') && state.popoverCard) addCard(state.popoverCard);
  }
});

// ---------- prepare ----------

const prep = {
  started: false,
  idx: 0, // index in state.sentences
  results: new Map(), // sentence id -> { translation, hard: [...] }
  pending: new Set(),
  showTranslation: false,
  wordIdx: 0,
  extra: [], // items looked up by clicking non-highlighted words
  onlyHard: true,
  history: []
};

function resetPrep() {
  prep.started = false;
  prep.idx = 0;
  prep.results = new Map();
  prep.pending = new Set();
  prep.history = [];
  $('prep-start').hidden = false;
  $('prep-card').hidden = true;
  $('prep-status').textContent = '';
}

function cacheKey() {
  return `prep:${state.videoId}:${state.settings.learningLang}:${state.settings.nativeLang}`;
}

async function loadPrepCache() {
  const key = cacheKey();
  const data = (await chrome.storage.local.get(key))[key];
  if (data?.results) for (const r of data.results) prep.results.set(r.id, r);
  return data?.idx ?? 0;
}

async function savePrepCache() {
  await chrome.storage.local.set({ [cacheKey()]: { idx: prep.idx, results: [...prep.results.values()], at: Date.now() } });
}

function visibleHard(id) {
  const r = prep.results.get(id);
  if (!r) return [];
  return r.hard.filter((h) => !state.words.known.has(normalizeWord(h.lemma || h.text)) && !state.words.known.has(normalizeWord(h.text)));
}

const BATCH = 12;

async function ensureAnalyzed(fromIdx) {
  const ids = [];
  for (let i = fromIdx; i < state.sentences.length && ids.length < BATCH; i++) {
    if (!prep.results.has(i) && !prep.pending.has(i)) ids.push(i);
  }
  if (!ids.length) return;
  ids.forEach((i) => prep.pending.add(i));
  try {
    const words = { known: [...state.words.known], deck: [...state.words.deck] };
    const out = await analyzeSentences(state.settings, ids.map((i) => ({ id: i, text: state.sentences[i].text })), words);
    out.forEach((r) => prep.results.set(r.id, r));
    savePrepCache();
  } catch (e) {
    $('prep-status').innerHTML = `<span class="err">${escapeHtml(e.message)}</span>`;
  } finally {
    ids.forEach((i) => prep.pending.delete(i));
  }
}

function prefetch() {
  // Keep about two batches analysed ahead of the current sentence.
  let ahead = 0;
  for (let i = prep.idx; i < state.sentences.length && ahead < BATCH; i++) if (prep.results.has(i)) ahead++;
  if (ahead < BATCH) {
    let first = prep.idx;
    while (prep.results.has(first) || prep.pending.has(first)) first++;
    if (first < state.sentences.length) ensureAnalyzed(first);
  }
}

$('prep-begin').addEventListener('click', startPrep);

async function startPrep() {
  if (!state.sentences.length) {
    $('prep-status').textContent = 'Wait for the transcript to load first.';
    return;
  }
  const provider = getProvider(state.settings.provider);
  prep.onlyHard = $('prep-only-hard').checked && provider.canExplain;
  if (!provider.canExplain) {
    $('prep-status').textContent = `${provider.name} cannot pick hard words, so every sentence is shown. Choose an AI provider in Settings for highlights.`;
  }
  prep.idx = await loadPrepCache();
  if (prep.idx >= state.sentences.length) prep.idx = 0;
  prep.started = true;
  $('prep-start').hidden = true;
  $('prep-card').hidden = false;
  $('prep-card').focus();
  await gotoSentence(prep.idx, 1);
}

async function gotoSentence(idx, dir) {
  const n = state.sentences.length;
  idx = Math.max(0, Math.min(idx, n - 1));
  // Make sure the target is analysed; then, if only hard sentences are
  // wanted, keep moving in the same direction until one has highlights.
  for (;;) {
    if (!prep.results.has(idx)) {
      renderPrepLoading(idx);
      await ensureAnalyzed(idx);
      if (!prep.results.has(idx)) return; // error shown
    }
    if (!prep.onlyHard || visibleHard(idx).length || idx === 0 && dir < 0) break;
    const next = idx + dir;
    if (next < 0 || next >= n) {
      if (dir > 0) {
        prep.idx = n;
        renderPrepDone();
        return;
      }
      break;
    }
    idx = next;
  }
  prep.idx = idx;
  prep.showTranslation = false;
  prep.wordIdx = 0;
  prep.extra = [];
  savePrepCache();
  renderPrep();
  prefetch();
}

function prepItems() {
  return [...visibleHard(prep.idx), ...prep.extra];
}

function renderPrepLoading(idx) {
  $('prep-pos').textContent = `Sentence ${idx + 1} of ${state.sentences.length}`;
  $('prep-sentence').innerHTML = '<span class="spinner"></span>Finding hard words…';
  $('prep-prev').textContent = '';
  $('prep-word').innerHTML = '';
  $('prep-translation').hidden = true;
}

function renderPrepDone() {
  $('prep-pos').textContent = 'Done';
  $('prep-prev').textContent = '';
  $('prep-sentence').innerHTML = 'You have prepared the whole video. Enjoy watching!';
  $('prep-translation').hidden = true;
  $('prep-word').innerHTML = '<button id="prep-restart" class="link">Start again from the beginning</button>';
  $('prep-restart').addEventListener('click', () => gotoSentence(0, 1));
}

function renderPrep() {
  const s = state.sentences[prep.idx];
  const r = prep.results.get(prep.idx);
  const items = prepItems();
  if (prep.wordIdx >= items.length) prep.wordIdx = 0;
  $('prep-pos').textContent = `Sentence ${prep.idx + 1} of ${state.sentences.length} · ${fmtTime(s.start)}`;
  $('prep-prev').textContent = state.sentences[prep.idx - 1]?.text ?? '';
  $('prep-sentence').innerHTML = sentenceHtml(s.text, items.map((h) => h.text), items.length ? prep.wordIdx : -1);
  $('prep-translation').textContent = r?.translation ?? '';
  $('prep-translation').hidden = !prep.showTranslation;
  const cur = items[prep.wordIdx];
  $('prep-word').innerHTML = cur
    ? `<div class="term">${escapeHtml(cur.text)}${cur.lemma && cur.lemma.toLowerCase() !== cur.text.toLowerCase() ? `<small>${escapeHtml(cur.lemma)}</small>` : ''}<small>${prep.wordIdx + 1}/${items.length}</small></div>
       <div class="translation">${escapeHtml(cur.translation)}</div>
       ${cur.note ? `<div class="note">${escapeHtml(cur.note)}</div>` : ''}`
    : '<div class="status">No hard words here. Click any word to look it up, or press Enter.</div>';
}

$('prep-sentence').addEventListener('click', async (e) => {
  const group = e.target.closest('[data-h]');
  if (group) {
    prep.wordIdx = Number(group.dataset.h);
    renderPrep();
    return;
  }
  const w = e.target.closest('.w');
  if (!w) return;
  const s = state.sentences[prep.idx];
  $('prep-word').innerHTML = `<div class="term">${escapeHtml(w.textContent)}</div><div class="status"><span class="spinner"></span>Translating in context…</div>`;
  try {
    const r = await explainTerm(state.settings, { term: w.textContent, sentence: s.text, previous: state.sentences[prep.idx - 1]?.text });
    const text = s.text.toLowerCase().includes(r.term.toLowerCase()) ? r.term : w.textContent;
    prep.extra.push({ text, lemma: r.lemma, translation: r.translation, note: r.note });
    prep.wordIdx = prepItems().length - 1;
    renderPrep();
  } catch (err) {
    $('prep-word').innerHTML = `<div class="status"><span class="err">${escapeHtml(err.message)}</span></div>`;
  }
});

document.querySelectorAll('.prep-actions [data-key]').forEach((b) =>
  b.addEventListener('click', () => {
    prepKey(b.dataset.key === 'Space' ? ' ' : b.dataset.key);
    $('prep-card').focus();
  })
);
$('prep-play').addEventListener('click', () => prepKey('p'));

$('prep-card').addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (prepKey(e.key, e.shiftKey)) e.preventDefault();
});

function prepKey(key, shift = false) {
  if (!prep.started || prep.idx >= state.sentences.length) {
    if (key === 'Enter' && prep.idx >= state.sentences.length) gotoSentence(0, 1);
    return false;
  }
  const items = prepItems();
  const cur = items[prep.wordIdx];
  const s = state.sentences[prep.idx];
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case ' ':
      prep.showTranslation = !prep.showTranslation;
      renderPrep();
      return true;
    case 'Tab':
      if (items.length) {
        prep.wordIdx = (prep.wordIdx + (shift ? items.length - 1 : 1)) % items.length;
        renderPrep();
      }
      return true;
    case 'a':
      if (cur) {
        const r = prep.results.get(prep.idx);
        addCard({
          term: cur.text,
          lemma: cur.lemma,
          translation: cur.translation,
          note: cur.note,
          sentence: s.text,
          sentenceTranslation: r?.translation ?? '',
          ms: s.start
        }).then((ok) => ok && advanceWord(cur, false));
      }
      return true;
    case 's':
      if (cur) {
        addWords('knownWords', [cur.lemma || cur.text]).then(async () => {
          state.words = await getWordSets();
          advanceWord(cur, true);
        });
      }
      return true;
    case 'Enter':
      gotoSentence(prep.idx + (shift ? -1 : 1), shift ? -1 : 1);
      return true;
    case 'Backspace':
      gotoSentence(prep.idx - 1, -1);
      return true;
    case 'p':
      toTab({ type: 'tt:seek', ms: s.start });
      toTab({ type: 'tt:play' });
      setTimeout(() => toTab({ type: 'tt:pause' }), Math.max(1200, s.end - s.start + 400));
      return true;
    case 'Escape':
      return true;
    default:
      return false;
  }
}

// After A or S: remove the word from this sentence's list and move on.
function advanceWord(item, known) {
  prep.extra = prep.extra.filter((x) => x !== item);
  if (!known) {
    const r = prep.results.get(prep.idx);
    if (r) r.hard = r.hard.filter((h) => h !== item);
  }
  const left = prepItems();
  if (!left.length && prep.onlyHard) {
    gotoSentence(prep.idx + 1, 1);
    return;
  }
  if (prep.wordIdx >= left.length) prep.wordIdx = 0;
  renderPrep();
}

// ---------- cards tab ----------

async function refreshQueueCount() {
  const { ankiQueue = [] } = await chrome.storage.local.get('ankiQueue');
  $('queue-count').hidden = !ankiQueue.length;
  $('queue-count').textContent = ankiQueue.length;
}

async function renderCards() {
  const { ankiQueue = [], ankiSent = [] } = await chrome.storage.local.get(['ankiQueue', 'ankiSent']);
  const item = (c, err) =>
    `<li><b>${c.fields.Word}</b> <span class="muted">— ${c.fields.Translation}</span>${err && c.lastError ? `<span class="err">${escapeHtml(c.lastError)}</span>` : ''}</li>`;
  $('cards-queue').innerHTML = ankiQueue.map((c) => item(c, true)).join('') || '<li class="muted">Nothing waiting.</li>';
  $('cards-sent').innerHTML = ankiSent.slice(-100).reverse().map((c) => item(c)).join('') || '<li class="muted">No cards yet.</li>';
  $('anki-state').textContent = ankiQueue.length
    ? `${ankiQueue.length} card(s) wait for Anki. Open Anki and they are sent within a minute.`
    : `Cards go to the “${state.settings.anki.deck}” deck in Anki.`;
  refreshQueueCount();
}

$('cards-retry').addEventListener('click', async () => {
  try {
    const r = await bg('bg:flush');
    toast(r.offline ? 'Anki is not running. Open Anki and try again.' : r.error ? r.error : `Sent ${r.sent} card(s).`, 3500);
  } catch (e) {
    toast(e.message);
  }
  renderCards();
});

async function exportCards(all) {
  const { ankiQueue = [], ankiSent = [] } = await chrome.storage.local.get(['ankiQueue', 'ankiSent']);
  const cards = all ? [...ankiSent, ...ankiQueue] : ankiQueue;
  if (!cards.length) {
    toast('No cards to export.');
    return;
  }
  const url = `data:text/tab-separated-values;charset=utf-8,${encodeURIComponent(cardsToTsv(cards, state.settings.anki.deck))}`;
  await chrome.downloads.download({ url, filename: `translate-tube-${all ? 'all' : 'waiting'}-${new Date().toISOString().slice(0, 10)}.txt`, saveAs: true });
}
$('cards-export').addEventListener('click', () => exportCards(false));
$('cards-export-all').addEventListener('click', () => exportCards(true));

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.settings) {
    const before = state.settings;
    state.settings = await getSettings();
    if (before && before.learningLang !== state.settings.learningLang && state.videoId) loadTranscript();
  }
  if (changes.knownWords || changes.deckWords) state.words = await getWordSets();
  if (changes.ankiQueue) {
    refreshQueueCount();
    if (state.tab === 'cards') renderCards();
  }
});

// ---------- start ----------

(async function init() {
  state.settings = await getSettings();
  state.words = await getWordSets();
  if (!state.settings.setupDone) {
    setTranscriptStatus('Finish the quick setup first: <button id="go-setup" class="link">open setup</button>');
    $('go-setup').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') }));
  }
  await findTab();
  refreshQueueCount();
  setInterval(poll, 250);
  poll();
})();
