import { getSettings, normalizeWord } from './lib/storage.js';
import { buildCard } from './lib/card.js';
import { enqueue, flushQueue, checkConnection, deckWords, syncAnki, AnkiOffline } from './lib/anki.js';

const YOUTUBE = ['https://www.youtube.com/*'];

function setAlarms() {
  chrome.alarms.create('flush-anki', { periodInMinutes: 1 });
  chrome.alarms.create('anki-words', { periodInMinutes: 360 });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  setAlarms();
  await injectIntoOpenTabs();
  const settings = await getSettings();
  if (reason === 'install' || !settings.setupDone) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  }
  refreshDeckWords();
});

chrome.runtime.onStartup.addListener(() => {
  setAlarms();
  flush();
  refreshDeckWords();
});

// Tabs that were open before install/update have no content script yet.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: YOUTUBE });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/main-world.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/youtube.js'] });
    } catch {
      /* tab may be discarded or restricted */
    }
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'flush-anki') flush();
  if (a.name === 'anki-words') refreshDeckWords();
});

async function flush() {
  const settings = await getSettings();
  if (settings.anki.enabled === false) {
    await updateBadge();
    const { ankiQueue = [] } = await chrome.storage.local.get('ankiQueue');
    return { sent: 0, duplicates: 0, left: ankiQueue.length, error: 'Anki is turned off in Settings.', offline: true };
  }
  const result = await flushQueue(settings.anki, settings.learningLang);
  await updateBadge();
  if (result.sent && settings.anki.syncAfterSend) syncAnki(settings.anki);
  return result;
}

// Makes "in my cards" match what Anki really holds: every card in the deck,
// including ones made elsewhere, plus cards still waiting to be sent. When
// Anki cannot be reached the list stays as it is.
async function refreshDeckWords() {
  const settings = await getSettings();
  if (!settings.anki.enabled || !settings.anki.connected) return { ok: false };
  try {
    const inAnki = await deckWords(settings.anki);
    const { ankiQueue = [], deckWords: before = [] } = await chrome.storage.local.get(['ankiQueue', 'deckWords']);
    const next = [...new Set([...inAnki, ...ankiQueue.map((q) => normalizeWord(q.lemma || q.term)).filter(Boolean)])];
    if (next.length !== before.length || next.some((w, i) => w !== before[i])) await chrome.storage.local.set({ deckWords: next });
    return { ok: true, count: next.length };
  } catch (e) {
    return { ok: false, offline: e instanceof AnkiOffline, error: e.message };
  }
}

// Badge = cards to review + cards waiting for Anki.
async function updateBadge() {
  const { ankiQueue = [], drafts = [] } = await chrome.storage.local.get(['ankiQueue', 'drafts']);
  const n = ankiQueue.length + drafts.length;
  await chrome.action.setBadgeBackgroundColor({ color: drafts.length ? '#2563eb' : '#b45309' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  const parts = [];
  if (drafts.length) parts.push(`${drafts.length} card${drafts.length > 1 ? 's' : ''} to review`);
  if (ankiQueue.length) parts.push(`${ankiQueue.length} waiting for Anki`);
  await chrome.action.setTitle({ title: parts.length ? `Translate Tube: ${parts.join(' · ')}` : 'Translate Tube' });
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.drafts || changes.ankiQueue) updateBadge();
});

// cards: built by draftToCards(). The card front shows the dictionary form;
// the sentence keeps the form used in the video.
async function sendCards(cards) {
  for (const c of cards) {
    await enqueue({ fields: buildCard(c), term: c.term, lemma: c.lemma || c.term, translation: c.translation });
  }
  const { deckWords: before = [] } = await chrome.storage.local.get('deckWords');
  const next = new Set([...before, ...cards.map((c) => normalizeWord(c.lemma || c.term)).filter(Boolean)]);
  await chrome.storage.local.set({ deckWords: [...next] });
  const result = await flush();
  return { ...result, queued: result.left > 0 };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    'bg:sendCards': () => sendCards(msg.cards),
    'bg:flush': () => flush(),
    'bg:removeQueued': async () => {
      const { ankiQueue = [] } = await chrome.storage.local.get('ankiQueue');
      await chrome.storage.local.set({ ankiQueue: ankiQueue.filter((q) => q.id !== msg.id) });
      await updateBadge();
      return true;
    },
    'bg:ankiCheck': async () => {
      const version = await checkConnection(msg.anki, (await getSettings()).learningLang);
      return version;
    },
    'bg:ankiWords': () => refreshDeckWords(),
    'bg:injectTab': async () => {
      await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['src/content/main-world.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['src/content/youtube.js'] });
      return true;
    }
  };
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve()
    .then(h)
    .then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
