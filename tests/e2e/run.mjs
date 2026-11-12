// End-to-end check in a real Chromium: loads the extension, serves a stand-in
// YouTube page, and plays the parts of a local AI (Ollama) and of Anki.
// Run: npm run e2e   (needs Playwright with Chromium; not part of npm test)
import { chromium } from 'playwright';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LINES = 120; // 5 s each = 10 minutes
const HARD = { 3: 'reluctant', 7: 'blew it', 100: 'ubiquitous' };

// ---- stand-in video: silent WAV, so the page has a real, seekable <video> ----
function wav(seconds) {
  const rate = 8000;
  const data = Buffer.alloc(seconds * rate, 128);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const media = wav(LINES * 5);

const json3 = {
  events: Array.from({ length: LINES }, (_, i) => ({
    tStartMs: i * 5000,
    dDurationMs: 4500,
    segs: [{ utf8: HARD[i] ? `He was ${HARD[i]} about line ${i}.` : `This is plain line number ${i}.` }]
  }))
};

const watchPage = `<!doctype html><title>Sample talk - YouTube</title>
<div id="movie_player"><video src="http://127.0.0.1:8099/media.wav" muted></video></div>
<h1 class="ytd-watch-metadata">Sample talk</h1>
<script>
  document.getElementById('movie_player').getPlayerResponse = () => ({
    videoDetails: { videoId: 'abc12345678', title: 'Sample talk' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: '/api/timedtext?v=abc12345678&lang=en', languageCode: 'en', name: { simpleText: 'English' } }] } }
  });
</script>`;

// ---- stand-ins for Ollama and Anki ----
const seen = { ai: [], origins: [], anki: [], notes: [] };

function listen(port, handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

const json = (res, obj, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
};

function ollama(req, res, body) {
  seen.origins.push(req.headers.origin ?? '');
  // Like the real Ollama: other origins are refused.
  if (req.headers.origin) return json(res, { error: 'forbidden' }, 403);
  if (req.url === '/api/tags') return json(res, { models: [{ name: 'llama3.2' }] });
  const prompt = JSON.parse(body).messages[1].content;
  let out;
  if (prompt.includes('Lines:')) {
    const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
    seen.ai.push({ kind: 'analyze', ids });
    assert.ok(!prompt.includes('"note"'), 'analysis must not ask for memory notes');
    out = {
      sentences: ids.map((id) => ({
        id,
        translation: `переклад ${id}`,
        items: HARD[id] ? [{ text: HARD[id], lemma: HARD[id] === 'blew it' ? 'blow it' : HARD[id], kind: 'word', level: 4, translation: 'слово', inTranslation: 'переклад' }] : []
      }))
    };
  } else if (prompt.includes('Expression:')) {
    seen.ai.push({ kind: 'note' });
    out = { note: 'memory hook' };
  } else {
    seen.ai.push({ kind: 'explain' });
    out = { item: { text: 'plain', lemma: 'plain', kind: 'word', level: 2, translation: 'простий', note: 'n' }, sentenceTranslation: 'x' };
  }
  json(res, { message: { content: JSON.stringify(out) } });
}

const ankiNotes = [{ fields: { Word: { value: 'ubiquitous', order: 0 } } }];
function anki(req, res, body) {
  if (req.method !== 'POST') return json(res, {});
  const { action, params } = JSON.parse(body);
  seen.anki.push(action);
  const result = {
    requestPermission: { permission: 'granted' },
    version: 6,
    modelNames: ['Translate Tube'],
    modelTemplates: { 'Word → Meaning': { Front: 'old', Back: 'old' } },
    deckNames: ['Translate Tube'],
    findNotes: [1],
    notesInfo: ankiNotes
  }[action];
  if (action === 'updateModelTemplates') seen.front = Object.values(params.model.templates)[0].Front;
  if (action === 'addNote') seen.notes.push(params.note.fields);
  json(res, { result: result ?? null, error: null });
}

function mediaServer(req, res) {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : media.length - 1;
  res.writeHead(m ? 206 : 200, {
    'content-type': 'audio/wav',
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
    'access-control-allow-origin': '*',
    ...(m ? { 'content-range': `bytes ${start}-${end}/${media.length}` } : {})
  });
  res.end(media.subarray(start, end + 1));
}

const servers = [await listen(11434, ollama), await listen(8765, anki), await listen(8099, mediaServer)];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-e2e-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--autoplay-policy=no-user-gesture-required']
});
const step = (name) => console.log(`ok - ${name}`);
const until = async (fn, what, ms = 8000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

try {
  await ctx.route('https://www.youtube.com/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/timedtext') return route.fulfill({ json: json3 });
    return route.fulfill({ contentType: 'text/html', body: watchPage });
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const base = `chrome-extension://${new URL(sw.url()).host}`;

  // Skip the wizard: a finished setup with Ollama and a connected Anki.
  await sw.evaluate(() =>
    chrome.storage.local.set({
      settings: {
        setupDone: true, learningLang: 'en', nativeLang: 'uk', provider: 'ollama', level: 3,
        providers: { ollama: { host: 'http://127.0.0.1:11434', model: '' } },
        anki: { enabled: true, connected: true, url: 'http://127.0.0.1:8765', deck: 'Translate Tube', key: '' }
      }
    })
  );

  const yt = await ctx.newPage();
  await yt.goto('https://www.youtube.com/watch?v=abc12345678');
  // The address of a YouTube tab is readable without the "tabs" permission.
  const tab = await until(async () => (await sw.evaluate(() => chrome.tabs.query({ url: 'https://www.youtube.com/*' })))[0], 'YouTube tab');
  assert.match(tab.url, /watch\?v=abc/);
  step('the YouTube tab is found without the tabs permission');

  const panel = await ctx.newPage();
  panel.on('pageerror', (e) => console.log('panel error:', e.message));
  await panel.goto(`${base}/src/sidepanel/sidepanel.html?tabId=${tab.id}`);
  await until(() => panel.locator('.line').count().then((n) => n === LINES), 'transcript lines');
  step('transcript loads');

  await until(() => panel.locator('.line[data-id="3"] .hl').count(), 'hard word highlighted');
  await until(async () => !(await panel.locator('#analysis-state .spinner').count()), 'analysis idle');
  const analysed = seen.ai.filter((x) => x.kind === 'analyze').flatMap((x) => x.ids);
  assert.ok(Math.max(...analysed) < 70, `only the window is analysed, got up to line ${Math.max(...analysed)}`);
  assert.ok(seen.origins.length && seen.origins.every((o) => !o), 'requests to the local AI carry no Origin header');
  step(`only the first minutes are analysed (${analysed.length} of ${LINES} lines); the local AI needs no settings`);

  // A word already in Anki (made elsewhere) is marked, not offered as new.
  await until(async () => ((await sw.evaluate(() => chrome.storage.local.get('deckWords'))).deckWords ?? []).includes('ubiquitous'), 'words read from Anki');
  step('words already in Anki are known to the extension');

  // Open a hard word: translation at once, the memory note a moment later.
  await panel.locator('.line[data-id="3"] .hl').click();
  await until(() => panel.locator('#popover .translation').count(), 'popover');
  await until(() => panel.locator('#popover .note').count(), 'memory note');
  assert.equal(seen.ai.filter((x) => x.kind === 'note').length, 1);
  await panel.keyboard.press('a');
  await until(() => panel.locator('#cards-count').textContent().then((t) => t === '1'), 'draft added');
  step('a word opens with its translation, gets its note on demand, and A adds it');

  // Level control in the header.
  assert.equal(await panel.locator('#lvl-label').textContent(), 'Level 3');
  await panel.locator('#lvl-up').click();
  await until(() => panel.locator('#lvl-label').textContent().then((t) => t === 'Level 4'), 'level 4');
  await until(async () => !(await panel.locator('.line[data-id="7"] .hl').count()), 'fewer words at level 4');
  await panel.keyboard.press('-');
  await until(() => panel.locator('.line[data-id="7"] .hl').count(), 'words back at level 3');
  step('the level control in the header changes the highlights');
  if (process.env.TT_SHOTS) {
    await panel.setViewportSize({ width: 400, height: 760 });
    await panel.locator('#legend-btn').click();
    await panel.screenshot({ path: path.join(process.env.TT_SHOTS, 'panel.png') });
    await panel.locator('#legend-btn').click();
  }

  // Keys on the Transcript tab.
  await panel.locator('#transcript').focus();
  await panel.keyboard.press('ArrowRight');
  await until(() => yt.evaluate(() => document.querySelector('video').currentTime).then((t) => Math.abs(t - 5) < 0.6), 'next line');
  step('→ moves the video to the next line');

  // Prepare asks only for what comes next; seeking far away moves the window.
  await yt.evaluate(() => (document.querySelector('video').currentTime = 520));
  await until(() => panel.locator('.line[data-id="100"] .item.deck').count(), 'line 100 analysed and marked as in the cards', 12000);
  assert.equal(await panel.locator('.line[data-id="100"] .hl').count(), 0);
  step('after seeking, the lines there are analysed; the Anki word is marked, not highlighted');

  await yt.evaluate(() => (document.querySelector('video').currentTime = 0));
  await until(() => panel.locator('.line.active[data-id="0"]').count(), 'panel follows the video back to the start');
  await panel.locator('[data-tab="prepare"]').click();
  await panel.locator('#prep-begin').click();
  await until(() => panel.locator('#prep-sentence .hard').count(), 'prepare shows a hard sentence');
  assert.match(await panel.locator('#prep-sentence').textContent(), /reluctant|blew it/);
  await panel.keyboard.press('s');
  await until(() => panel.locator('#prep-sentence').textContent().then((t) => /blew it/.test(t)), 'next hard sentence after S');
  step('Prepare walks the hard sentences');

  // Send the card: Anki gets it, with the spoken word on the updated card.
  await panel.locator('[data-tab="cards"]').click();
  await panel.locator('#send-cards').click();
  await until(() => seen.notes.length === 1, 'card sent to Anki');
  assert.equal(seen.notes[0].Word, 'reluctant');
  assert.match(seen.notes[0].Note, /memory hook/);
  assert.match(seen.front ?? '', /\{\{tts en_US:Word\}\}/);
  step('the card reaches Anki with its note; the card layout in Anki is updated');

  // Settings page opens and shows the version.
  const options = await ctx.newPage();
  options.on('pageerror', (e) => console.log('settings error:', e.message));
  await options.goto(`${base}/src/options/options.html`);
  await until(() => options.locator('#version').textContent().then((t) => /Translate Tube \d/.test(t)), 'version shown');
  await options.locator('#test-provider').click();
  await until(() => options.locator('#provider-status.ok').count(), 'provider test passes', 15000);
  step('Settings shows the version and the AI test passes');
  console.log('\nall checks passed');
} finally {
  await ctx.close();
  for (const s of servers) s.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
