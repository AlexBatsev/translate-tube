// Settings and learner data live in chrome.storage.local (never synced,
// because they contain API keys).

export const DEFAULT_SETTINGS = {
  setupDone: false,
  learningLang: 'en',
  nativeLang: 'uk',
  provider: 'gemini',
  // Optional second AI used while the main one is out of limits ('' = none).
  backupProvider: '',
  providers: {
    // model '' = Automatic. autoModel / models / modelStatus are filled in at runtime.
    gemini: { apiKey: '', model: '' },
    claude: { apiKey: '', model: '' },
    openai: { apiKey: '', model: '' },
    openrouter: { apiKey: '', model: '' },
    ollama: { host: 'http://localhost:11434', model: '' }
  },
  // 1 (beginner) .. 6 (near native). Shown to the user in plain words.
  level: 3,
  anki: {
    // null = not decided yet, true = use Anki, false = no Anki (export only).
    enabled: null,
    // true once "Connect to Anki" worked.
    connected: false,
    url: 'http://127.0.0.1:8765',
    deck: 'Translate Tube',
    key: ''
  },
  pauseOnClick: true,
  resumeOnClose: true,
  // Translation line under transcript sentences: 'off' | 'current' | 'all'.
  showSentenceTranslation: 'off',
  // Lines per AI request when analysing a transcript.
  batchSize: 10
};

const PROVIDER_IDS = ['gemini', 'claude', 'openai', 'openrouter', 'ollama'];

export const LEVELS = [
  { value: 1, label: 'Just starting', hint: 'I know a few hundred everyday words.' },
  { value: 2, label: 'Basic', hint: 'Simple conversations and slow videos.' },
  { value: 3, label: 'Getting comfortable', hint: 'I follow easy videos but miss many words.' },
  { value: 4, label: 'Confident', hint: 'I follow most videos; slang and fast speech are hard.' },
  { value: 5, label: 'Advanced', hint: 'Only rare words, idioms and wordplay trip me up.' },
  { value: 6, label: 'Near native', hint: 'Show me only genuinely rare words.' }
];

function merge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return extra === undefined ? base : extra;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = merge(DEFAULT_SETTINGS, settings);
  // Older versions: a removed provider, and an on/off translation line.
  if (!PROVIDER_IDS.includes(s.provider)) s.provider = 'gemini';
  if (s.backupProvider && !PROVIDER_IDS.includes(s.backupProvider)) s.backupProvider = '';
  if (s.showSentenceTranslation === true) s.showSentenceTranslation = 'all';
  if (s.showSentenceTranslation === false) s.showSentenceTranslation = 'off';
  return s;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = merge(current, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

// Word lists: "known" words are never highlighted; "deck" words are words
// already sent to Anki (highlighted in a softer style for reinforcement).
export async function getWordSets() {
  const { knownWords = [], deckWords = [] } = await chrome.storage.local.get(['knownWords', 'deckWords']);
  return { known: new Set(knownWords), deck: new Set(deckWords) };
}

export async function addWords(listName, words) {
  const data = await chrome.storage.local.get(listName);
  const set = new Set(data[listName] ?? []);
  for (const w of words) {
    const k = normalizeWord(w);
    if (k) set.add(k);
  }
  await chrome.storage.local.set({ [listName]: [...set] });
  return set.size;
}

export async function removeWords(listName, words) {
  const drop = new Set(words.map(normalizeWord));
  const data = await chrome.storage.local.get(listName);
  await chrome.storage.local.set({ [listName]: (data[listName] ?? []).filter((w) => !drop.has(w)) });
}

// "I know it": marks words as known and remembers them so the last few
// marks can be undone one by one.
const UNDO_KEEP = 20;

export async function markKnown(words) {
  const { knownWords = [], knownUndo = [] } = await chrome.storage.local.get(['knownWords', 'knownUndo']);
  const set = new Set(knownWords);
  const added = [...new Set(words.map(normalizeWord))].filter((w) => w && !set.has(w));
  if (!added.length) return [];
  await chrome.storage.local.set({
    knownWords: [...knownWords, ...added],
    knownUndo: [...knownUndo, added].slice(-UNDO_KEEP)
  });
  return added;
}

// Undoes the last "I know it". Returns the words that are new again.
export async function undoKnown() {
  const { knownWords = [], knownUndo = [] } = await chrome.storage.local.get(['knownWords', 'knownUndo']);
  const last = knownUndo.pop();
  if (!last) return [];
  const drop = new Set(last);
  await chrome.storage.local.set({ knownWords: knownWords.filter((w) => !drop.has(w)), knownUndo });
  return last;
}

// Videos opened with the panel, newest first, so the user can go back to them.
const HISTORY_KEEP = 30;

export async function getHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  return history;
}

export async function rememberVideo({ videoId, title, ms, shorts }) {
  if (!videoId) return;
  const history = (await getHistory()).filter((h) => h.videoId !== videoId);
  history.unshift({ videoId, title, ms: Math.max(0, Math.round(ms ?? 0)), shorts: !!shorts, at: Date.now() });
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_KEEP) });
}

export function videoUrl({ videoId, shorts, ms = 0 }) {
  if (shorts) return `https://www.youtube.com/shorts/${videoId}`;
  const t = Math.floor(ms / 1000);
  return `https://www.youtube.com/watch?v=${videoId}${t > 5 ? `&t=${t}s` : ''}`;
}

// Everything the user would miss after reinstalling, for Backup / Restore.
// Transcript analyses are left out: they can be made again.
export const BACKUP_KEYS = ['settings', 'knownWords', 'knownUndo', 'deckWords', 'drafts', 'ankiQueue', 'ankiSent', 'history'];

export function normalizeWord(w) {
  return String(w ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
}
