// Settings and learner data live in chrome.storage.local (never synced,
// because they contain API keys).

export const DEFAULT_SETTINGS = {
  setupDone: false,
  learningLang: 'en',
  nativeLang: 'uk',
  provider: 'gemini',
  providers: {
    // model '' = Automatic. autoModel / models / modelStatus are filled in at runtime.
    gemini: { apiKey: '', model: '' },
    claude: { apiKey: '', model: '' },
    openai: { apiKey: '', model: '' },
    deepl: { apiKey: '' },
    ollama: { host: 'http://localhost:11434', model: '' }
  },
  // 1 (beginner) .. 6 (near native). Shown to the user in plain words.
  level: 3,
  anki: {
    url: 'http://127.0.0.1:8765',
    deck: 'Translate Tube',
    key: ''
  },
  pauseOnClick: true,
  showSentenceTranslation: false
};

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
  return merge(DEFAULT_SETTINGS, settings);
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

export function normalizeWord(w) {
  return String(w ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
}
