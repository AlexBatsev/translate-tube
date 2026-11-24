// Transcript tab: scrolling subtitles, translation lines, lookups.
import { $, state, on, emit, toast, fmtTime, toTab, playSentence, escapeHtml, sentenceHtml, highlightPhrases, itemHtml } from './core.js';
import { explainTerm } from '../lib/ai.js';
import { saveSettings, markKnown, undoKnown } from '../lib/storage.js';
import { visibleItems } from '../lib/analysis.js';
import { sentenceAt } from '../lib/transcript.js';
import { addDraft, fillNote } from '../lib/drafts.js';

let activeIdx = -1;
let follow = true;
let lastUserScroll = 0;
// After the user scrolls the transcript, it follows the video again once
// they leave it alone for this long.
const FOLLOW_AGAIN_MS = 5000;
let popoverItem = null; // { item, sentence } shown in the popover
let pausedByUs = false; // we paused the video for a lookup; resume on close

// The same status shows on the Transcript and Prepare tabs. Buttons inside
// use data-action (handled in sidepanel.js), so the copy works in both places.
export function setTranscriptStatus(html) {
  $('transcript-status').innerHTML = html;
  $('prep-transcript-status').innerHTML = html;
}

function sentenceItems(id) {
  const r = state.analysis?.results.get(id);
  const all = r?.items ?? [];
  const visible = visibleItems(all, state.settings.level, state.words.known, state.words.deck);
  // Visible items first so they win when phrases overlap.
  return { items: [...visible, ...all.filter((x) => !visible.includes(x))], strong: visible.length, translation: r?.translation ?? '' };
}

function lineHtml(s) {
  const { items, strong, translation } = sentenceItems(s.id);
  const tr = state.settings.showSentenceTranslation !== 'off' && translation ? `<span class="tr">${escapeHtml(translation)}</span>` : '';
  return `<span class="ts" data-ms="${s.start}">${fmtTime(s.start)}</span><span class="tx">${sentenceHtml(s.text, items, { strong, style: 'hl' })}${tr}</span>`;
}

export function renderTranscript() {
  $('transcript').innerHTML = state.sentences.map((s) => `<div class="line" data-id="${s.id}">${lineHtml(s)}</div>`).join('');
  activeIdx = -1;
  setLoop(null);
  applyTranslationMode();
  updateActive(true);
}

function applyTranslationMode() {
  $('transcript').classList.toggle('tr-current', state.settings.showSentenceTranslation === 'current');
  $('show-tr').value = state.settings.showSentenceTranslation;
}

// Re-renders lines in place (after analysis progress, level or known-word
// changes). ids: only these lines; nothing = all. While the user is dragging
// a selection the repaint waits, so the selection is not lost.
let selecting = false;
let pendingIds = null; // Set of ids, or 'all'

export function refreshLines(ids) {
  if (selecting) {
    if (!ids || pendingIds === 'all') pendingIds = 'all';
    else pendingIds = new Set([...(pendingIds ?? []), ...ids]);
    return;
  }
  const lines = $('transcript').children;
  const list = ids ? [...ids] : [...lines].map((el) => Number(el.dataset.id));
  for (const id of list) {
    const el = lines[id];
    const s = state.sentences[id];
    if (el && s) el.innerHTML = lineHtml(s);
  }
}

$('transcript').addEventListener('mousedown', () => (selecting = true));
document.addEventListener('mouseup', () => {
  if (!selecting) return;
  selecting = false;
  if (!pendingIds) return;
  const ids = pendingIds === 'all' ? undefined : pendingIds;
  pendingIds = null;
  // Let the selection handler read the selection first.
  setTimeout(() => {
    if (!String(window.getSelection() || '').trim()) refreshLines(ids);
    else pendingIds = ids ?? 'all';
  }, 0);
});

export function updateActive(force = false) {
  if (!state.sentences.length) return;
  if (!follow && Date.now() - lastUserScroll > FOLLOW_AGAIN_MS && $('popover').hidden && !selecting) {
    follow = true;
    $('follow-now').hidden = true;
    force = true;
  }
  const idx = sentenceAt(state.sentences, state.ms + 150);
  if (idx === activeIdx && !force) return;
  activeIdx = idx;
  const lines = $('transcript').children;
  for (let i = 0; i < lines.length; i++) {
    const d = i - idx;
    lines[i].className = `line${d === 0 ? ' active' : d < 0 ? ' past' : ''}${Math.abs(d) <= 2 && d !== 0 ? ' near' : ''}`;
  }
  if (follow && idx >= 0 && state.tab === 'transcript') keepInView(lines[idx], force);
}

// Keeps the current line near the middle; never closer than two lines to the
// bottom (where the popup or the "back to now" button may cover it).
function keepInView(line, force) {
  if (!line) return;
  line.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
  const box = $('transcript').getBoundingClientRect();
  const r = line.getBoundingClientRect();
  const bottom = Math.min(box.bottom, window.innerHeight) - 2 * (r.height || 24);
  if (r.bottom > bottom) line.scrollIntoView({ block: 'center', behavior: 'auto' });
}

// Short text about the analysis: progress, a pause, or what went wrong.
export function analysisText(a = state.analysis) {
  if (!a) return '';
  if (a.error?.kind === 'key') {
    return `<span class="err">${escapeHtml(a.error.message)}</span> <button class="link" data-action="open-settings">Settings</button> <button class="link" data-action="retry-analysis">Retry</button>`;
  }
  if (a.error) {
    const secs = Math.max(0, Math.ceil((a.error.until - Date.now()) / 1000));
    const why = a.error.kind === 'limit' ? 'AI limit reached' : 'AI is busy';
    return `<span class="err" title="${escapeHtml(a.error.message)}">${why}: continues in ${secs}s</span> <button class="link" data-action="retry-analysis">Now</button>`;
  }
  if (a.failed.size) {
    const msg = [...a.failed.values()][0];
    return `<span class="err" title="${escapeHtml(msg)}">${a.failed.size} lines not analysed: ${escapeHtml(msg)}</span> <button class="link" data-action="retry-analysis">Retry</button>`;
  }
  if (a.running) return '<span class="spinner"></span>Analysing…';
  return '';
}

export function renderAnalysisState() {
  const a = state.analysis;
  const el = $('analysis-state');
  el.innerHTML = analysisText(a);
  el.title = a && !el.innerHTML && a.model ? `Analysed by ${a.model}` : '';
  // A paused analysis counts down every second.
  clearTimeout(renderAnalysisState.timer);
  if (a?.error?.until) renderAnalysisState.timer = setTimeout(renderAnalysisState, 1000);
}

// ---- scrolling ----

['wheel', 'touchmove'].forEach((ev) =>
  $('transcript').addEventListener(
    ev,
    () => {
      follow = false;
      lastUserScroll = Date.now();
      $('follow-now').hidden = false;
    },
    { passive: true }
  )
);
$('follow-now').addEventListener('click', () => {
  follow = true;
  $('follow-now').hidden = true;
  updateActive(true);
});

// ---- moving by line, replay and repeat ----

function currentLine() {
  return Math.max(0, sentenceAt(state.sentences, state.ms + 150));
}

function goLine(delta) {
  if (!state.sentences.length) return;
  const idx = Math.max(0, Math.min(state.sentences.length - 1, currentLine() + delta));
  if (loopId != null) loopId = idx;
  follow = true;
  $('follow-now').hidden = true;
  toTab({ type: 'tt:seek', ms: state.sentences[idx].start });
}

// Repeat: the line being spoken plays again and again until turned off.
let loopId = null;

function setLoop(id) {
  loopId = id;
  $('loop-btn').setAttribute('aria-pressed', String(id != null));
}

function toggleLoop() {
  if (loopId != null) return setLoop(null);
  if (!state.sentences.length) return;
  setLoop(currentLine());
  toast('Repeating this line. Press L to stop.');
}

// Called with every position update from the video.
export function tickLoop() {
  if (loopId == null || state.paused) return;
  const s = state.sentences[loopId];
  if (!s) return setLoop(null);
  const end = Math.max(s.end, s.start + 800);
  if (state.ms > end + 150 && state.ms < end + 2500) toTab({ type: 'tt:seek', ms: s.start });
  else if (state.ms < s.start - 1500 || state.ms >= end + 2500) setLoop(null); // the viewer went elsewhere
}

$('loop-btn').addEventListener('click', toggleLoop);

// ---- translation lines and legend ----

$('show-tr').addEventListener('change', async () => {
  await saveSettings({ showSentenceTranslation: $('show-tr').value });
});
$('legend-btn').addEventListener('click', () => {
  $('legend').hidden = !$('legend').hidden;
  $('legend-btn').setAttribute('aria-expanded', String(!$('legend').hidden));
});

// ---- clicks and selections ----

$('transcript').addEventListener('click', (e) => {
  const ts = e.target.closest('.ts');
  if (ts) {
    toTab({ type: 'tt:seek', ms: Number(ts.dataset.ms) });
    return;
  }
  const sel = window.getSelection();
  if (sel && String(sel).trim().includes(' ')) return; // a phrase: handled on mouseup
  const line = e.target.closest('.line');
  if (!line) return;
  const id = Number(line.dataset.id);
  const group = e.target.closest('[data-h]');
  if (group) {
    const { items } = sentenceItems(id);
    showItem(items[Number(group.dataset.h)], id);
    return;
  }
  const w = e.target.closest('.w');
  if (w) lookup(w.textContent, [id]);
});

$('transcript').addEventListener('mouseup', () => {
  const sel = window.getSelection();
  const text = String(sel || '').replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!text.includes(' ')) return;
  const lineOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.line');
  const a = lineOf(sel.anchorNode);
  const b = lineOf(sel.focusNode);
  if (!a || !b) return;
  const ids = [Number(a.dataset.id), Number(b.dataset.id)].sort((x, y) => x - y);
  const range = [];
  for (let i = ids[0]; i <= ids[1]; i++) range.push(i);
  // If the selection is exactly an analysed item, answer instantly.
  if (range.length === 1) {
    const hit = sentenceItems(ids[0]).items.find((it) => it.text.toLowerCase() === text.toLowerCase());
    if (hit) return showItem(hit, ids[0]);
  }
  lookup(text, range);
});

// ---- popover ----

function showPopover(html) {
  $('popover-body').innerHTML = html;
  $('popover').hidden = false;
}

// resume: false when the popover closes because the video changed.
export function hidePopover({ resume = true } = {}) {
  const wasOpen = !$('popover').hidden;
  $('popover').hidden = true;
  popoverItem = null;
  window.getSelection()?.removeAllRanges();
  if (wasOpen && resume && pausedByUs && state.settings?.resumeOnClose) toTab({ type: 'tt:play' });
  pausedByUs = false;
}
$('popover-close').addEventListener('click', () => hidePopover());

function pauseIfNeeded() {
  if (state.settings.pauseOnClick && !state.paused) {
    toTab({ type: 'tt:pause' });
    pausedByUs = true;
  }
}

function showItem(item, id) {
  pauseIfNeeded();
  const s = state.sentences[id];
  const translation = state.analysis?.results.get(id)?.translation ?? '';
  renderPopover({ item, sentence: s.text, sentenceTranslation: translation, ms: s.start, sentenceId: id });
}

// ids: one sentence, or several when a selection crosses lines.
async function lookup(term, ids) {
  const sents = ids.map((i) => state.sentences[i]).filter(Boolean);
  if (!sents.length || !term) return;
  pauseIfNeeded();
  const sentence = sents.map((s) => s.text).join(' ');
  showPopover(`<div class="term">${escapeHtml(term)}</div><div class="status"><span class="spinner"></span>Translating in context…</div>`);
  const token = (lookup.token = {});
  try {
    const r = await explainTerm(state.settings, { term, sentence, previous: state.sentences[ids[0] - 1]?.text });
    if (token !== lookup.token) return;
    renderPopover({ item: r.item, sentence, sentenceTranslation: r.sentenceTranslation, ms: sents[0].start, sentenceId: ids[0] });
  } catch (e) {
    if (token !== lookup.token) return;
    const settingsLink = e.kind === 'key' ? ' <button class="link" data-action="open-settings">Settings</button>' : '';
    showPopover(`<div class="term">${escapeHtml(term)}</div>
      <div class="status"><span class="err">${escapeHtml(e.message)}</span></div>
      <div class="row"><button id="pop-retry">Try again</button>${settingsLink}</div>`);
    $('pop-retry').addEventListener('click', () => lookup(term, ids));
  }
}

function renderPopover(p) {
  popoverItem = p;
  showPopover(`
    ${itemHtml(p.item)}
    ${p.sentenceTranslation ? `<div class="sent-tr">${highlightPhrases(p.sentenceTranslation, [p.item.inTranslation], 0)}</div>` : ''}
    <div class="row">
      <button class="primary" id="pop-add">Add to cards <kbd>A</kbd></button>
      <button id="pop-replay">▶ Replay line</button>
      <button id="pop-known" class="link">I know it <kbd>S</kbd></button>
    </div>`);
  $('pop-add').addEventListener('click', () => addFromPopover());
  $('pop-replay').addEventListener('click', () => {
    pausedByUs = false; // the user chose to play
    playSentence({ start: p.ms });
  });
  $('pop-known').addEventListener('click', knowFromPopover);
  // Analysed items get their memory note the first time they are opened.
  if (!p.item.note && state.analysis) {
    state.analysis.note(p.item, p.sentence).then((note) => {
      if (note && popoverItem === p) renderPopover(p);
    });
  }
}

async function knowFromPopover() {
  const p = popoverItem;
  if (!p) return;
  await knowWords([p.item.lemma, p.item.text], p.item.lemma || p.item.text);
  hidePopover();
}

// "I know it" from anywhere: marks words known, with Undo in the toast.
export async function knowWords(words, label) {
  const added = await markKnown(words);
  if (!added.length) return toast('Already marked as known');
  toast(`“${label}” marked as known`, 4000, {
    label: 'Undo',
    run: async () => {
      const back = await undoKnown();
      if (back.length) toast(`“${back.join(', ')}” is a new word again`);
    }
  });
}

// Memory notes still being written for cards that were just added.
export const pendingNotes = new Set();

export async function addItemAsDraft(item, { sentence, sentenceTranslation, ms }) {
  const r = await addDraft(item, { sentence, sentenceTranslation, ms, videoId: state.videoId, videoTitle: state.title });
  toast(r.added ? `Added “${item.lemma || item.text}” to cards (${r.count} to review)` : 'Already in your cards');
  emit('drafts');
  if (r.added && !item.note && state.analysis) {
    const job = state.analysis
      .note(item, sentence)
      .then((note) => fillNote(r.id, note))
      .finally(() => pendingNotes.delete(job));
    pendingNotes.add(job);
  }
  return r;
}

async function addFromPopover() {
  if (!popoverItem) return;
  await addItemAsDraft(popoverItem.item, popoverItem);
  hidePopover();
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
  if (state.tab !== 'transcript') return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!$('popover').hidden) {
    if (k === 'Escape') hidePopover();
    else if (k === 'a' && popoverItem) addFromPopover();
    else if (k === 's' && popoverItem) knowFromPopover();
    else return;
  } else if (k === 'ArrowLeft') goLine(-1);
  else if (k === 'ArrowRight') goLine(+1);
  else if (k === 'r') {
    if (state.sentences.length) playSentence(state.sentences[currentLine()]);
  } else if (k === 'l') toggleLoop();
  else return;
  e.preventDefault();
});

on('settings', applyTranslationMode);
