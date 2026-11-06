// Side panel shell: tabs, video tracking, transcript loading and analysis.
import { $, state, on, emit, bg, toTab, escapeHtml } from './core.js';
import { getSettings, getWordSets } from '../lib/storage.js';
import { parseJson3, buildSentences } from '../lib/transcript.js';
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

// ---------- video tracking ----------

// ?tabId=N pins the panel to one tab (used when opening the panel page in a
// normal tab for debugging and automated tests).
const pinnedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

async function findTab() {
  if (pinnedTabId) {
    state.tabId = pinnedTabId;
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  state.tabId = tab?.url?.startsWith('https://www.youtube.com/') ? tab.id : null;
}

let injected = false;

async function poll() {
  const info = await toTab({ type: 'tt:info' });
  if (!info) {
    if (state.tabId != null && !injected) {
      injected = true;
      await bg('bg:injectTab', { tabId: state.tabId }).catch(() => {});
    }
    if (!state.videoId) setTranscriptStatus('Open a YouTube video to see its transcript.');
    return;
  }
  if (info.videoId !== state.videoId) onVideoChange(info);
  state.ms = info.ms;
  state.paused = info.paused;
  if (info.title && info.title !== state.title) {
    state.title = info.title;
    $('video-title').textContent = info.title;
  }
  updateActive();
}

function onVideoChange(info) {
  state.videoId = info.videoId;
  state.title = info.title;
  $('video-title').textContent = info.videoId ? info.title : '';
  state.analysis?.stop();
  state.analysis = null;
  state.sentences = [];
  hidePopover();
  resetPrep();
  renderTranscript();
  renderAnalysisState();
  if (info.videoId) {
    loadTranscript();
    showReminder();
  } else {
    setTranscriptStatus('Open a YouTube video to see its transcript.');
  }
}

chrome.tabs.onActivated.addListener(async () => {
  injected = false;
  await findTab();
});
chrome.tabs.onUpdated.addListener(async (_id, change) => {
  if (change.url || change.status === 'complete') await findTab();
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
      const why = {
        'no-captions': 'This video has no subtitles, so there is no transcript.',
        'no-language': `No subtitles in your learning language. Available: ${escapeHtml((r.available || []).join(', '))}.`,
        blocked: 'YouTube did not return the subtitles. Press <b>C</b> on the video to turn subtitles on once, then <button id="retry-tr" class="link">try again</button>.',
        'not-ready': 'The video page is still loading. <button id="retry-tr" class="link">Try again</button>'
      }[r?.reason] ?? 'Could not load the transcript. <button id="retry-tr" class="link">Try again</button>';
      setTranscriptStatus(why);
      $('retry-tr')?.addEventListener('click', () => loadTranscript());
      return;
    }
    state.sentences = buildSentences(parseJson3(r.json));
    setTranscriptStatus(r.track.kind === 'asr' ? 'Auto-generated subtitles: sentences may be split imperfectly.' : '');
    startAnalysis();
    renderTranscript();
  } finally {
    loading = false;
  }
}

function startAnalysis() {
  state.analysis?.stop();
  if (!state.settings.setupDone) return;
  let pending = false;
  state.analysis = new TranscriptAnalysis({
    settings: state.settings,
    videoId: state.videoId,
    sentences: state.sentences,
    // Coalesce progress updates into one repaint per frame.
    onUpdate: () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        refreshLines();
        updateActive(true);
        renderAnalysisState();
        emit('analysis');
      });
    }
  });
  state.analysis.start();
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
    if (before.learningLang !== state.settings.learningLang || before.nativeLang !== state.settings.nativeLang) {
      if (state.videoId) {
        state.sentences = [];
        renderTranscript();
        loadTranscript();
      }
    } else if (before.provider !== state.settings.provider || before.setupDone !== state.settings.setupDone) {
      if (state.sentences.length && !state.analysis) startAnalysis();
    }
    if (state.analysis) state.analysis.settings = state.settings;
    if (before.level !== state.settings.level || before.showSentenceTranslation !== state.settings.showSentenceTranslation) {
      refreshLines();
      emit('level');
    }
  }
  if (changes.knownWords || changes.deckWords) {
    state.words = await getWordSets();
    refreshLines();
    emit('words');
  }
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
  if (!state.settings.setupDone) {
    setTranscriptStatus('Finish the quick setup first: <button id="go-setup" class="link">open setup</button>');
    $('go-setup').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') }));
  }
  await findTab();
  refreshCount();
  setInterval(poll, 250);
  poll();
})();
