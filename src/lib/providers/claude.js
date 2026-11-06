import { requestJson, ProviderError } from './http.js';

const BASE = 'https://api.anthropic.com/v1';

function headers(cfg) {
  return {
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
    // Required for calls made from a browser extension.
    'anthropic-dangerous-direct-browser-access': 'true'
  };
}

export default {
  id: 'claude',
  name: 'Anthropic Claude',
  blurb: 'Paid API.',
  keyUrl: 'https://console.anthropic.com/settings/keys',
  fields: ['apiKey'],
  autoModels: [/haiku/, /sonnet/],

  async listModels(cfg) {
    const data = await requestJson(`${BASE}/models?limit=1000`, { headers: headers(cfg), timeoutMs: 20000 });
    return (data.data ?? []).map((m) => m.id);
  },

  async complete(cfg, { system, prompt, timeoutMs, signal }) {
    const data = await requestJson(`${BASE}/messages`, {
      method: 'POST',
      timeoutMs,
      signal,
      headers: headers(cfg),
      body: {
        model: cfg.model,
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: prompt }]
      }
    });
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text) throw new ProviderError('Claude returned no text.');
    return text;
  }
};
