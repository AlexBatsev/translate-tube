import { getProvider, rankModels } from './providers/index.js';
import { languageName } from './languages.js';
import { LEVELS, getSettings, saveSettings } from './storage.js';

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

// ---- running a prompt, with Automatic model choice ----

const TIMEOUT = { explain: 25000, analyze: 90000, test: 25000 };

// Errors where another model may work: retired, overloaded, rate-limited,
// no answer, or a model that does not accept this kind of request.
export function shouldTryNextModel(e) {
  if (e.timeout) return true;
  if ([404, 429, 500, 502, 503, 504].includes(e.status)) return true;
  return e.status === 400 && /(model|instruction|not supported|not enabled|unsupported)/i.test(e.message);
}

async function updateProviderCfg(providerId, patch) {
  const s = await getSettings();
  await saveSettings({ providers: { [providerId]: { ...s.providers[providerId], ...patch } } });
}

async function markModel(providerId, model, ok) {
  const s = await getSettings();
  const status = s.providers[providerId]?.modelStatus ?? {};
  if (status[model] === (ok ? 'ok' : 'fail')) return;
  await updateProviderCfg(providerId, { modelStatus: { ...status, [model]: ok ? 'ok' : 'fail' } });
}

export async function loadModels(settings) {
  const provider = getProvider(settings.provider);
  const cfg = settings.providers[provider.id] ?? {};
  const models = await provider.listModels(cfg);
  await updateProviderCfg(provider.id, { models });
  return models;
}

async function run(settings, req, { maxTries = 5, onAttempt } = {}) {
  const provider = getProvider(settings.provider);
  const cfg = settings.providers[provider.id] ?? {};
  if (cfg.model) {
    onAttempt?.(cfg.model);
    try {
      const text = await provider.complete(cfg, req);
      await markModel(provider.id, cfg.model, true);
      return { text, model: cfg.model };
    } catch (e) {
      if (shouldTryNextModel(e)) await markModel(provider.id, cfg.model, false);
      throw e;
    }
  }
  let models = cfg.models;
  if (!models?.length) models = await loadModels(settings);
  const ranked = rankModels(provider, models);
  if (!ranked.length) throw new Error('No usable models found for this key.');
  const order = ranked.includes(cfg.autoModel) ? [cfg.autoModel, ...ranked.filter((m) => m !== cfg.autoModel)] : ranked;
  let lastError;
  for (const model of order.slice(0, maxTries)) {
    onAttempt?.(model);
    try {
      const text = await provider.complete({ ...cfg, model }, req);
      if (model !== cfg.autoModel) await updateProviderCfg(provider.id, { autoModel: model });
      await markModel(provider.id, model, true);
      return { text, model };
    } catch (e) {
      if (!shouldTryNextModel(e)) throw e;
      await markModel(provider.id, model, false);
      lastError = e;
    }
  }
  throw lastError;
}

// ---- prompts ----

export function buildExplainPrompt({ term, sentence, previous }) {
  return [
    previous ? `Previous line: "${previous}"` : '',
    `Sentence: "${sentence}"`,
    `Explain: "${term}"`,
    '',
    'If the term is part of a larger idiom or phrasal verb in this sentence, explain the whole expression and put it in "term" exactly as it appears in the sentence.',
    'Return: {"term": string, "lemma": dictionary form of the whole expression (e.g. "blew it" -> "blow it", "kicked off" -> "kick off"), "translation": short contextual translation of the dictionary form, "note": memory note, "isIdiom": boolean, "sentenceTranslation": translation of the sentence, "termInTranslation": the exact words of sentenceTranslation that translate the term}'
  ].filter(Boolean).join('\n');
}

export async function explainTerm(settings, { term, sentence, previous }) {
  const provider = getProvider(settings.provider);
  const cfg = settings.providers[provider.id] ?? {};
  if (!provider.canExplain) {
    const [translation, sentenceTranslation] = await provider.translate(cfg, [term, sentence], {
      from: settings.learningLang,
      to: settings.nativeLang,
      context: sentence
    });
    return { term, lemma: term, translation, note: '', isIdiom: false, sentenceTranslation, termInTranslation: '' };
  }
  const { text } = await run(settings, {
    system: system(settings),
    prompt: buildExplainPrompt({ term, sentence, previous }),
    json: true,
    timeoutMs: TIMEOUT.explain
  });
  const out = parseJsonLoose(text);
  return {
    term: out.term || term,
    lemma: out.lemma || out.term || term,
    translation: out.translation || '',
    note: out.note || '',
    isIdiom: !!out.isIdiom,
    sentenceTranslation: out.sentenceTranslation || '',
    termInTranslation: out.termInTranslation || ''
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
    'Return: {"sentences": [{"id": number, "translation": string, "hard": [{"text": exact text as it appears in the sentence, "lemma": dictionary form of the whole expression, "translation": contextual translation, "note": memory note, "inTranslation": the exact words of this sentence\'s translation that translate it}]}]}'
  ].filter(Boolean).join('\n');
}

export async function analyzeSentences(settings, sentences, words) {
  const provider = getProvider(settings.provider);
  const cfg = settings.providers[provider.id] ?? {};
  if (!provider.canExplain) {
    const translations = await provider.translate(cfg, sentences.map((s) => s.text), {
      from: settings.learningLang,
      to: settings.nativeLang
    });
    return sentences.map((s, i) => ({ id: s.id, translation: translations[i], hard: [] }));
  }
  const { text } = await run(settings, {
    system: system(settings),
    prompt: buildAnalyzePrompt(sentences, words),
    json: true,
    timeoutMs: TIMEOUT.analyze
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

// Returns { message, model } or throws. onAttempt(model) reports progress.
export async function testProvider(settings, onAttempt) {
  const provider = getProvider(settings.provider);
  const cfg = settings.providers[provider.id] ?? {};
  if (!provider.canExplain) {
    const [t] = await provider.translate(cfg, ['Hello, world!'], { from: 'en', to: settings.nativeLang });
    return { message: `Works: "Hello, world!" = ${t}`, model: '' };
  }
  const { text, model } = await run(
    settings,
    {
      system: system(settings),
      prompt: buildExplainPrompt({ term: 'break the ice', sentence: "Let's play a game to break the ice." }),
      json: true,
      timeoutMs: TIMEOUT.test
    },
    { maxTries: 4, onAttempt }
  );
  const r = parseJsonLoose(text);
  return { message: `Works with ${model}: "break the ice" = ${r.translation}`, model };
}
