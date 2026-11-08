import { requestJson, ProviderError } from './http.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const NOT_TEXT = /(tts|image|embedding|audio|live|veo|imagen|aqa|robotics|computer-use|learnlm)/;

function thinkingConfig(model) {
  const m = /gemini-(\d+)(?:\.(\d+))?/.exec(model);
  if (!m) return null;
  // Keep thinking short: lookups should answer in about a second.
  return Number(m[1]) >= 3 ? { thinkingLevel: 'low' } : { thinkingBudget: 0 };
}

export default {
  id: 'gemini',
  name: 'Google Gemini',
  blurb: 'Free tier available. Recommended.',
  keyUrl: 'https://aistudio.google.com/apikey',
  fields: ['apiKey'],
  // Automatic mode prefers these (newest first), then any other text model.
  autoModels: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash-lite$/],

  async listModels(cfg) {
    const data = await requestJson(`${BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': cfg.apiKey }, timeoutMs: 20000 });
    return (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => n.startsWith('gemini') && !NOT_TEXT.test(n));
  },

  async complete(cfg, { system, prompt, json, timeoutMs, signal }) {
    const call = (thinking) =>
      requestJson(`${BASE}/models/${encodeURIComponent(cfg.model)}:generateContent`, {
        method: 'POST',
        timeoutMs,
        signal,
        headers: { 'x-goog-api-key': cfg.apiKey },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            ...(json ? { responseMimeType: 'application/json' } : {}),
            ...(thinking ? { thinkingConfig: thinking } : {})
          }
        }
      });
    let data;
    try {
      data = await call(thinkingConfig(cfg.model));
    } catch (e) {
      // Some models reject thinking settings; ask again without them.
      if (e.status === 400 && /think/i.test(e.message)) data = await call(null);
      else throw e;
    }
    const text = data.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    if (!text) throw new ProviderError(`Gemini returned no text (${data.candidates?.[0]?.finishReason ?? 'unknown reason'}).`);
    return text;
  }
};
