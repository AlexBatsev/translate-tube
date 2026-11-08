// Prepare tab: go through the hard sentences before watching.
import { $, state, on, emit, fmtTime, toTab, escapeHtml, sentenceHtml, highlightPhrases, itemHtml } from './core.js';
import { explainTerm } from '../lib/ai.js';
import { saveSettings, LEVELS } from '../lib/storage.js';
import { visibleItems } from '../lib/analysis.js';
import { sentenceAt } from '../lib/transcript.js';
import { getDrafts } from '../lib/drafts.js';
import { addItemAsDraft, knowWords, analysisText } from './transcript-view.js';

const prep = {
  started: false,
  idx: 0,
  wordIdx: 0,
  showTranslation: false,
  onlyHard: true,
  extra: [], // items looked up by clicking other words in this sentence
  added: new Set(), // "id|text" of items added to cards
  history: [], // sentences shown before, for Back
  shown: 0, // sentences shown since Start (0 at the end = nothing was hard)
  loading: -1, // sentence id we are waiting for
  runStart: 0, // sentence this run started from
  nav: 0 // increases with every move, so an older, slower move gives way
};

export function resetPrep() {
  Object.assign(prep, { started: false, idx: 0, wordIdx: 0, extra: [], added: new Set(), history: [], shown: 0, loading: -1, runStart: 0 });
  prep.nav++;
  $('prep-start').hidden = false;
  $('prep-card').hidden = true;
  setStatus('');
  updateStartScreen();
}

// Where Prepare starts: the line the video is at now, so a half-watched
// video is prepared from there to the end.
function videoStart() {
  if (!state.sentences.length || state.ms < 5000) return 0;
  return Math.max(0, sentenceAt(state.sentences, state.ms));
}

export function updateStartScreen() {
  const from = videoStart();
  $('prep-begin').textContent = from > 0 ? `Start from ${fmtTime(state.sentences[from].start)} (where the video is)` : 'Start';
  $('prep-over').hidden = from === 0;
}

export function prepActive() {
  return prep.started;
}

function setStatus(html) {
  $('prep-status').innerHTML = html;
}

function items(id = prep.idx) {
  const r = state.analysis?.results.get(id);
  return [...visibleItems(r?.items, state.settings.level, state.words.known), ...(id === prep.idx ? prep.extra : [])];
}

function addedSet(id = prep.idx) {
  return new Set([...prep.added].filter((k) => k.startsWith(`${id}|`)).map((k) => k.slice(String(id).length + 1)));
}

$('prep-begin').addEventListener('click', () => startPrep(false));
$('prep-over').addEventListener('click', () => startPrep(true));

async function startPrep(fromStart) {
  if (!state.sentences.length || !state.analysis) {
    setStatus(state.videoId ? 'The transcript is not ready yet (see above).' : 'Open a YouTube video first.');
    return;
  }
  prep.onlyHard = $('prep-only-hard').checked;
  prep.shown = 0;
  prep.history = [];
  setStatus('');
  prep.idx = fromStart ? 0 : videoStart();
  prep.runStart = prep.idx;
  prep.started = true;
  $('prep-start').hidden = true;
  $('prep-card').hidden = false;
  $('prep-card').focus();
  await gotoSentence(prep.idx, 1, { record: false });
}

// Moves to sentence idx (or the next one with hard words in direction dir).
async function gotoSentence(idx, dir, { record = true } = {}) {
  const nav = ++prep.nav;
  const n = state.sentences.length;
  const from = prep.idx;
  idx = Math.max(0, Math.min(idx, n - 1));
  for (;;) {
    if (!state.analysis.results.has(idx)) {
      prep.loading = idx;
      renderLoading(idx);
      await state.analysis.ensure(idx);
      if (nav !== prep.nav) return; // the user moved on meanwhile
      prep.loading = -1;
      if (!prep.started) return;
      if (!state.analysis.results.has(idx)) return renderFailed(idx, dir);
    }
    if (!prep.onlyHard || items(idx).length || (idx === 0 && dir < 0)) break;
    const next = idx + dir;
    if (next < 0 || next >= n) {
      if (dir > 0) return renderDone();
      break;
    }
    idx = next;
  }
  if (record && idx !== from && prep.idx < n) prep.history.push(from);
  prep.idx = idx;
  prep.wordIdx = 0;
  prep.showTranslation = false;
  prep.extra = [];
  prep.shown++;
  setStatus('');
  render();
}

function renderLoading(idx) {
  $('prep-pos').textContent = `Sentence ${idx + 1} of ${state.sentences.length}`;
  $('prep-sentence').innerHTML = analysisText() || '<span class="spinner"></span>Analysing…';
  $('prep-prev').textContent = '';
  $('prep-word').innerHTML = '';
  $('prep-translation').hidden = true;
}

function renderFailed(idx, dir) {
  const a = state.analysis;
  const err = a.error?.message ?? a.failed.get(idx) ?? 'Analysis failed.';
  const settings = a.error?.kind === 'key' ? ' <button class="link" data-action="open-settings">Settings</button>' : '';
  $('prep-sentence').innerHTML = escapeHtml(state.sentences[idx].text);
  $('prep-word').innerHTML = `<div class="status"><span class="err">${escapeHtml(err)}</span>${settings} <button id="prep-retry" class="link">Retry</button></div>`;
  $('prep-retry').addEventListener('click', () => {
    a.retry();
    gotoSentence(idx, dir);
  });
}

async function renderDone() {
  prep.idx = state.sentences.length;
  const nav = prep.nav;
  const drafts = (await getDrafts()).filter((d) => d.videoId === state.videoId);
  if (nav !== prep.nav) return;
  $('prep-pos').textContent = 'Done';
  renderLevel();
  $('prep-prev').textContent = '';
  const nothing = prep.onlyHard && prep.shown === 0;
  $('prep-sentence').innerHTML = nothing
    ? `No hard words ${prep.runStart > 0 ? 'in the rest of this video' : 'in this video'} at your level (${escapeHtml(levelLabel())}). Press <b>−</b> to lower the level and see more words.`
    : 'You have prepared the whole video. Enjoy watching!';
  $('prep-translation').hidden = true;
  $('prep-word').innerHTML =
    (nothing && Number(state.settings.level) > 1 ? '<button id="prep-more" class="primary">Lower the level (−)</button> ' : '') +
    `${drafts.length ? `<button id="prep-review" class="primary">Review ${drafts.length} card${drafts.length > 1 ? 's' : ''} now</button> ` : ''}<button id="prep-restart" class="link">Start again from the beginning</button>`;
  $('prep-more')?.addEventListener('click', () => changeLevel(-1)); // 'level' event searches again
  $('prep-review')?.addEventListener('click', () => emit('show-tab', 'cards'));
  $('prep-restart').addEventListener('click', () => {
    prep.history = [];
    prep.shown = 0;
    prep.runStart = 0;
    gotoSentence(0, 1, { record: false });
  });
}

function levelLabel() {
  return LEVELS.find((l) => l.value === Number(state.settings.level))?.label ?? '';
}

// Always shows the saved level, whatever screen Prepare is on.
function renderLevel() {
  const level = Number(state.settings.level);
  $('lvl-label').textContent = `Level ${level} · ${levelLabel()}`;
  $('lvl-down').disabled = level <= 1;
  $('lvl-up').disabled = level >= 6;
}

export function render() {
  renderLevel();
  if (!prep.started || prep.idx >= state.sentences.length) return;
  const s = state.sentences[prep.idx];
  const r = state.analysis?.results.get(prep.idx);
  const list = items();
  if (prep.wordIdx >= list.length) prep.wordIdx = Math.max(0, list.length - 1);
  const added = addedSet();
  $('prep-pos').textContent = `Sentence ${prep.idx + 1} of ${state.sentences.length} · ${fmtTime(s.start)}`;
  $('prep-prev').textContent = state.sentences[prep.idx - 1]?.text ?? '';
  $('prep-sentence').innerHTML = sentenceHtml(s.text, list, { current: list.length ? prep.wordIdx : -1, added });
  $('prep-translation').innerHTML = highlightPhrases(r?.translation ?? '', list.map((h) => h.inTranslation), list.length ? prep.wordIdx : -1);
  $('prep-translation').hidden = !prep.showTranslation;
  const cur = list[prep.wordIdx];
  $('prep-word').innerHTML = cur
    ? itemHtml(cur, { counter: `${prep.wordIdx + 1}/${list.length}${added.has(cur.text) ? ' · added ✓' : ''}` })
    : '<div class="status">No hard words here. Click any word to look it up, or press Enter.</div>';
}

// ---- level control ----

// − lowers the level (more words highlighted), + raises it (fewer words).
// Quick presses add up: each one starts from the level the last press asked for.
let wantedLevel = null;
async function changeLevel(delta) {
  const from = wantedLevel ?? Number(state.settings.level);
  const level = Math.max(1, Math.min(6, from + delta));
  if (level === from) return;
  wantedLevel = level;
  $('lvl-label').textContent = `Level ${level} · ${LEVELS.find((l) => l.value === level).label}`;
  await saveSettings({ level }); // storage listener re-renders everything
}
$('lvl-down').addEventListener('click', () => changeLevel(-1));
$('lvl-up').addEventListener('click', () => changeLevel(+1));

on('settings', () => {
  if (Number(state.settings.level) === wantedLevel) wantedLevel = null;
  renderLevel();
});

on('level', () => {
  renderLevel();
  if (!prep.started) return;
  if (prep.idx >= state.sentences.length) {
    // On the "done" screen: search this run again at the new level.
    prep.history = [];
    prep.shown = 0;
    gotoSentence(prep.runStart, 1, { record: false });
    return;
  }
  // Re-check the current sentence at the new level; skip it if nothing is hard now.
  if (prep.onlyHard && !items().length) gotoSentence(prep.idx, 1, { record: false });
  else render();
});
on('words', () => {
  if (!prep.started || prep.idx >= state.sentences.length) return;
  // After S: if nothing hard is left here, move on.
  if (prep.onlyHard && !items().length) gotoSentence(prep.idx + 1, 1);
  else render();
});

// ---- clicks ----

$('prep-sentence').addEventListener('click', async (e) => {
  const group = e.target.closest('[data-h]');
  if (group) {
    prep.wordIdx = Number(group.dataset.h);
    render();
    return;
  }
  const w = e.target.closest('.w');
  if (!w || prep.idx >= state.sentences.length) return;
  const s = state.sentences[prep.idx];
  const all = state.analysis?.results.get(prep.idx)?.items ?? [];
  // Already analysed (just below the current level)? Show it without asking the AI.
  const known = all.find((it) => it.text.toLowerCase().split(/\s+/).includes(w.textContent.toLowerCase()));
  if (known) {
    prep.extra.push(known);
    prep.wordIdx = items().length - 1;
    render();
    return;
  }
  $('prep-word').innerHTML = `<div class="term">${escapeHtml(w.textContent)}</div><div class="status"><span class="spinner"></span>Translating in context…</div>`;
  try {
    const r = await explainTerm(state.settings, { term: w.textContent, sentence: s.text, previous: state.sentences[prep.idx - 1]?.text });
    const item = { ...r.item, text: s.text.toLowerCase().includes(r.item.text.toLowerCase()) ? r.item.text : w.textContent };
    prep.extra.push(item);
    prep.wordIdx = items().length - 1;
    render();
  } catch (err) {
    $('prep-word').innerHTML = `<div class="status"><span class="err">${escapeHtml(err.message)}</span></div>`;
  }
});

document.querySelectorAll('.prep-actions [data-key]').forEach((b) =>
  b.addEventListener('click', () => {
    key(b.dataset.key === 'Space' ? ' ' : b.dataset.key);
    $('prep-card').focus();
  })
);
$('prep-play').addEventListener('click', () => key('p'));

$('prep-card').addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (key(e.key, e.shiftKey)) e.preventDefault();
});

// Enter: next highlighted word, then the next sentence.
function next() {
  const list = items();
  if (prep.wordIdx < list.length - 1) {
    prep.wordIdx++;
    render();
  } else {
    gotoSentence(prep.idx + 1, 1);
  }
}

function back() {
  const prev = prep.history.pop();
  if (prev !== undefined) gotoSentence(prev, -1, { record: false });
  else if (prep.idx > 0) gotoSentence(prep.idx - 1, -1, { record: false });
}

function key(k, shift = false) {
  if (!prep.started) return false;
  if (prep.idx >= state.sentences.length) {
    if (k === 'Backspace') back();
    else if (k === '-') changeLevel(-1);
    else if (k === '+' || k === '=') changeLevel(+1);
    else return false;
    return true;
  }
  const list = items();
  const cur = list[prep.wordIdx];
  const s = state.sentences[prep.idx];
  switch (k.length === 1 ? k.toLowerCase() : k) {
    case ' ':
      prep.showTranslation = !prep.showTranslation;
      render();
      return true;
    case 'Tab':
      if (list.length) {
        prep.wordIdx = (prep.wordIdx + (shift ? list.length - 1 : 1)) % list.length;
        render();
      }
      return true;
    case 'a':
      if (cur) {
        const r = state.analysis.results.get(prep.idx);
        addItemAsDraft(cur, { sentence: s.text, sentenceTranslation: r?.translation ?? '', ms: s.start }).then(() => {
          prep.added.add(`${prep.idx}|${cur.text}`);
          next();
        });
      }
      return true;
    case 's':
      if (cur) knowWords([cur.lemma, cur.text], cur.lemma || cur.text); // 'words' event re-renders
      return true;
    case 'Enter':
      next();
      return true;
    case 'Backspace':
      back();
      return true;
    case '-':
      changeLevel(-1);
      return true;
    case '+':
    case '=':
      changeLevel(+1);
      return true;
    case 'p':
      toTab({ type: 'tt:seek', ms: s.start });
      toTab({ type: 'tt:play' });
      setTimeout(() => toTab({ type: 'tt:pause' }), Math.max(1200, s.end - s.start + 400));
      return true;
    default:
      return false;
  }
}

on('analysis', () => {
  if (!prep.started) return;
  if (prep.loading >= 0) renderLoading(prep.loading);
  else if (prep.idx < state.sentences.length) render();
});
on('transcript', updateStartScreen);
on('tab-shown', (name) => {
  if (name !== 'prepare') return;
  if (prep.started) $('prep-card').focus();
  else updateStartScreen();
});
