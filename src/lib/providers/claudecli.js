import { ProviderError } from './http.js';

// Claude through the user's own Claude plan: the browser starts a small
// helper on this computer (native messaging), which runs the official Claude
// Code app for each request. Set up once from Settings.
export const HOST = 'com.translatetube.claude';

// Model names Claude Code accepts; it maps each to the newest model of that kind.
const MODELS = ['haiku', 'sonnet', 'opus'];

function ask(message, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendNativeMessage) {
      reject(new ProviderError('This browser cannot start the Claude helper.'));
      return;
    }
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => finish(reject, new ProviderError('Cancelled.', 0, { cancelled: true }));
    const timer = setTimeout(() => finish(reject, new ProviderError(`No answer after ${Math.round(timeoutMs / 1000)} seconds.`, 0, { timeout: true })), timeoutMs);
    signal?.addEventListener('abort', onAbort);
    chrome.runtime.sendNativeMessage(HOST, message, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) {
        // Not registered, or registered for another copy of the extension.
        finish(reject, Object.assign(new ProviderError('Claude is not set up on this computer yet. See “Set up Claude on this computer” in Settings.'), { setup: true }));
      } else if (!reply?.ok) {
        const text = reply?.error || 'Claude did not answer.';
        finish(reject, Object.assign(new ProviderError(`Claude: ${text}`, claudeStatus(text)), { setup: reply?.code === 'no-claude' }));
      } else {
        finish(resolve, reply);
      }
    });
  });
}

// Only a real plan limit or overload counts as one, so the backup AI takes
// over and another model is tried. Any other problem is shown as it is.
export function claudeStatus(text) {
  if (/usage limit|rate[ _-]?limit|limit (reached|exceeded)|\b429\b|too many requests/i.test(text)) return 429;
  if (/overloaded|\b529\b/i.test(text)) return 503;
  return 0;
}

// Used by the setup steps. Never throws.
// Returns { ready: false, why } or { ready: true, signedIn, version }.
export async function helperStatus() {
  try {
    const r = await ask({ type: 'ping' }, 15000);
    return { ready: true, signedIn: r.signedIn !== false, version: r.version ?? '' };
  } catch (e) {
    return { ready: false, why: e.setup ? 'setup' : 'error', message: e.message };
  }
}

export default {
  id: 'claudecli',
  name: 'Claude (your Claude plan)',
  blurb: 'Uses your Claude plan through the Claude Code app. One-time setup on this computer; answers take a few seconds.',
  keyUrl: 'https://claude.com/product/claude-code',
  fields: [],
  // Haiku is fast and light on plan limits.
  autoModels: [/haiku/, /sonnet/],

  async listModels() {
    await ask({ type: 'ping' }, 15000);
    return [...MODELS];
  },

  async complete(cfg, { system, prompt, timeoutMs, signal }) {
    // Each request starts the Claude app, which takes a few seconds.
    const r = await ask({ type: 'complete', model: cfg.model, system, prompt }, Math.max(timeoutMs ?? 0, 120000), signal);
    if (!r.text) throw new ProviderError('Claude returned no text.');
    return r.text;
  }
};
