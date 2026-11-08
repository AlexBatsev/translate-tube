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
    `Always translate into ${to}. Pick the sense a word has in the given sentence (not the dictionary's first sense), but word the translation in general dictionary form.`,
    'Treat idioms, phrasal verbs and fixed expressions as one unit.',
    'Slang and vulgar words are fine; translate them honestly with an equivalent register.',
    `Memory notes are short (max 25 words, in ${to}): an image, root, sound-alike or contrast that makes the meaning stick.`,
    'Reply with JSON only.'
  ].join('\n');
}

// ---- running a prompt, with Automatic model choice ----

const TIMEOUT = { explain: 25000, analyze: 90000, test: 25000 };

export class BadAnswerError extends Error {}

export function parseJsonStrict(text) {
  try {
    return parseJsonLoose(text);
  } catch {
    throw new BadAnswerError('The AI sent a garbled answer.');
  }
}

// Errors where another model may work: retired, overloaded, rate-limited,
// no answer, or a model that does not accept this kind of request.
export function shouldTryNextModel(e) {
  if (e.timeout) return true;
  if ([402, 404, 429, 500, 502, 503, 504].includes(e.status)) return true;
  return e.status === 400 && /(model|instruction|not supported|not enabled|unsupported)/i.test(e.message);
}

// A retired model never comes back, so Automatic mode stops trying it.
export function isRetired(e) {
  return e.status === 404 || /no longer available|not found|deprecated|retired/i.test(e.message ?? '');
}

// Short human reason for one failed attempt.
export function failureReason(e) {
  if (e.timeout) return 'no answer';
  if (isRetired(e)) return 'retired';
  if (e.status === 429) return 'limit reached';
  if (e.status === 402) return 'no credits';
  if ([500, 502, 503, 504].includes(e.status)) return 'busy';
  if (e.status === 400) return 'not suitable';
  return e.message;
}

// What kind of failure, so the panel can say what to do:
// 'key' (missing or rejected key), 'limit' (rate/quota), 'busy' (no model
// answered for another reason), or '' (anything else).
export function errorKind(e) {
  if (e?.kind) return e.kind;
  if (e?.status === 401 || e?.status === 403) return 'key';
  if (e?.status === 400 && /api key|api_key|invalid key|key not valid|authentication|permission/i.test(e.message ?? '')) return 'key';
  if (e?.status === 429 || e?.status === 402) return 'limit';
  return '';
}

export class AiError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

export function needsKey(settings) {
  const provider = getProvider(settings.provider);
  const cfg = settings.providers[provider.id] ?? {};
  return provider.fields.includes('apiKey') && !cfg.apiKey;
}

async function updateProviderCfg(providerId, patch) {
  const s = await getSettings();
  await saveSettings({ providers: { [providerId]: { ...s.providers[providerId], ...patch } } });
}

async function markModel(providerId, model, mark) {
  const s = await getSettings();
  const status = s.providers[providerId]?.modelStatus ?? {};
  if (status[model] === mark || status[model] === 'retired') return;
  await updateProviderCfg(providerId, { modelStatus: { ...status, [model]: mark } });
}

export async function loadModels(settings) {
  const provider = getProvider(settings.provider);
  const cfg = settings.providers[provider.id] ?? {};
  const models = await provider.listModels(cfg);
  await updateProviderCfg(provider.id, { models });
  return models;
}

// Main AI first. If it is out of limits or not answering, the optional backup
// AI takes over, and the main one is tried again after a pause.
const mainPausedUntil = {};
const MAIN_PAUSE = { limit: 5 * 60000, busy: 60000 };

export function backupSettings(settings) {
  const b = settings.backupProvider;
  if (!b || b === settings.provider) return null;
  const s = { ...settings, provider: b };
  return needsKey(s) ? null : s;
}

async function run(settings, req, opts = {}) {
  const backup = backupSettings(settings);
  if (!backup) return runOne(settings, req, opts);
  const main = settings.provider;
  if (Date.now() < (mainPausedUntil[main] ?? 0)) {
    try {
      return await runOne(backup, req, opts);
    } catch (e) {
      if (!['limit', 'busy'].includes(errorKind(e))) throw e;
      // Backup is stuck too: try the main one after all.
    }
  }
  try {
    const r = await runOne(settings, req, opts);
    delete mainPausedUntil[main];
    return r;
  } catch (e) {
    const kind = errorKind(e);
    if (kind !== 'limit' && kind !== 'busy') throw e;
    mainPausedUntil[main] = Date.now() + MAIN_PAUSE[kind];
    return runOne(backup, req, opts);
  }
}

async function runOne(settings, req, { maxTries = 4, onAttempt } = {}) {
  const provider = getProvider(settings.provider);
  const cfg = settings.providers[provider.id] ?? {};
  if (needsKey(settings)) throw new AiError(`Add your ${provider.name} key in Settings.`, 'key');
  if (cfg.model) {
    onAttempt?.(cfg.model);
    try {
      const text = await provider.complete(cfg, req);
      await markModel(provider.id, cfg.model, 'ok');
      return { text, model: cfg.model };
    } catch (e) {
      if (shouldTryNextModel(e)) {
        await markModel(provider.id, cfg.model, isRetired(e) ? 'retired' : 'fail');
        throw new AiError(`${cfg.model}: ${failureReason(e)}. Try again in a minute, or switch the model to Automatic in Settings.`, e.status === 429 ? 'limit' : 'busy');
      }
      if (errorKind(e) === 'key') throw new AiError(`${provider.name} rejected the key (${e.message}). Check it in Settings.`, 'key');
      throw e;
    }
  }
  let models = cfg.models;
  if (!models?.length) models = await loadModels(settings);
  const status = cfg.modelStatus ?? {};
  const ranked = rankModels(provider, models).filter((m) => status[m] !== 'retired');
  if (!ranked.length) throw new AiError('No usable models found for this key. Check it in Settings.', 'key');
  const order = ranked.includes(cfg.autoModel) ? [cfg.autoModel, ...ranked.filter((m) => m !== cfg.autoModel)] : ranked;
  const tried = [];
  let limited = 0;
  for (const model of order.slice(0, maxTries)) {
    onAttempt?.(model);
    try {
      const text = await provider.complete({ ...cfg, model }, req);
      if (model !== cfg.autoModel) await updateProviderCfg(provider.id, { autoModel: model });
      await markModel(provider.id, model, 'ok');
      return { text, model };
    } catch (e) {
      if (!shouldTryNextModel(e)) {
        if (errorKind(e) === 'key') throw new AiError(`${provider.name} rejected the key (${e.message}). Check it in Settings.`, 'key');
        throw e;
      }
      if (e.status === 429 || e.status === 402) limited++;
      await markModel(provider.id, model, isRetired(e) ? 'retired' : 'fail');
      tried.push(`${model} ${failureReason(e)}`);
    }
  }
  const kind = limited && limited === tried.length ? 'limit' : 'busy';
  throw new AiError(
    kind === 'limit' ? `The free limit of your ${provider.name} key is used up for now (${tried.join(', ')}).` : `No model answered (${tried.join(', ')}). Try again in a minute.`,
    kind
  );
}

// ---- prompts ----

const KINDS = 'word | idiom | phrasal verb | fixed phrase | collocation';

const DIFFICULTY = [
  'Difficulty scale for a learner (be honest: in normal speech most words are 1 or 2):',
  '1 = basic everyday word every learner knows (do not list these)',
  '2 = common, known after a year or two of study',
  '3 = intermediate',
  '4 = upper-intermediate; less common, informal or idiomatic',
  '5 = advanced; rare, literary, slang, cultural references',
  '6 = very rare or specialist'
].join('\n');

const QUOTES = 'Inside JSON string values never use the " character; use « » or \' instead.';

const ITEM_SHAPE =
  '{"text": exact words as they appear in the sentence, "lemma": dictionary form of the whole expression (e.g. "blew it" -> "blow it"), ' +
  `"kind": one of ${KINDS}, "level": difficulty 1-6, ` +
  '"translation": general dictionary translation of the lemma, without names or details from this sentence (e.g. "помститися комусь за щось", not "помститися Трампу"), ' +
  '"note": memory note, "inTranslation": the exact words of the sentence translation that translate it, ' +
  '"parts": for multi-word items only, each meaningful word with its own translation: [{"text": word, "translation": string}]}';

export function buildExplainPrompt({ term, sentence, previous }) {
  return [
    previous ? `Previous line: "${previous}"` : '',
    `Sentence: "${sentence}"`,
    `Explain: "${term}"`,
    '',
    'If the term is part of a larger idiom or phrasal verb in this sentence, explain the whole expression and put it in "text".',
    DIFFICULTY,
    QUOTES,
    `Return: {"item": ${ITEM_SHAPE}, "sentenceTranslation": translation of the sentence}`
  ].filter(Boolean).join('\n');
}

export function normalizeItem(raw, sentence) {
  if (!raw || !raw.text) return null;
  const text = String(raw.text).trim();
  if (sentence && !sentence.toLowerCase().includes(text.toLowerCase())) return null;
  const level = Math.min(6, Math.max(1, Math.round(Number(raw.level) || 3)));
  const parts = Array.isArray(raw.parts) ? raw.parts.filter((p) => p && p.text && p.translation).map((p) => ({ text: String(p.text), translation: String(p.translation) })) : [];
  return {
    text,
    lemma: String(raw.lemma || text),
    kind: String(raw.kind || (text.includes(' ') ? 'fixed phrase' : 'word')).toLowerCase(),
    level,
    translation: String(raw.translation || ''),
    note: String(raw.note || ''),
    inTranslation: String(raw.inTranslation || ''),
    parts: text.includes(' ') ? parts : []
  };
}

export async function explainTerm(settings, { term, sentence, previous }) {
  const req = { system: system(settings), prompt: buildExplainPrompt({ term, sentence, previous }), json: true, timeoutMs: TIMEOUT.explain };
  let out;
  try {
    out = parseJsonStrict((await run(settings, req)).text);
  } catch (e) {
    if (!(e instanceof BadAnswerError)) throw e;
    out = parseJsonStrict((await run(settings, req)).text); // one more try
  }
  const item = normalizeItem(out.item ?? out, null) ?? normalizeItem({ text: term }, null);
  return { item, sentenceTranslation: String(out.sentenceTranslation || '') };
}

export function buildAnalyzePrompt(sentences) {
  return [
    'These are consecutive subtitle lines from one video. For each line: translate it, and list every word or expression of difficulty 2 or higher.',
    'List a whole idiom, phrasal verb or fixed phrase as one item (not its words separately). Skip names of people and places.',
    DIFFICULTY,
    QUOTES,
    '',
    'Lines:',
    ...sentences.map((s) => `${s.id}: ${s.text}`),
    '',
    `Return: {"sentences": [{"id": number, "translation": string, "items": [${ITEM_SHAPE}]}]}`
  ].join('\n');
}

// Analyses a batch of sentences. Returns { results, model }; lines the AI
// left out come back as { id, missing: true }. Throws BadAnswerError for
// garbled JSON so the caller can retry or split the batch.
export async function analyzeSentences(settings, sentences, { signal } = {}) {
  const { text, model } = await run(settings, {
    system: system(settings),
    prompt: buildAnalyzePrompt(sentences),
    json: true,
    timeoutMs: TIMEOUT.analyze,
    signal
  }, { maxTries: 3 });
  const out = parseJsonStrict(text);
  const byId = new Map((out.sentences ?? []).map((s) => [Number(s.id), s]));
  const results = sentences.map((s) => {
    const r = byId.get(s.id);
    if (!r) return { id: s.id, missing: true };
    return {
      id: s.id,
      translation: String(r.translation ?? ''),
      items: (r.items ?? r.hard ?? []).map((h) => normalizeItem(h, s.text)).filter(Boolean)
    };
  });
  return { results, model };
}

// Returns { message, model } or throws. onAttempt(model) reports progress.
export async function testProvider(settings, onAttempt) {
  // Always the provider in `settings`, never the backup, so the result is honest.
  const { text, model } = await runOne(
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
  return { message: `Works with ${model}: "break the ice" = ${(r.item ?? r).translation}`, model };
}
