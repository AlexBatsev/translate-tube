import gemini from './gemini.js';
import claude from './claude.js';
import openai from './openai.js';
import deepl from './deepl.js';
import ollama from './ollama.js';

// To add a provider: create a module with the same shape and list it here.
export const PROVIDERS = [gemini, claude, openai, deepl, ollama];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) ?? gemini;
}

export function pickModel(provider, models, current) {
  if (current && models.includes(current)) return current;
  if (provider.defaultModel && models.includes(provider.defaultModel)) return provider.defaultModel;
  for (const re of provider.preferredModels) {
    const hit = [...models].sort().reverse().find((m) => re.test(m));
    if (hit) return hit;
  }
  return models[0] ?? current ?? provider.defaultModel;
}
