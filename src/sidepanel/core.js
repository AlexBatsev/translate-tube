// Shared state and small helpers for the side panel modules.
import { escapeHtml } from '../lib/card.js';
import { tokenize, markHighlights, findPhrases } from '../lib/transcript.js';
import { normalizeWord } from '../lib/storage.js';
import { inDeck } from '../lib/analysis.js';

export const $ = (id) => document.getElementById(id);

export const state = {
  settings: null,
  words: { known: new Set(), deck: new Set() },
  tabId: null,
  videoId: null,
  title: '',
  sentences: [],
  analysis: null, // TranscriptAnalysis for the current video
  ms: 0,
  paused: true,
  tab: 'transcript'
};

// Simple event bus between modules: 'analysis', 'words', 'level', 'drafts',
// 'settings', 'tab-shown', 'show-tab', 'transcript'.
export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

// action: optional { label, run } shown as a button (e.g. Undo).
export function toast(text, ms = 2400, action = null) {
  const t = $('toast');
  t.textContent = '';
  const span = document.createElement('span');
  span.textContent = text;
  t.append(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', () => {
      t.hidden = true;
      action.run();
    });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), action ? Math.max(ms, 6000) : ms);
}

export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export async function toTab(msg) {
  if (state.tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(state.tabId, msg);
  } catch {
    return null;
  }
}

export async function bg(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || 'Something went wrong.');
  return r.result;
}

export function playSentence(s) {
  toTab({ type: 'tt:seek', ms: s.start });
  toTab({ type: 'tt:play' });
}

export { escapeHtml };

// ---- rendering ----

// Renders a sentence with item groups. Items before `strong` get the
// highlight `style`; the rest are clickable, and marked when already in the cards.
export function sentenceHtml(text, items, { strong = items.length, style = 'hard', current = -1, added = new Set() } = {}) {
  const tokens = tokenize(text);
  const marks = markHighlights(tokens, items.map((it) => it.text));
  let html = '';
  let open = -1;
  tokens.forEach((t, i) => {
    if (marks[i] !== open) {
      if (open >= 0) html += '</span>';
      open = marks[i];
      if (open >= 0) {
        const cls =
          open < strong
            ? `${style}${open === current ? ' current' : ''}${added.has(items[open].text) ? ' added' : ''}`
            : `item${inDeck(items[open], state.words.deck) ? ' deck' : ''}`;
        html += `<span class="${cls}" data-h="${open}">`;
      }
    }
    if (t.word) {
      const deck = state.words.deck.has(normalizeWord(t.text)) ? ' deck' : '';
      html += `<span class="w${deck}">${escapeHtml(t.text)}</span>`;
    } else {
      html += escapeHtml(t.text);
    }
  });
  if (open >= 0) html += '</span>';
  return html;
}

export function highlightPhrases(text, phrases, current = -1) {
  let html = '';
  let pos = 0;
  for (const r of findPhrases(text, phrases)) {
    html += escapeHtml(text.slice(pos, r.start));
    html += `<span class="hard${r.index === current ? ' current' : ''}">${escapeHtml(text.slice(r.start, r.end))}</span>`;
    pos = r.end;
  }
  return html + escapeHtml(text.slice(pos));
}

export function itemHtml(item, { counter = '' } = {}) {
  const lemma = item.lemma && item.lemma.toLowerCase() !== item.text.toLowerCase() ? `<small>${escapeHtml(item.lemma)}</small>` : '';
  const kind = item.kind && item.kind !== 'word' ? `<span class="kind">${escapeHtml(item.kind)}</span>` : '';
  const parts = item.parts?.length
    ? `<div class="parts">${item.parts.map((p) => `<span><b>${escapeHtml(p.text)}</b> — ${escapeHtml(p.translation)}</span>`).join('')}</div>`
    : '';
  return `<div class="term">${escapeHtml(item.text)}${lemma}${kind}${counter ? `<small>${counter}</small>` : ''}</div>
    <div class="translation">${escapeHtml(item.translation)}</div>
    ${item.note ? `<div class="note">${escapeHtml(item.note)}</div>` : ''}
    ${parts}`;
}
