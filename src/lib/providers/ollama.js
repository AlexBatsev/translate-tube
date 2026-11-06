import { requestJson, ProviderError } from './http.js';

// Local models via Ollama (ollama.com). Ollama must allow requests from the
// extension: set OLLAMA_ORIGINS=chrome-extension://* before starting it.
function host(cfg) {
  return (cfg.host || 'http://localhost:11434').replace(/\/+$/, '');
}

export default {
  id: 'ollama',
  name: 'Ollama (local, free)',
  blurb: 'Free. Runs a model on your own computer.',
  keyUrl: 'https://ollama.com/download',
  fields: ['host'],
  autoModels: [/llama/, /qwen/, /gemma/, /mistral/],

  async listModels(cfg) {
    const data = await requestJson(`${host(cfg)}/api/tags`, { timeoutMs: 10000 });
    return (data.models ?? []).map((m) => m.name).filter((n) => !/(embed|bge|minilm)/i.test(n));
  },

  async complete(cfg, { system, prompt, json, timeoutMs, signal }) {
    const data = await requestJson(`${host(cfg)}/api/chat`, {
      method: 'POST',
      // Local models can be slow to load the first time.
      timeoutMs: Math.max(timeoutMs ?? 0, 120000),
      signal,
      body: {
        model: cfg.model,
        stream: false,
        ...(json ? { format: 'json' } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      }
    });
    const text = data.message?.content;
    if (!text) throw new ProviderError('Ollama returned no text.');
    return text;
  }
};
