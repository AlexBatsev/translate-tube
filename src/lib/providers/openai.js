import { requestJson, ProviderError } from './http.js';

const BASE = 'https://api.openai.com/v1';

export default {
  id: 'openai',
  name: 'OpenAI',
  blurb: 'Paid API. Get a key at platform.openai.com/api-keys.',
  keyUrl: 'https://platform.openai.com/api-keys',
  fields: ['apiKey'],
  canExplain: true,
  preferredModels: [/^gpt-[\d.]+-mini$/, /mini/],
  defaultModel: 'gpt-4.1-mini',

  async listModels(cfg) {
    const data = await requestJson(`${BASE}/models`, { headers: { authorization: `Bearer ${cfg.apiKey}` } });
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search)/.test(id))
      .sort();
  },

  async complete(cfg, { system, prompt, json }) {
    const data = await requestJson(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: {
        model: cfg.model || this.defaultModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ],
        ...(json ? { response_format: { type: 'json_object' } } : {})
      }
    });
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError('OpenAI returned no text.');
    return text;
  }
};
