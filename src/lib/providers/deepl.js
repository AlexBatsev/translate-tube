import { requestJson, ProviderError } from './http.js';

// DeepL only translates text. It cannot explain words or pick the hard ones,
// so the Prepare tab and memory notes need one of the AI providers.
function base(cfg) {
  return cfg.apiKey.trim().endsWith(':fx') ? 'https://api-free.deepl.com/v2' : 'https://api.deepl.com/v2';
}

const TARGET_FIX = { en: 'EN-US', pt: 'PT-PT', zh: 'ZH-HANS', nb: 'NB' };

export default {
  id: 'deepl',
  name: 'DeepL (translation only)',
  blurb: 'Plain translations, no memory notes or hard-word detection. Free API key at deepl.com/pro-api.',
  keyUrl: 'https://www.deepl.com/your-account/keys',
  fields: ['apiKey'],
  canExplain: false,
  preferredModels: [],
  defaultModel: '',

  async listModels(cfg) {
    await requestJson(`${base(cfg)}/usage`, { headers: { authorization: `DeepL-Auth-Key ${cfg.apiKey}` } });
    return [];
  },

  async translate(cfg, texts, { from, to, context }) {
    const data = await requestJson(`${base(cfg)}/translate`, {
      method: 'POST',
      headers: { authorization: `DeepL-Auth-Key ${cfg.apiKey}` },
      body: {
        text: texts,
        source_lang: from.toUpperCase(),
        target_lang: TARGET_FIX[to] ?? to.toUpperCase(),
        ...(context ? { context } : {})
      }
    });
    if (!data.translations) throw new ProviderError('DeepL returned no translation.');
    return data.translations.map((t) => t.text);
  },

  async complete() {
    throw new ProviderError('DeepL cannot answer free-form prompts. Choose an AI provider for this feature.');
  }
};
