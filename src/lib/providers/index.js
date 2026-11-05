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

// "gemini-3.6-flash" -> [3, 6]; "claude-haiku-4-5-20251001" -> [4, 5].
// Long numbers (dates, sizes like 70b) are ignored.
export function versionKey(name) {
  return (String(name).match(/\d+/g) ?? []).filter((n) => n.length <= 3).map(Number);
}

function compareVersionsDesc(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (kb[i] ?? -1) - (ka[i] ?? -1);
    if (d) return d;
  }
  return a.localeCompare(b);
}

const UNSTABLE = /(preview|exp|experimental|beta|latest|\d{2}-\d{2})/;

// Models to try in Automatic mode, best first: the provider's preferred
// families (newest version first), then other stable models, then the rest.
export function rankModels(provider, models) {
  const stable = models.filter((m) => !UNSTABLE.test(m));
  const groups = (provider.autoModels ?? []).map((re) => stable.filter((m) => re.test(m)).sort(compareVersionsDesc));
  const seen = new Set();
  const out = [];
  for (const m of [...groups.flat(), ...[...stable].sort(compareVersionsDesc), ...[...models].sort(compareVersionsDesc)]) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}
