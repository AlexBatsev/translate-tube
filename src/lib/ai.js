import { getProvider } from './providers/index.js';
import { languageName } from './languages.js';
import { LEVELS } from './storage.js';

export function parseJsonLoose(text) {
  const cleaned = String(text).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('The AI answer was not valid JSON. Try again or pick another model.');
  }
}

export function levelText(level) {
  const l = LEVELS.find((x) => x.value === Number(level)) ?? LEVELS[2];
  return `${l.label} (${l.hint})`;
}

function system(settings) {
  const from = languageName(settings.learningLang);
  const to = languageName(settings.nativeLang);
  return [
    `You help a ${to} speaker learn ${from} from YouTube videos.`,
    `Learner level: ${levelText(settings.level)}`,
    `Always translate into ${to}. Translate words as they are used in the given sentence (contextual meaning), not the dictionary's first sense.`,
    'Treat idioms, phrasal verbs and fixed expressions as one unit.',
    'Slang and vulgar words are fine; translate them honestly with an equivalent register.',
    `Memory notes are short (max 25 words, in ${to}): an image, root, sound-alike or contrast that makes the meaning stick.`,
    'Reply with JSON only.'
  ].join('\n');
}

function providerConfig(settings) {
  const provider = getProvider(settings.provider);
  return { provider, cfg: settings.providers[provider.id] ?? {} };
}

export function buildExplainPrompt({ term, sentence, previous }) {
  return [
    previous ? `Previous line: "${previous}"` : '',
    `Sentence: "${sentence}"`,
    `Explain: "${term}"`,
    '',
    'If the term is part of a larger idiom or phrasal verb in this sentence, explain the whole expression and put it in "term".',
    'Return: {"term": string, "lemma": dictionary form, "translation": short contextual translation, "note": memory note, "isIdiom": boolean, "sentenceTranslation": translation of the sentence}'
  ].filter(Boolean).join('\n');
}

export async function explainTerm(settings, { term, sentence, previous }) {
  const { provider, cfg } = providerConfig(settings);
  if (!provider.canExplain) {
    const [translation, sentenceTranslation] = await provider.translate(cfg, [term, sentence], {
      from: settings.learningLang,
      to: settings.nativeLang,
      context: sentence
    });
    return { term, lemma: term, translation, note: '', isIdiom: false, sentenceTranslation };
  }
  const text = await provider.complete(cfg, {
    system: system(settings),
    prompt: buildExplainPrompt({ term, sentence, previous }),
    json: true
  });
  const out = parseJsonLoose(text);
  return {
    term: out.term || term,
    lemma: out.lemma || out.term || term,
    translation: out.translation || '',
    note: out.note || '',
    isIdiom: !!out.isIdiom,
    sentenceTranslation: out.sentenceTranslation || ''
  };
}

export function buildAnalyzePrompt(sentences, { known = [], deck = [] } = {}) {
  return [
    'For each sentence below: translate it, and list the words or expressions this learner probably does not know yet.',
    'Pick only what is hard for this level. Skip names and very common words. Mark a whole idiom/phrasal verb as one item.',
    known.length ? `The learner already knows these words (never list them): ${known.slice(0, 400).join(', ')}` : '',
    deck.length ? `The learner is studying these words (list them if they appear): ${deck.slice(0, 400).join(', ')}` : '',
    '',
    'Sentences:',
    ...sentences.map((s) => `${s.id}: ${s.text}`),
    '',
    'Return: {"sentences": [{"id": number, "translation": string, "hard": [{"text": exact text as it appears in the sentence, "lemma": dictionary form, "translation": contextual translation, "note": memory note}]}]}'
  ].filter(Boolean).join('\n');
}

export async function analyzeSentences(settings, sentences, words) {
  const { provider, cfg } = providerConfig(settings);
  if (!provider.canExplain) {
    const translations = await provider.translate(cfg, sentences.map((s) => s.text), {
      from: settings.learningLang,
      to: settings.nativeLang
    });
    return sentences.map((s, i) => ({ id: s.id, translation: translations[i], hard: [] }));
  }
  const text = await provider.complete(cfg, {
    system: system(settings),
    prompt: buildAnalyzePrompt(sentences, words),
    json: true
  });
  const out = parseJsonLoose(text);
  const byId = new Map((out.sentences ?? []).map((s) => [Number(s.id), s]));
  return sentences.map((s) => {
    const r = byId.get(s.id) ?? {};
    return {
      id: s.id,
      translation: r.translation ?? '',
      hard: (r.hard ?? []).filter((h) => h && h.text && s.text.toLowerCase().includes(String(h.text).toLowerCase()))
    };
  });
}

export async function testProvider(settings) {
  const { provider, cfg } = providerConfig(settings);
  if (!provider.canExplain) {
    const [t] = await provider.translate(cfg, ['Hello, world!'], { from: settings.learningLang, to: settings.nativeLang });
    return `DeepL works: "${t}"`;
  }
  const r = await explainTerm(settings, { term: 'break the ice', sentence: "Let's play a game to break the ice." });
  return `Works: "${r.term}" = ${r.translation}`;
}
