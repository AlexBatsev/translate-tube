// Talks to Anki through the AnkiConnect add-on (https://ankiweb.net/shared/info/2055492159).
// Cards are queued in the extension and sent whenever Anki is reachable.
import { NOTE_TYPE, NOTE_FIELDS } from './card.js';
import { speechLocale } from './languages.js';
import { saveSettings, normalizeWord } from './storage.js';

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

// Raise this when the files in src/anki change, so Anki gets the new card layout.
const TEMPLATE_VERSION = 2;

// The card speaks the word with Anki's own text-to-speech, in the learning language.
export function speakTag(lang) {
  const locale = speechLocale(lang);
  return locale ? `{{tts ${locale}:Word}}` : '';
}

async function templates(lang) {
  const get = async (f) => (await fetch(chrome.runtime.getURL(`src/anki/${f}`))).text();
  return { front: (await get('front.html')).replace('{{SPEAK}}', speakTag(lang)), back: await get('back.html'), css: await get('card.css') };
}

// lang: the learning language (for the spoken word on the card).
export async function ensureNoteTypeAndDeck(anki, lang) {
  const models = await invoke(anki, 'modelNames');
  const wanted = `${TEMPLATE_VERSION}:${lang ?? ''}`;
  if (!models.includes(NOTE_TYPE)) {
    const t = await templates(lang);
    await invoke(anki, 'createModel', {
      modelName: NOTE_TYPE,
      inOrderFields: NOTE_FIELDS,
      css: t.css,
      isCloze: false,
      cardTemplates: [{ Name: 'Word → Meaning', Front: t.front, Back: t.back }]
    });
    await saveSettings({ anki: { template: wanted } });
  } else if (anki.template !== wanted) {
    // The card layout changed since it was last written to Anki.
    try {
      const t = await templates(lang);
      const [name] = Object.keys(await invoke(anki, 'modelTemplates', { modelName: NOTE_TYPE }));
      await invoke(anki, 'updateModelTemplates', { model: { name: NOTE_TYPE, templates: { [name]: { Front: t.front, Back: t.back } } } });
      await invoke(anki, 'updateModelStyling', { model: { name: NOTE_TYPE, css: t.css } });
      await saveSettings({ anki: { template: wanted } });
    } catch (e) {
      if (e instanceof AnkiOffline) throw e;
      /* cards still work with the layout Anki has */
    }
  }
  const decks = await invoke(anki, 'deckNames');
  if (!decks.includes(anki.deck)) await invoke(anki, 'createDeck', { deck: anki.deck });
}

export async function checkConnection(anki, lang) {
  await requestPermission(anki);
  const version = await invoke(anki, 'version');
  await ensureNoteTypeAndDeck(anki, lang);
  return version;
}

function plainText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// The words on the front of every card in the deck, and of every card made
// with the Translate Tube note type, whoever made them.
export async function deckWords(anki) {
  const ids = await invoke(anki, 'findNotes', { query: `"deck:${anki.deck}" OR "note:${NOTE_TYPE}"` });
  const words = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    for (const n of await invoke(anki, 'notesInfo', { notes: ids.slice(i, i + 500) })) {
      const first = Object.values(n.fields ?? {}).find((f) => f.order === 0);
      const w = normalizeWord(plainText(first?.value));
      if (w && w.length <= 80) words.add(w);
    }
  }
  return [...words];
}

export async function syncAnki(anki) {
  try {
    await invoke(anki, 'sync');
  } catch {
    /* Anki syncs the next time the user asks */
  }
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

export function flushQueue(anki, lang) {
  flushing ??= doFlush(anki, lang).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function doFlush(anki, lang) {
  let { ankiQueue } = await load();
  if (!ankiQueue.length) return { sent: 0, duplicates: 0, left: 0 };
  let sent = 0;
  let duplicates = 0;
  let error = null;
  try {
    await ensureNoteTypeAndDeck(anki, lang);
  } catch (e) {
    return { sent: 0, duplicates: 0, left: ankiQueue.length, error: e.message, offline: e instanceof AnkiOffline };
  }
  for (const item of [...ankiQueue]) {
    try {
      const dup = (await addNote(anki, item.fields)) === 'duplicate';
      if (dup) duplicates++;
      else sent++;
      const state = await load();
      state.ankiQueue = state.ankiQueue.filter((q) => q.id !== item.id);
      state.ankiSent = [...state.ankiSent, { ...item, sentAt: Date.now(), duplicate: dup }].slice(-1000);
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
  return { sent, duplicates, left: ankiQueue.length, error: error?.message, offline: error instanceof AnkiOffline };
}
