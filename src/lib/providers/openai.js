import { requestJson, ProviderError } from './http.js';

const BASE = 'https://api.openai.com/v1';
const NOT_TEXT = /(audio|realtime|transcribe|tts|image|search|embedding|moderation|dall-e|whisper|codex)/;

export default {
  id: 'openai',
  name: 'OpenAI',
  blurb: 'Paid API.',
  keyUrl: 'https://platform.openai.com/api-keys',
  fields: ['apiKey'],
  canExplain: true,
  autoModels: [/^gpt-[\d.]+-mini$/, /^gpt-[\d.]+$/],

  async listModels(cfg) {
    const data = await requestJson(`${BASE}/models`, { headers: { authorization: `Bearer ${cfg.apiKey}` }, timeoutMs: 20000 });
    return (data.data ?? []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !NOT_TEXT.test(id));
  },

  async complete(cfg, { system, prompt, json, timeoutMs }) {
    const data = await requestJson(`${BASE}/chat/completions`, {
      method: 'POST',
      timeoutMs,
      headers: { authorization: `Bearer ${cfg.apiKey}` },
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
    if (!text) throw new ProviderError('OpenAI returned no text.');
    return text;
  }
};
