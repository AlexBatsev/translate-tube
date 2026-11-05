import { requestJson, ProviderError } from './http.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export default {
  id: 'gemini',
  name: 'Google Gemini',
  blurb: 'Free tier available. Get a key at aistudio.google.com/apikey.',
  keyUrl: 'https://aistudio.google.com/apikey',
  fields: ['apiKey'],
  canExplain: true,
  preferredModels: [/gemini-[\d.]+-flash$/, /flash/],
  defaultModel: 'gemini-2.5-flash',

  async listModels(cfg) {
    const data = await requestJson(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': cfg.apiKey } });
    return (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => n.startsWith('gemini'));
  },

  async complete(cfg, { system, prompt, json }) {
    const data = await requestJson(`${BASE}/models/${encodeURIComponent(cfg.model || this.defaultModel)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': cfg.apiKey },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, ...(json ? { responseMimeType: 'application/json' } : {}) }
      }
    });
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
    if (!text) throw new ProviderError(`Gemini returned no text (${data.candidates?.[0]?.finishReason ?? 'unknown reason'}).`);
    return text;
  }
};
