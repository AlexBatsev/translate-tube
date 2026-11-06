// Transcript tab: scrolling subtitles, translation lines, lookups.
import { $, state, on, emit, toast, fmtTime, toTab, playSentence, escapeHtml, sentenceHtml, highlightPhrases, itemHtml } from './core.js';
import { explainTerm } from '../lib/ai.js';
import { saveSettings, addWords } from '../lib/storage.js';
import { visibleItems } from '../lib/analysis.js';
import { sentenceAt } from '../lib/transcript.js';
import { addDraft } from '../lib/drafts.js';

let activeIdx = -1;
let follow = true;
let popoverItem = null; // { item, sentence } shown in the popover

export function setTranscriptStatus(html) {
  $('transcript-status').innerHTML = html;
}

function sentenceItems(id) {
  const r = state.analysis?.results.get(id);
  const all = r?.items ?? [];
  const visible = visibleItems(all, state.settings.level, state.words.known);
  // Visible items first so they win when phrases overlap.
  return { items: [...visible, ...all.filter((x) => !visible.includes(x))], strong: visible.length, translation: r?.translation ?? '' };
}

function lineHtml(s) {
  const { items, strong, translation } = sentenceItems(s.id);
  const tr = state.settings.showSentenceTranslation && translation ? `<span class="tr">${escapeHtml(translation)}</span>` : '';
  return `<span class="ts" data-ms="${s.start}">${fmtTime(s.start)}</span><span class="tx">${sentenceHtml(s.text, items, { strong, style: 'hl' })}${tr}</span>`;
}

export function renderTranscript() {
  $('transcript').innerHTML = state.sentences.map((s) => `<div class="line" data-id="${s.id}">${lineHtml(s)}</div>`).join('');
  activeIdx = -1;
  updateActive(true);
}

// Re-renders lines in place (after analysis progress, level or known-word changes).
export function refreshLines() {
  for (const el of $('transcript').children) {
    const s = state.sentences[Number(el.dataset.id)];
    if (s) el.innerHTML = lineHtml(s);
  }
}

export function updateActive(force = false) {
  if (!state.sentences.length) return;
  const idx = sentenceAt(state.sentences, state.ms + 150);
  if (idx === activeIdx && !force) return;
  activeIdx = idx;
  const lines = $('transcript').children;
  for (let i = 0; i < lines.length; i++) {
    const d = i - idx;
    lines[i].className = `line${d === 0 ? ' active' : d < 0 ? ' past' : ''}${Math.abs(d) <= 2 && d !== 0 ? ' near' : ''}`;
  }
  if (follow && idx >= 0 && state.tab === 'transcript') {
    lines[idx]?.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
  }
}

export function renderAnalysisState() {
  const a = state.analysis;
  const el = $('analysis-state');
  if (!a) {
    el.textContent = '';
    return;
  }
  if (a.failed.size) {
    el.innerHTML = `<span class="err">${a.failed.size} lines not analysed.</span> <button class="link" id="retry-analysis">Retry</button>`;
    $('retry-analysis').addEventListener('click', () => a.retryFailed());
  } else if (a.done < a.total) {
    el.innerHTML = `<span class="spinner"></span>Analysing ${a.done}/${a.total}`;
  } else {
    el.textContent = '';
  }
}

// ---- scrolling ----

['wheel', 'touchmove'].forEach((ev) =>
  $('transcript').addEventListener(
    ev,
    () => {
      follow = false;
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

// ---- translation lines toggle ----

$('show-tr').addEventListener('change', async () => {
  await saveSettings({ showSentenceTranslation: $('show-tr').checked });
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

export function hidePopover() {
  $('popover').hidden = true;
  popoverItem = null;
  window.getSelection()?.removeAllRanges();
}
$('popover-close').addEventListener('click', hidePopover);

function pauseIfNeeded() {
  if (state.settings.pauseOnClick && !state.paused) toTab({ type: 'tt:pause' });
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
    showPopover(`<div class="term">${escapeHtml(term)}</div><div class="status"><span class="err">${escapeHtml(e.message)}</span></div>`);
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
      <button id="pop-known" class="link">I know this</button>
    </div>`);
  $('pop-add').addEventListener('click', () => addFromPopover());
  $('pop-replay').addEventListener('click', () => playSentence({ start: p.ms }));
  $('pop-known').addEventListener('click', async () => {
    await addWords('knownWords', [p.item.lemma, p.item.text]);
    toast('Marked as known');
    hidePopover();
  });
}

export async function addItemAsDraft(item, { sentence, sentenceTranslation, ms }) {
  const r = await addDraft(item, { sentence, sentenceTranslation, ms, videoId: state.videoId, videoTitle: state.title });
  toast(r.added ? `Added “${item.lemma || item.text}” to cards (${r.count} to review)` : 'Already in your cards');
  emit('drafts');
  return r;
}

async function addFromPopover() {
  if (!popoverItem) return;
  await addItemAsDraft(popoverItem.item, popoverItem);
  hidePopover();
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  if ($('popover').hidden || state.tab !== 'transcript') return;
  if (e.key === 'Escape') hidePopover();
  if ((e.key === 'a' || e.key === 'A') && popoverItem) addFromPopover();
});

on('settings', () => {
  $('show-tr').checked = !!state.settings.showSentenceTranslation;
});
