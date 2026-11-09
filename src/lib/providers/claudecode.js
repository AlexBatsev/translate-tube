import { requestJson, ProviderError } from './http.js';
import { allowBridgeRequests } from '../bridge.js';

// Claude through the user's own Claude plan: a small local program (OCP,
// github.com/dtzp555-max/ocp) runs the official Claude Code app for each
// request and answers in the OpenAI format on this computer.
export const BRIDGE_DEFAULT = 'http://127.0.0.1:3456';

export function bridgeHost(cfg) {
  return (cfg.host || BRIDGE_DEFAULT).replace(/\/+$/, '');
}

// Health check used by the setup steps. Never throws.
// Returns { running: false } or { running: true, signedIn, message }.
export async function bridgeStatus(cfg) {
  try {
    const data = await requestJson(`${bridgeHost(cfg)}/health`, { timeoutMs: 4000 });
    const auth = data.auth;
    const signedIn = auth === undefined || auth === 'ok' || auth?.ok === true;
    return { running: true, signedIn, message: typeof auth === 'object' ? auth?.message ?? '' : String(auth ?? '') };
  } catch {
    return { running: false };
  }
}

export default {
  id: 'claudecode',
  name: 'Claude (your Claude plan)',
  blurb: 'Uses your Claude Pro or Max plan instead of an API key. Needs a one-time setup on this computer.',
  keyUrl: 'https://github.com/dtzp555-max/ocp',
  fields: ['host'],
  hostLabel: 'Bridge address',
  // Haiku is fast and light on plan limits; Sonnet if Haiku is missing.
  autoModels: [/haiku/, /sonnet/],

  async listModels(cfg) {
    await allowBridgeRequests();
    const data = await requestJson(`${bridgeHost(cfg)}/v1/models`, { timeoutMs: 10000 });
    return (data.data ?? []).map((m) => m.id).filter((id) => /^claude-/.test(id));
  },

  async complete(cfg, { system, prompt, timeoutMs, signal }) {
    await allowBridgeRequests();
    const data = await requestJson(`${bridgeHost(cfg)}/v1/chat/completions`, {
      method: 'POST',
      // Each request starts the Claude app, which takes a few seconds.
      timeoutMs: Math.max(timeoutMs ?? 0, 120000),
      signal,
      // No response_format: the bridge would retry to force JSON and use
      // more of the plan; the answer is parsed leniently anyway.
      body: {
        model: cfg.model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      }
    });
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError('Claude returned no text.');
    return text;
  }
};
