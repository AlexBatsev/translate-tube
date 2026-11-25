// Checks the "Claude (your Claude plan)" provider in Chromium with a stand-in
// helper: Settings waits for the setup, notices the helper, lists the models
// and passes Test. The real helper is a PowerShell script for Windows.
// Run: node tests/e2e/claude-cli.mjs
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cli-'));
const log = path.join(profile, 'host.log');

// Stand-in helper: same message protocol as src/setup/claude-host.ps1.
const hostJs = path.join(profile, 'host.mjs');
fs.writeFileSync(
  hostJs,
  `#!/usr/bin/env node
import fs from 'node:fs';
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {});
process.stdin.once('readable', () => {});
let buf = Buffer.alloc(0);
process.stdin.on('data', () => {
  buf = Buffer.concat(chunks);
  if (buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return;
  const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ type: msg.type, model: msg.model }) + '\\n');
  let reply;
  if (msg.type === 'ping') reply = { ok: true, version: '9.9.9 (Claude Code)', signedIn: true };
  else if (msg.type === 'complete' && msg.model === 'opus') reply = { ok: false, code: 'failed', error: 'Unrecognized model setting; generate failed' };
  else if (msg.type === 'complete') {
    const item = { text: 'break the ice', lemma: 'break the ice', kind: 'idiom', level: 3, translation: 'розтопити кригу', note: 'n' };
    reply = { ok: true, text: JSON.stringify({ item, sentenceTranslation: 'x' }) };
  } else reply = { ok: false, code: 'bad-request', error: 'unknown' };
  const out = Buffer.from(JSON.stringify(reply), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(out.length, 0);
  process.stdout.write(Buffer.concat([head, out]), () => process.exit(0));
});
`
);
fs.chmodSync(hostJs, 0o755);

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const until = async (fn, what, ms = 15000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const step = (name) => console.log(`ok - ${name}`);

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const id = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ settings: { setupDone: true, provider: 'claudecli', providers: { claudecli: { model: '' } } } }));

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('settings error:', e.message));
  await page.goto(`chrome-extension://${id}/src/options/options.html`);
  await until(() => page.locator('#claude-setup:not([hidden])').count(), 'setup steps shown');
  await until(() => page.locator('#claude-live').textContent().then((t) => /not found yet/.test(t)), 'waiting for the helper');
  step('without the helper, Settings shows the setup steps and waits');

  // The setup command carries the extension id and the helper script.
  const script = await page.evaluate(async () => {
    const get = async (f) => (await fetch(chrome.runtime.getURL(`src/setup/${f}`))).text();
    return { setup: await get('claude-setup.ps1'), host: await get('claude-host.ps1') };
  });
  assert.ok(script.setup.includes('__EXTENSION_ID__') && script.setup.includes('__HOST_SCRIPT__'));
  assert.ok(!script.host.split('\n').some((l) => l.startsWith("'@")), 'helper must not end the here-string early');
  step('the setup command can carry the helper and the extension id');

  // "Run the setup": register the stand-in helper where Chromium looks for it.
  const dir = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'com.translatetube.claude.json'),
    JSON.stringify({ name: 'com.translatetube.claude', description: 'test', path: hostJs, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] })
  );
  await until(() => page.locator('#claude-live.ok').count(), 'helper noticed');
  await until(() => page.locator('#provider-status.ok').count(), 'Test runs by itself and passes', 30000);
  assert.match(await page.locator('#provider-status').textContent(), /haiku.*розтопити кригу/);
  const models = await page.locator('#model option').allTextContents();
  assert.ok(['haiku', 'sonnet', 'opus'].every((m) => models.some((o) => o.startsWith(m))), `models listed: ${models}`);
  step('the helper is noticed, Test passes with Haiku, and the model list offers Haiku, Sonnet and Opus');

  await page.selectOption('#model', 'sonnet');
  await page.locator('#test-provider').click();
  await until(() => page.locator('#provider-status.ok').textContent().then((t) => /sonnet/.test(t)).catch(() => false), 'Test with Sonnet');
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.some((c) => c.type === 'complete' && c.model === 'sonnet'));
  step('a chosen model is passed to Claude Code');

  // Any other error is shown as it is, not as a usage limit.
  await page.selectOption('#model', 'opus');
  await page.locator('#test-provider').click();
  await until(() => page.locator('#provider-status.err').count(), 'error shown');
  const err = await page.locator('#provider-status').textContent();
  assert.match(err, /Unrecognized model setting/);
  assert.doesNotMatch(err, /limit/i);
  step('a Claude Code error is shown as it is, not as a usage limit');
  console.log('\nall checks passed');
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
