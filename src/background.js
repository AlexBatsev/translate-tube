import { getSettings, addWords, normalizeWord } from './lib/storage.js';
import { buildCard } from './lib/card.js';
import { enqueue, flushQueue, checkConnection } from './lib/anki.js';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.alarms.create('flush-anki', { periodInMinutes: 1 });
  await injectIntoOpenTabs();
  const settings = await getSettings();
  if (reason === 'install' || !settings.setupDone) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('flush-anki', { periodInMinutes: 1 });
  flush();
});

// Tabs that were open before install/update have no content script yet.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
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
});

async function flush() {
  const settings = await getSettings();
  const result = await flushQueue(settings.anki);
  await updateBadge();
  return result;
}

async function updateBadge() {
  const { ankiQueue = [] } = await chrome.storage.local.get('ankiQueue');
  await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
  await chrome.action.setBadgeText({ text: ankiQueue.length ? String(ankiQueue.length) : '' });
}

async function addCard(data) {
  // Card front shows the dictionary form; the sentence keeps the form used in the video.
  const fields = buildCard({ ...data, term: data.lemma || data.term, surface: data.term });
  await enqueue({ fields, term: data.lemma || data.term, translation: data.translation });
  await addWords('deckWords', [normalizeWord(data.lemma || data.term)]);
  const result = await flush();
  return { ...result, queued: result.left > 0 };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    'bg:addCard': () => addCard(msg.card),
    'bg:flush': () => flush(),
    'bg:ankiCheck': () => checkConnection(msg.anki),
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
