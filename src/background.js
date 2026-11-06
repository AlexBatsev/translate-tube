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

// Badge = cards to review + cards waiting for Anki.
async function updateBadge() {
  const { ankiQueue = [], drafts = [] } = await chrome.storage.local.get(['ankiQueue', 'drafts']);
  const n = ankiQueue.length + drafts.length;
  await chrome.action.setBadgeBackgroundColor({ color: drafts.length ? '#2563eb' : '#b45309' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.drafts || changes.ankiQueue) updateBadge();
});

// cards: built by draftToCards(). The card front shows the dictionary form;
// the sentence keeps the form used in the video.
async function sendCards(cards) {
  for (const c of cards) {
    await enqueue({ fields: buildCard(c), term: c.term, translation: c.translation });
  }
  await addWords('deckWords', cards.map((c) => normalizeWord(c.lemma || c.term)));
  const result = await flush();
  return { ...result, queued: result.left > 0 };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    'bg:sendCards': () => sendCards(msg.cards),
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
