// Side panel shell: tabs, video tracking, transcript loading and analysis.
import { $, state, on, emit, bg, toTab, toast, escapeHtml, fmtTime } from './core.js';
import { getSettings, getWordSets, undoKnown, getHistory, rememberVideo, videoUrl } from '../lib/storage.js';
import { parseJson3, buildSentences, sentenceAt } from '../lib/transcript.js';
import { TranscriptAnalysis } from '../lib/analysis.js';
import { getDrafts } from '../lib/drafts.js';
import { renderTranscript, refreshLines, updateActive, renderAnalysisState, setTranscriptStatus, hidePopover } from './transcript-view.js';
import { resetPrep, render as renderPrep } from './prepare.js';
import { renderCards, refreshCount } from './cards.js';

// ---------- tabs ----------

function showTab(name) {
  state.tab = name;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('.tab-body')) s.hidden = s.id !== `tab-${name}`;
  if (name === 'cards') renderCards();
  if (name === 'transcript') updateActive(true);
  emit('tab-shown', name);
}

document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
on('show-tab', showTab);
$('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// Buttons inside status texts (they can appear in several places).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const action = b.dataset.action;
  if (action === 'retry-transcript') loadTranscript();
  else if (action === 'open-settings') chrome.runtime.openOptionsPage();
  else if (action === 'open-setup') chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  else if (action === 'retry-analysis') {
    if (state.analysis) {
      state.analysis.settings = state.settings;
      state.analysis.retry();
    }
  } else if (action === 'open-video') openVideo(JSON.parse(b.dataset.video));
  else if (action === 'reload-tab' && state.tabId != null) chrome.tabs.reload(state.tabId);
});

// ---------- video tracking ----------

// ?tabId=N pins the panel to one tab (used when opening the panel page in a
// normal tab for debugging and automated tests).
const pinnedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;
const YOUTUBE = /^https:\/\/(www|m)\.youtube\.com\//;

async function findTab() {
  if (pinnedTabId) {
    state.tabId = pinnedTabId;
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  state.tabId = YOUTUBE.test(tab?.url ?? '') ? tab.id : null;
}

let injected = false;
let missedPolls = 0;

async function poll() {
  const info = await toTab({ type: 'tt:info' });
  if (!info) {
    if (state.tabId != null && !injected) {
      injected = true;
      missedPolls = 0;
      await bg('bg:injectTab', { tabId: state.tabId }).catch(() => {});
    } else if (state.tabId != null && ++missedPolls === 12) {
      // Still no answer 3 s after injecting: an old copy of the page script
      // from before an update is in the way.
      setTranscriptStatus('This YouTube tab was opened before Translate Tube was installed or updated. <button class="link" data-action="reload-tab">Refresh the tab</button> to connect.');
    }
    if (state.tabId == null && !state.videoId) showNoVideo();
    return;
  }
  missedPolls = 0;
  if (info.videoId !== state.videoId) onVideoChange(info);
  state.ms = info.ms;
  state.paused = info.paused;
  state.shorts = info.shorts;
  if (info.title && info.title !== state.title) {
    state.title = info.title;
    $('video-title').textContent = info.title;
  }
  updateActive();
  saveProgress();
}

function onVideoChange(info) {
  state.videoId = info.videoId;
  state.title = info.title;
  state.shorts = info.shorts;
  $('video-title').textContent = info.videoId ? info.title : '';
  state.analysis?.stop();
  state.analysis = null;
  state.sentences = [];
  hidePopover({ resume: false });
  resetPrep();
  renderTranscript();
  renderAnalysisState();
  noVideoShown = false;
  if (info.videoId) {
    loadTranscript();
    showReminder();
    rememberVideo(info);
  } else {
    showNoVideo();
  }
}

// Remembers where the user is in the video, for "Recent videos".
let lastSaved = 0;
function saveProgress() {
  if (!state.videoId || Date.now() - lastSaved < 5000) return;
  lastSaved = Date.now();
  rememberVideo({ videoId: state.videoId, title: state.title, ms: state.ms, shorts: state.shorts });
}

chrome.tabs.onActivated.addListener(async () => {
  injected = false;
  await findTab();
});
chrome.tabs.onUpdated.addListener(async (_id, change) => {
  if (change.url || change.status === 'complete') {
    injected = false;
    await findTab();
  }
});

// ---------- recent videos ----------

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return m <= 1 ? 'just now' : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function historyHtml(list) {
  return list
    .map(
      (h) => `<li><a data-action="open-video" data-video='${escapeHtml(JSON.stringify({ videoId: h.videoId, shorts: h.shorts, ms: h.ms }))}'>${escapeHtml(h.title || h.videoId)}</a>
      <span class="muted">${h.shorts ? 'Short' : `stopped at ${fmtTime(h.ms)}`} · ${ago(h.at)}</span></li>`
    )
    .join('');
}

async function renderRecent() {
  const list = (await getHistory()).filter((h) => h.videoId !== state.videoId);
  $('recent-list').innerHTML = historyHtml(list) || '<li class="muted">Videos you open with the panel appear here.</li>';
}

let noVideoShown = false;
async function showNoVideo() {
  if (noVideoShown) return;
  noVideoShown = true;
  const list = (await getHistory()).slice(0, 5);
  if (state.videoId) return;
  setTranscriptStatus(
    'Open a YouTube video to see its transcript.' + (list.length ? `<div class="muted small">Continue where you stopped:</div><ul class="recent-list">${historyHtml(list)}</ul>` : '')
  );
}

async function openVideo(v) {
  const url = videoUrl(v);
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabId = state.tabId ?? active?.id;
  if (tabId != null) await chrome.tabs.update(tabId, { url });
  else await chrome.tabs.create({ url });
  closeRecent();
}

function closeRecent() {
  $('recent').hidden = true;
  $('open-recent').setAttribute('aria-expanded', 'false');
}
$('open-recent').addEventListener('click', async () => {
  if (!$('recent').hidden) return closeRecent();
  await renderRecent();
  $('recent').hidden = false;
  $('open-recent').setAttribute('aria-expanded', 'true');
});
$('recent-close').addEventListener('click', closeRecent);

// ---------- undo "I know it" ----------

async function updateUndo() {
  const { knownUndo = [] } = await chrome.storage.local.get('knownUndo');
  $('undo-known').hidden = !knownUndo.length;
  const last = knownUndo.at(-1);
  $('undo-count').textContent = knownUndo.length > 1 ? knownUndo.length : '';
  $('undo-known').title = last ? `Undo “I know it” for “${last.join(', ')}”${knownUndo.length > 1 ? ` (${knownUndo.length} steps)` : ''}` : '';
}
$('undo-known').addEventListener('click', async () => {
  const back = await undoKnown();
  if (back.length) toast(`“${back.join(', ')}” is a new word again`, 3000);
});

// ---------- transcript + analysis ----------

let loading = false;

async function loadTranscript(retry = 0) {
  if (loading) return;
  loading = true;
  const videoId = state.videoId;
  setTranscriptStatus('<span class="spinner"></span>Loading transcript…');
  try {
    const r = await toTab({ type: 'tt:transcript', lang: state.settings.learningLang });
    if (videoId !== state.videoId) return;
    if (!r?.ok) {
      if ((r?.reason === 'not-ready' || !r) && retry < 5) {
        loading = false;
        setTimeout(() => loadTranscript(retry + 1), 1200);
        return;
      }
      const what = state.shorts ? 'This Short' : 'This video';
      const why = {
        'no-captions': `${what} has no subtitles, so there is no transcript.${state.shorts ? ' Most Shorts have none.' : ''}`,
        'no-language': `${what} has no subtitles in your learning language. It has: ${escapeHtml((r.available || []).join(', '))}. <button class="link" data-action="open-settings">Change the language</button>`,
        blocked: state.shorts
          ? 'YouTube did not return subtitles for this Short. <button class="link" data-action="retry-transcript">Try again</button>'
          : 'YouTube did not return the subtitles. Press <b>C</b> on the video to turn subtitles on once, then <button class="link" data-action="retry-transcript">try again</button>.',
        'not-ready': 'The video page is still loading. <button class="link" data-action="retry-transcript">Try again</button>'
      }[r?.reason] ?? 'Could not load the transcript. <button class="link" data-action="retry-transcript">Try again</button>';
      setTranscriptStatus(why);
      return;
    }
    state.sentences = buildSentences(parseJson3(r.json));
    setTranscriptStatus(
      `${state.sentences.length} lines${r.track.kind === 'asr' ? ' · auto-generated subtitles: sentences may be split imperfectly' : ''}.` +
        (state.settings.setupDone ? '' : ' Finish the <button class="link" data-action="open-setup">quick setup</button> to see hard words and translations.')
    );
    startAnalysis();
    renderTranscript();
    emit('transcript');
  } finally {
    loading = false;
  }
}

function startAnalysis() {
  state.analysis?.stop();
  state.analysis = null;
  if (!state.settings.setupDone || !state.sentences.length) return;
  let pending = null; // Set of changed line ids, or 'all'
  state.analysis = new TranscriptAnalysis({
    settings: state.settings,
    videoId: state.videoId,
    sentences: state.sentences,
    startId: Math.max(0, sentenceAt(state.sentences, state.ms)),
    // Coalesce progress updates into one repaint per frame.
    onUpdate: (ids) => {
      const first = !pending;
      if (!ids?.length) pending = pending ?? new Set();
      else if (pending !== 'all') pending = new Set([...(pending ?? []), ...ids]);
      if (!first) return;
      requestAnimationFrame(() => {
        const changed = pending;
        pending = null;
        if (changed === 'all') refreshLines();
        else if (changed.size) refreshLines(changed);
        updateActive(true);
        renderAnalysisState();
        emit('analysis');
      });
    }
  });
  state.analysis.start().then(() => refreshLines());
}

// ---------- reminder about cards from earlier videos ----------

let reminderDismissed = false;

async function showReminder() {
  const others = (await getDrafts()).filter((d) => d.videoId !== state.videoId);
  const el = $('reminder');
  if (!others.length || reminderDismissed) {
    el.hidden = true;
    return;
  }
  el.innerHTML = `<span>${others.length} card${others.length > 1 ? 's' : ''} from earlier videos wait for review.</span>
    <span><button id="rem-open" class="link">Review</button><button id="rem-close" class="icon" aria-label="Dismiss">✕</button></span>`;
  el.hidden = false;
  $('rem-open').addEventListener('click', () => {
    el.hidden = true;
    showTab('cards');
  });
  $('rem-close').addEventListener('click', () => {
    reminderDismissed = true;
    el.hidden = true;
  });
}

// ---------- storage changes ----------

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.settings) {
    const before = state.settings;
    state.settings = await getSettings();
    emit('settings');
    const s = state.settings;
    if (before.learningLang !== s.learningLang || before.nativeLang !== s.nativeLang) {
      if (state.videoId) {
        state.analysis?.stop();
        state.analysis = null;
        state.sentences = [];
        renderTranscript();
        loadTranscript();
      }
    } else if (!state.analysis) {
      if (state.sentences.length && s.setupDone) startAnalysis();
    } else {
      state.analysis.settings = s;
      // A new key or AI: continue an analysis that was held up.
      const aiChanged =
        before.provider !== s.provider || before.backupProvider !== s.backupProvider || JSON.stringify(before.providers) !== JSON.stringify(s.providers);
      if (aiChanged && state.analysis.error) state.analysis.retry();
    }
    if (before.level !== s.level || before.showSentenceTranslation !== s.showSentenceTranslation) {
      refreshLines();
      emit('level');
    }
  }
  if (changes.knownWords || changes.deckWords) {
    state.words = await getWordSets();
    refreshLines();
    emit('words');
  }
  if (changes.knownUndo) updateUndo();
  // Don't repaint the review list while the user is typing in it.
  if (changes.drafts && !$('drafts').contains(document.activeElement)) emit('drafts');
  if (changes.ankiQueue && state.tab === 'cards') renderCards();
});

// ---------- start ----------

(async function init() {
  state.settings = await getSettings();
  state.words = await getWordSets();
  emit('settings');
  renderPrep();
  updateUndo();
  if (!state.settings.setupDone) {
    setTranscriptStatus('Finish the <button class="link" data-action="open-setup">quick setup</button> first (about 2 minutes).');
  }
  await findTab();
  refreshCount();
  setInterval(poll, 250);
  poll();
})();
