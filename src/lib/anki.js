// Talks to Anki through the AnkiConnect add-on (https://ankiweb.net/shared/info/2055492159).
// Cards are queued in the extension and sent whenever Anki is reachable.
import { NOTE_TYPE, NOTE_FIELDS } from './card.js';

export class AnkiOffline extends Error {}

export async function invoke(anki, action, params = {}) {
  let res;
  try {
    res = await fetch(anki.url, {
      method: 'POST',
      body: JSON.stringify({ action, version: 6, params, ...(anki.key ? { key: anki.key } : {}) })
    });
  } catch {
    throw new AnkiOffline('Anki is not running (or AnkiConnect is not installed).');
  }
  if (res.status === 403) throw new Error('AnkiConnect refused the request. Click "Connect to Anki" in Settings and allow it in Anki.');
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export async function requestPermission(anki) {
  const r = await invoke(anki, 'requestPermission');
  if (r.permission !== 'granted') throw new Error('Anki did not allow the connection. Try again and click "Yes" in Anki.');
  return r;
}

async function templates() {
  const get = async (f) => (await fetch(chrome.runtime.getURL(`src/anki/${f}`))).text();
  return { front: await get('front.html'), back: await get('back.html'), css: await get('card.css') };
}

export async function ensureNoteTypeAndDeck(anki) {
  const models = await invoke(anki, 'modelNames');
  if (!models.includes(NOTE_TYPE)) {
    const t = await templates();
    await invoke(anki, 'createModel', {
      modelName: NOTE_TYPE,
      inOrderFields: NOTE_FIELDS,
      css: t.css,
      isCloze: false,
      cardTemplates: [{ Name: 'Word → Meaning', Front: t.front, Back: t.back }]
    });
  }
  const decks = await invoke(anki, 'deckNames');
  if (!decks.includes(anki.deck)) await invoke(anki, 'createDeck', { deck: anki.deck });
}

export async function checkConnection(anki) {
  await requestPermission(anki);
  const version = await invoke(anki, 'version');
  await ensureNoteTypeAndDeck(anki);
  return version;
}

async function addNote(anki, fields) {
  try {
    return await invoke(anki, 'addNote', {
      note: {
        deckName: anki.deck,
        modelName: NOTE_TYPE,
        fields,
        tags: ['translate-tube'],
        options: { allowDuplicate: false, duplicateScope: 'deck' }
      }
    });
  } catch (e) {
    if (/duplicate/i.test(e.message)) return 'duplicate';
    throw e;
  }
}

// ---- queue ----

async function load() {
  const { ankiQueue = [], ankiSent = [] } = await chrome.storage.local.get(['ankiQueue', 'ankiSent']);
  return { ankiQueue, ankiSent };
}

export async function enqueue(card) {
  const { ankiQueue } = await load();
  ankiQueue.push({ id: crypto.randomUUID(), createdAt: Date.now(), ...card });
  await chrome.storage.local.set({ ankiQueue });
}

let flushing = null;

export function flushQueue(anki) {
  flushing ??= doFlush(anki).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function doFlush(anki) {
  let { ankiQueue } = await load();
  if (!ankiQueue.length) return { sent: 0, left: 0 };
  let sent = 0;
  let error = null;
  try {
    await ensureNoteTypeAndDeck(anki);
  } catch (e) {
    return { sent: 0, left: ankiQueue.length, error: e.message, offline: e instanceof AnkiOffline };
  }
  for (const item of [...ankiQueue]) {
    try {
      await addNote(anki, item.fields);
      sent++;
      const state = await load();
      state.ankiQueue = state.ankiQueue.filter((q) => q.id !== item.id);
      state.ankiSent = [...state.ankiSent, { ...item, sentAt: Date.now() }].slice(-1000);
      await chrome.storage.local.set(state);
    } catch (e) {
      error = e;
      if (e instanceof AnkiOffline) break;
      const state = await load();
      const q = state.ankiQueue.find((x) => x.id === item.id);
      if (q) q.lastError = e.message;
      await chrome.storage.local.set({ ankiQueue: state.ankiQueue });
    }
  }
  ({ ankiQueue } = await load());
  return { sent, left: ankiQueue.length, error: error?.message, offline: error instanceof AnkiOffline };
}
