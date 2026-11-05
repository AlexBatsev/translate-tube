import { requestJson, ProviderError } from './http.js';

// Uses the Claude API with your own API key (console.anthropic.com).
// A Claude.ai chat subscription cannot be used here.
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
  name: 'Anthropic Claude (API key)',
  blurb: 'Paid API. Get a key at console.anthropic.com. A Claude.ai subscription does not work here.',
  keyUrl: 'https://console.anthropic.com/settings/keys',
  fields: ['apiKey'],
  canExplain: true,
  preferredModels: [/haiku/, /sonnet/],
  defaultModel: 'claude-haiku-4-5',

  async listModels(cfg) {
    const data = await requestJson(`${BASE}/models?limit=100`, { headers: headers(cfg) });
    return (data.data ?? []).map((m) => m.id);
  },

  async complete(cfg, { system, prompt }) {
    const data = await requestJson(`${BASE}/messages`, {
      method: 'POST',
      headers: headers(cfg),
      body: {
        model: cfg.model || this.defaultModel,
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
