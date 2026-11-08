import { requestJson, ProviderError } from './http.js';

// OpenRouter: one key for models from many companies, managed on their website.
const BASE = 'https://openrouter.ai/api/v1';

export default {
  id: 'openrouter',
  name: 'OpenRouter',
  blurb: 'One key for many models; pay per use, some models are free.',
  keyUrl: 'https://openrouter.ai/settings/keys',
  fields: ['apiKey'],
  // Fast, cheap models that follow JSON instructions well, newest first.
  autoModels: [/^google\/gemini-[\d.]+-flash$/, /^openai\/gpt-[\d.]+-mini$/, /^anthropic\/claude-haiku/, /^google\/gemini-[\d.]+-flash.*:free$/],

  async listModels(cfg) {
    const data = await requestJson(`${BASE}/models`, { headers: { authorization: `Bearer ${cfg.apiKey}` }, timeoutMs: 20000 });
    return (data.data ?? [])
      .filter((m) => {
        const out = m.architecture?.output_modalities;
        return out ? out.includes('text') && !out.includes('image') : /->text$/.test(m.architecture?.modality ?? 'text->text');
      })
      .map((m) => m.id);
  },

  async complete(cfg, { system, prompt, json, timeoutMs, signal }) {
    const data = await requestJson(`${BASE}/chat/completions`, {
      method: 'POST',
      timeoutMs,
      signal,
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'x-title': 'Translate Tube' },
      body: {
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ],
        ...(json ? { response_format: { type: 'json_object' } } : {})
      }
    });
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError('OpenRouter returned no text.');
    return text;
  }
};
