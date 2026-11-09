import { getSettings, saveSettings, addWords, removeWords, LEVELS, BACKUP_KEYS } from '../lib/storage.js';
import { LANGUAGES } from '../lib/languages.js';
import { PROVIDERS, getProvider, rankModels } from '../lib/providers/index.js';
import { testProvider, loadModels } from '../lib/ai.js';
import { invoke } from '../lib/anki.js';
import { SELF_CHECK, levelFromCheck, parseWordList } from '../lib/level.js';
import { bridgeStatus } from '../lib/providers/claudecode.js';

const $ = (id) => document.getElementById(id);
const wizard = location.hash === '#welcome';
let settings;
let step = 0;
// The wizard's AI step only unlocks Next after a successful Test.
let providerOk = false;

function status(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

let savedTimer;
async function save(patch) {
  settings = await saveSettings(patch);
  if (!wizard) {
    $('saved').textContent = 'Saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($('saved').textContent = ''), 1500);
  }
}

// ---------- languages ----------

function fillLanguages() {
  for (const id of ['learningLang', 'nativeLang']) {
    const sel = $(id);
    sel.innerHTML = LANGUAGES.map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
    sel.value = settings[id];
    sel.addEventListener('change', async () => {
      await save({ [id]: sel.value });
      renderSelfCheck();
      checkLanguages();
    });
  }
  checkLanguages();
}

function sameLanguages() {
  return settings.learningLang === settings.nativeLang;
}

function checkLanguages() {
  $('lang-warn').hidden = !sameLanguages();
  if (wizard) updateNav();
}

// ---------- providers ----------

function renderProviders() {
  $('providers').innerHTML = PROVIDERS.map(
    (p) => `<label class="option"><input type="radio" name="provider" value="${p.id}" ${p.id === settings.provider ? 'checked' : ''}>
      <div><b>${p.name}</b><span>${p.blurb}</span></div></label>`
  ).join('');
  $('providers').addEventListener('change', async (e) => {
    await save({ provider: e.target.value });
    renderProviderConfig();
    renderBackup();
  });
  renderProviderConfig();
}

function providerCfg() {
  return settings.providers[settings.provider] ?? {};
}

function renderModels() {
  const p = getProvider(settings.provider);
  const cfg = providerCfg();
  const mark = (m) => ({ ok: ' ✓', fail: ' ✗', retired: ' ✗ retired' })[cfg.modelStatus?.[m]] ?? '';
  const auto = `Automatic (recommended)${cfg.autoModel ? ` · now ${cfg.autoModel}` : ''}`;
  const models = cfg.models?.length ? rankModels(p, cfg.models) : [];
  if (cfg.model && !models.includes(cfg.model)) models.unshift(cfg.model);
  $('model').innerHTML =
    `<option value="">${auto}</option>` +
    models.map((m) => `<option value="${m}" ${m === cfg.model ? 'selected' : ''}>${m}${mark(m)}</option>`).join('');
  $('model').value = cfg.model || '';
}

function renderProviderConfig() {
  const p = getProvider(settings.provider);
  const cfg = providerCfg();
  $('field-apiKey').hidden = !p.fields.includes('apiKey');
  $('field-host').hidden = !p.fields.includes('host');
  $('key-link').href = p.keyUrl;
  $('key-link').textContent = p.id === 'ollama' ? 'Download Ollama' : 'Get a key';
  $('host-label').textContent = p.hostLabel ?? 'Ollama address';
  $('apiKey').value = cfg.apiKey ?? '';
  $('host').value = cfg.host ?? '';
  renderModels();
  status($('provider-status'), '');
  setProviderOk(false);
  renderBridge();
}

function setProviderOk(ok) {
  providerOk = ok;
  if (wizard) updateNav();
}

async function saveProviderField(field, value) {
  await save({ providers: { [settings.provider]: { ...providerCfg(), [field]: value } } });
}

// A new key or address may see different models: forget what we learned.
async function saveConnection(field, value) {
  if ((providerCfg()[field] ?? '') === value) return;
  await save({ providers: { [settings.provider]: { ...providerCfg(), [field]: value, models: [], autoModel: '', modelStatus: {} } } });
  renderModels();
}

$('apiKey').addEventListener('change', () => saveConnection('apiKey', $('apiKey').value.trim()));
$('host').addEventListener('change', () => saveConnection('host', $('host').value.trim()));
for (const id of ['apiKey', 'host']) $(id).addEventListener('input', () => setProviderOk(false));
$('model').addEventListener('change', async () => {
  await saveProviderField('model', $('model').value);
  setProviderOk(false);
  status($('provider-status'), 'Press Test to check this model.');
});

$('test-provider').addEventListener('click', async () => {
  const p = getProvider(settings.provider);
  if (p.fields.includes('apiKey')) await saveConnection('apiKey', $('apiKey').value.trim());
  if (p.fields.includes('host')) await saveConnection('host', $('host').value.trim());
  const el = $('provider-status');
  setProviderOk(false);
  $('test-provider').disabled = true;
  let label = 'Checking';
  let started = Date.now();
  const tick = () => status(el, `${label}… ${Math.round((Date.now() - started) / 1000)}s`);
  tick();
  const timer = setInterval(tick, 1000);
  try {
    label = 'Loading models';
    const models = await loadModels(settings);
    settings = await getSettings();
    renderModels();
    if (!models.length) {
      throw new Error(p.id === 'ollama' ? 'Ollama has no models yet. Run "ollama pull llama3.2" first.' : 'This key has no text models available.');
    }
    const r = await testProvider(settings, (model) => {
      label = `Trying ${model}`;
      started = Date.now();
      tick();
    });
    settings = await getSettings();
    renderModels();
    clearInterval(timer);
    status(el, r.message, 'ok');
    setProviderOk(true);
  } catch (e) {
    clearInterval(timer);
    settings = await getSettings();
    renderModels();
    let msg = e.message;
    if (e.timeout) msg += ' The model may be overloaded. Try again, or choose another model.';
    if (p.id === 'ollama' && /403|reach/.test(msg)) msg += ' Start Ollama with OLLAMA_ORIGINS=chrome-extension://* set.';
    if (p.id === 'claudecode' && /reach/.test(msg)) msg = 'The Claude bridge is not running. Follow the steps under “Set up Claude on this computer”.';
    status(el, msg, 'err');
  } finally {
    clearInterval(timer);
    $('test-provider').disabled = false;
  }
});

// ---------- level ----------

function renderLevels() {
  $('levels').innerHTML = LEVELS.map(
    (l) => `<label class="option"><input type="radio" name="level" value="${l.value}" ${l.value === Number(settings.level) ? 'checked' : ''}>
      <div><b>${l.label}</b><span>${l.hint}</span></div></label>`
  ).join('');
  $('levels').onchange = (e) => save({ level: Number(e.target.value) });
}

const picked = new Set();
function renderSelfCheck() {
  const bands = SELF_CHECK[settings.learningLang];
  $('self-check-box').hidden = !bands;
  if (!bands) return;
  const words = bands.flat();
  // Mix the bands so the order does not give the answer away.
  const shuffled = words.map((w, i) => [w, (i * 7919) % words.length]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  $('self-check').innerHTML = shuffled.map((w) => `<button type="button" aria-pressed="${picked.has(w)}" data-w="${w}">${w}</button>`).join('');
}
$('self-check').addEventListener('click', (e) => {
  const w = e.target.dataset?.w;
  if (!w) return;
  if (picked.has(w)) picked.delete(w);
  else picked.add(w);
  e.target.setAttribute('aria-pressed', String(picked.has(w)));
});
$('self-check-done').addEventListener('click', async () => {
  const bands = SELF_CHECK[settings.learningLang];
  const level = levelFromCheck(bands, picked);
  await save({ level });
  // Words they ticked from the harder bands count as known.
  await addWords('knownWords', [...picked]);
  renderLevels();
  updateKnownCount();
  $('self-check-box').open = false;
});

// Shows the known words (newest first), filtered by the search box.
async function updateKnownCount() {
  const { knownWords = [] } = await chrome.storage.local.get('knownWords');
  $('known-count').textContent = knownWords.length ? `${knownWords.length} known words: show, find or remove` : 'No known words yet';
  const q = $('known-filter').value.trim().toLowerCase();
  const list = [...knownWords].reverse().filter((w) => !q || w.includes(q));
  const shown = list.slice(0, 300);
  $('known-list').innerHTML =
    shown.map((w) => `<li>${escapeHtml(w)}<button type="button" data-w="${escapeHtml(w)}" title="Remove: highlight it again">✕</button></li>`).join('') +
    (list.length > shown.length ? `<li class="more">and ${list.length - shown.length} more: type to find one</li>` : '');
}
$('known-filter').addEventListener('input', updateKnownCount);
$('known-list').addEventListener('click', async (e) => {
  const w = e.target.dataset?.w;
  if (!w) return;
  await removeWords('knownWords', [w]);
  updateKnownCount();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

$('known-add').addEventListener('click', async () => {
  const words = parseWordList($('known-input').value);
  if (!words.length) return;
  await addWords('knownWords', words);
  $('known-input').value = '';
  updateKnownCount();
});
$('known-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await addWords('knownWords', parseWordList(await file.text()));
  e.target.value = '';
  updateKnownCount();
});
$('known-clear').addEventListener('click', async () => {
  if (!confirm('Forget all known words?')) return;
  await chrome.storage.local.set({ knownWords: [] });
  updateKnownCount();
});

// ---------- anki ----------

let ankiTimer = null;
let ankiAsking = false;

function ankiStepsDone(n) {
  document.querySelectorAll('.anki-steps li').forEach((li) => li.classList.toggle('done', Number(li.dataset.as) <= n));
}

function renderAnkiUse() {
  const use = settings.anki.enabled;
  document.querySelectorAll('input[name=anki-use]').forEach((r) => (r.checked = (r.value === 'yes' && use === true) || (r.value === 'no' && use === false)));
  $('anki-setup').hidden = use !== true;
  clearInterval(ankiTimer);
  if (use === true) {
    if (settings.anki.connected) {
      ankiStepsDone(4);
      status($('anki-live'), '');
      status($('anki-status'), `Connected. Cards go to the deck “${settings.anki.deck}”.`, 'ok');
    }
    watchAnki();
  }
}

// Checks every few seconds whether Anki answers, and connects by itself
// once it does, so the user only follows the steps.
function watchAnki() {
  const check = async () => {
    if (ankiAsking) return;
    try {
      await invoke(settings.anki, 'version');
      if (!settings.anki.connected) {
        ankiStepsDone(3);
        connectAnki();
      }
    } catch (e) {
      if (/refused/i.test(e.message)) {
        // Anki is running but has not allowed us yet.
        ankiStepsDone(3);
        if (!settings.anki.connected) connectAnki();
        return;
      }
      ankiStepsDone(0);
      status($('anki-live'), settings.anki.connected ? 'Anki is closed right now. Cards wait in the extension until you open it.' : 'Waiting for Anki… not found yet. Do steps 1–3; this updates by itself.');
    }
  };
  check();
  ankiTimer = setInterval(check, 3000);
}

async function saveAnki(patch = {}) {
  await save({
    anki: {
      deck: $('deck').value.trim() || 'Translate Tube',
      url: $('ankiUrl').value.trim() || 'http://127.0.0.1:8765',
      key: $('ankiKey').value,
      ...patch
    }
  });
}

async function connectAnki() {
  if (ankiAsking) return;
  ankiAsking = true;
  $('anki-connect').disabled = true;
  await saveAnki();
  status($('anki-live'), 'Anki found.', 'ok');
  status($('anki-status'), 'Look at Anki: it may ask to allow Translate Tube…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'bg:ankiCheck', anki: settings.anki });
    if (r?.ok) {
      await saveAnki({ connected: true, enabled: true });
      ankiStepsDone(4);
      status($('anki-live'), '');
      status($('anki-status'), `Connected (AnkiConnect v${r.result}). Cards go to the deck “${settings.anki.deck}”.`, 'ok');
      chrome.runtime.sendMessage({ type: 'bg:flush' });
    } else {
      const msg = r?.error ?? 'Could not reach Anki.';
      status($('anki-status'), /not running/i.test(msg) ? 'Anki is not answering. Check steps 1–3 above, then try again.' : msg, 'err');
    }
  } finally {
    ankiAsking = false;
    $('anki-connect').disabled = false;
  }
}

function fillAnki() {
  $('deck').value = settings.anki.deck;
  $('ankiUrl').value = settings.anki.url;
  $('ankiKey').value = settings.anki.key;
  for (const id of ['deck', 'ankiUrl', 'ankiKey']) $(id).addEventListener('change', () => saveAnki());
  $('anki-connect').addEventListener('click', connectAnki);
  $('anki-use').addEventListener('change', async (e) => {
    await saveAnki({ enabled: e.target.value === 'yes' });
    renderAnkiUse();
  });
  $('copy-code').addEventListener('click', async () => {
    await navigator.clipboard.writeText('2055492159');
    $('copy-code').textContent = 'Copied';
    setTimeout(() => ($('copy-code').textContent = 'Copy'), 1500);
  });
  renderAnkiUse();
}

// ---------- backup AI ----------

function renderBackup() {
  const sel = $('backup-provider');
  sel.innerHTML =
    '<option value="">None</option>' +
    PROVIDERS.filter((p) => p.id !== settings.provider)
      .map((p) => `<option value="${p.id}">${p.name}</option>`)
      .join('');
  sel.value = settings.backupProvider && settings.backupProvider !== settings.provider ? settings.backupProvider : '';
  renderBridge();
  const p = sel.value ? getProvider(sel.value) : null;
  $('backup-config').hidden = !p;
  if (!p) return;
  const cfg = settings.providers[p.id] ?? {};
  $('backup-key-field').hidden = !p.fields.includes('apiKey');
  $('backup-host-field').hidden = !p.fields.includes('host');
  $('backup-host-label').textContent = p.hostLabel ?? 'Ollama address';
  $('backup-key-link').href = p.keyUrl;
  $('backup-key').value = cfg.apiKey ?? '';
  $('backup-host').value = cfg.host ?? '';
  status($('backup-status'), '');
}

async function saveBackupConnection() {
  const id = $('backup-provider').value;
  if (!id) return;
  const p = getProvider(id);
  const cfg = settings.providers[id] ?? {};
  const patch = {};
  if (p.fields.includes('apiKey')) patch.apiKey = $('backup-key').value.trim();
  if (p.fields.includes('host')) patch.host = $('backup-host').value.trim();
  if (Object.entries(patch).every(([k, v]) => (cfg[k] ?? '') === v)) return;
  await save({ providers: { [id]: { ...cfg, ...patch, models: [], autoModel: '', modelStatus: {} } } });
}

$('backup-provider').addEventListener('change', async () => {
  await save({ backupProvider: $('backup-provider').value });
  renderBackup();
});
$('backup-key').addEventListener('change', saveBackupConnection);
$('backup-host').addEventListener('change', saveBackupConnection);
$('backup-test').addEventListener('click', async () => {
  await saveBackupConnection();
  const el = $('backup-status');
  const s = { ...settings, provider: $('backup-provider').value };
  $('backup-test').disabled = true;
  status(el, 'Checking…');
  try {
    await loadModels(s);
    settings = await getSettings();
    const r = await testProvider({ ...settings, provider: s.provider }, (m) => status(el, `Trying ${m}…`));
    status(el, r.message, 'ok');
  } catch (e) {
    status(el, e.message, 'err');
  } finally {
    $('backup-test').disabled = false;
  }
});

// ---------- save and restore data ----------

$('data-save').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(BACKUP_KEYS);
  const blob = new Blob([JSON.stringify({ app: 'translate-tube', version: 1, savedAt: new Date().toISOString(), data }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `translate-tube-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('data-load').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (json.app !== 'translate-tube' || typeof json.data !== 'object') throw new Error('This is not a Translate Tube backup file.');
    const data = Object.fromEntries(Object.entries(json.data).filter(([k]) => BACKUP_KEYS.includes(k)));
    if (!confirm(`Replace your current settings, known words and cards with the backup from ${json.savedAt?.slice(0, 10) ?? 'the file'}?`)) return;
    await chrome.storage.local.set(data);
    status($('data-status'), 'Restored. Reloading…', 'ok');
    setTimeout(() => location.reload(), 800);
  } catch (err) {
    status($('data-status'), err.message.startsWith('This is') ? err.message : 'Could not read this file.', 'err');
  }
});

// ---------- Claude bridge setup ----------

let bridgeTimer = null;
let bridgeTested = false;
const isWindows = /win/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');

function bridgeWanted() {
  return settings.provider === 'claudecode' || $('backup-provider').value === 'claudecode';
}

function bridgeStepsDone(n) {
  document.querySelectorAll('#bridge-steps li').forEach((li) => li.classList.toggle('done', Number(li.dataset.bs) <= n));
}

// Shows the setup steps while Claude (your plan) is the main or backup AI
// and checks every few seconds whether the bridge answers.
function renderBridge() {
  const want = bridgeWanted();
  $('bridge-setup').hidden = !want || (wizard && step !== 1);
  $('bridge-steps').hidden = !isWindows;
  $('bridge-other-os').hidden = isWindows;
  clearInterval(bridgeTimer);
  bridgeTimer = null;
  if (!want) return;
  const check = async () => {
    const st = await bridgeStatus(settings.providers.claudecode ?? {});
    if (!st.running) {
      bridgeStepsDone(0);
      status($('bridge-live'), 'Waiting for the bridge… not found yet. Do the steps above; this updates by itself.');
      return;
    }
    if (!st.signedIn) {
      bridgeStepsDone(3);
      status($('bridge-live'), 'The bridge is running, but Claude Code is not signed in. In PowerShell run: claude auth login', 'err');
      return;
    }
    bridgeStepsDone(4);
    status($('bridge-live'), 'The Claude bridge is running.', 'ok');
    // Test once by itself, like Anki connects by itself.
    if (!bridgeTested && settings.provider === 'claudecode' && !providerOk && !$('test-provider').disabled) {
      bridgeTested = true;
      $('test-provider').click();
    }
  };
  check();
  bridgeTimer = setInterval(check, 3000);
}

async function bridgeScript() {
  return (await fetch(chrome.runtime.getURL('src/setup/claude-bridge.ps1'))).text();
}

async function copyCommand(button, remove) {
  // Wrapped in & { } so it can be pasted into PowerShell as one command.
  await navigator.clipboard.writeText(`& {\n${await bridgeScript()}\n}${remove ? ' -Remove' : ''}\n`);
  const label = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => (button.textContent = label), 1500);
}

$('bridge-copy').addEventListener('click', (e) => copyCommand(e.currentTarget, false));
$('bridge-remove').addEventListener('click', (e) => copyCommand(e.currentTarget, true));
$('bridge-show').addEventListener('click', async () => {
  const pre = $('bridge-script');
  pre.textContent = await bridgeScript();
  pre.hidden = !pre.hidden;
});

// ---------- wizard ----------

function showStep(n) {
  step = n;
  document.querySelectorAll('section[data-step]').forEach((s) => (s.hidden = Number(s.dataset.step) !== n));
  renderBridge();
  document.querySelectorAll('#steps li').forEach((li) => li.classList.toggle('on', Number(li.dataset.step) === n));
  $('back').hidden = n === 0;
  $('next').textContent = n === 3 ? 'Finish' : 'Next';
  updateNav();
  window.scrollTo(0, 0);
}

function updateNav() {
  const noTest = step === 1 && !providerOk;
  const sameLang = step === 0 && sameLanguages();
  $('next').disabled = noTest || sameLang;
  $('next').title = noTest ? 'Paste your key and press Test first' : sameLang ? 'Pick two different languages' : '';
  $('skip').hidden = !noTest;
  $('saved').textContent = noTest ? 'Press Test to continue' : '';
}

// A talk with good English subtitles, for a first try.
const SAMPLE_VIDEO = 'https://www.youtube.com/watch?v=arj7oStGLkU';

function setupWizard() {
  $('subtitle').textContent = 'Quick setup · about 2 minutes';
  $('steps').hidden = false;
  document.querySelectorAll('[data-settings-only]').forEach((s) => (s.hidden = true));
  $('next').hidden = false;
  $('back').addEventListener('click', () => showStep(step - 1));
  $('skip').addEventListener('click', () => showStep(step + 1));
  $('next').addEventListener('click', async () => {
    if (step < 3) return showStep(step + 1);
    await save({ setupDone: true });
    document.querySelector('main').innerHTML = `<header><img src="../icons/icon48.png" width="40" height="40" alt=""><div><h1>All set!</h1></div></header>
      <section class="panel"><p>Open a YouTube video and click the Translate Tube icon in the toolbar (or press <kbd>Alt</kbd>+<kbd>T</kbd>). The side panel shows the transcript next to the video.</p>
      <p>Tip: pin the extension (puzzle icon → pin) so the button is always visible.</p>
      <p><a class="button primary" href="${SAMPLE_VIDEO}" target="_blank" rel="noopener">Try it on a sample video</a></p>
      <p class="muted">You can change everything later in Settings (⚙ in the side panel).</p></section>`;
  });
  showStep(0);
}

(async function init() {
  settings = await getSettings();
  fillLanguages();
  renderProviders();
  renderLevels();
  renderSelfCheck();
  updateKnownCount();
  fillAnki();
  renderBackup();
  $('batchSize').value = String(settings.batchSize);
  $('batchSize').addEventListener('change', () => save({ batchSize: Number($('batchSize').value) }));
  for (const id of ['pauseOnClick', 'resumeOnClose']) {
    $(id).checked = settings[id];
    $(id).addEventListener('change', () => save({ [id]: $(id).checked }));
  }
  if (wizard) setupWizard();
  else $('setup-banner').hidden = settings.setupDone;
  $('setup-link').addEventListener('click', () => setTimeout(() => location.reload(), 0));
})();
