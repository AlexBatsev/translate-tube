import { requestJson, ProviderError } from './http.js';

// Local models via Ollama (ollama.com). Ollama must allow requests from the
// extension: set OLLAMA_ORIGINS=chrome-extension://* before starting it.
function host(cfg) {
  return (cfg.host || 'http://localhost:11434').replace(/\/+$/, '');
}

export default {
  id: 'ollama',
  name: 'Ollama (local, free)',
  blurb: 'Runs a model on your own computer. Needs OLLAMA_ORIGINS=chrome-extension://* set.',
  keyUrl: 'https://ollama.com/download',
  fields: ['host'],
  canExplain: true,
  preferredModels: [/llama3/, /qwen/, /gemma/],
  defaultModel: '',

  async listModels(cfg) {
    const data = await requestJson(`${host(cfg)}/api/tags`);
    return (data.models ?? []).map((m) => m.name);
  },

  async complete(cfg, { system, prompt, json }) {
    if (!cfg.model) throw new ProviderError('Pick an Ollama model in Settings.');
    const data = await requestJson(`${host(cfg)}/api/chat`, {
      method: 'POST',
      timeoutMs: 180000,
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
