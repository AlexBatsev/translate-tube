import { getSettings, saveSettings, addWords, LEVELS } from '../lib/storage.js';
import { LANGUAGES } from '../lib/languages.js';
import { PROVIDERS, getProvider, pickModel } from '../lib/providers/index.js';
import { testProvider } from '../lib/ai.js';
import { SELF_CHECK, levelFromCheck, parseWordList } from '../lib/level.js';

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
    sel.addEventListener('change', () => {
      save({ [id]: sel.value });
      renderSelfCheck();
    });
  }
}

// ---------- providers ----------

function renderProviders() {
  $('providers').innerHTML = PROVIDERS.map(
    (p) => `<label class="option"><input type="radio" name="provider" value="${p.id}" ${p.id === settings.provider ? 'checked' : ''}>
      <div><b>${p.name}${p.id === 'gemini' ? ' · recommended' : ''}</b><span>${p.blurb}</span></div></label>`
  ).join('');
  $('providers').addEventListener('change', async (e) => {
    await save({ provider: e.target.value });
    renderProviderConfig();
  });
  renderProviderConfig();
}

function providerCfg() {
  return settings.providers[settings.provider] ?? {};
}

function renderProviderConfig() {
  const p = getProvider(settings.provider);
  const cfg = providerCfg();
  $('field-apiKey').hidden = !p.fields.includes('apiKey');
  $('field-host').hidden = !p.fields.includes('host');
  $('field-model').hidden = p.id === 'deepl';
  $('key-link').href = p.keyUrl;
  $('key-link').textContent = p.id === 'ollama' ? 'Download Ollama' : 'Get a key';
  $('apiKey').value = cfg.apiKey ?? '';
  $('host').value = cfg.host ?? '';
  const model = cfg.model || p.defaultModel;
  $('model').innerHTML = model ? `<option>${model}</option>` : '<option value="">Press Test to load models</option>';
  status($('provider-status'), '');
  setProviderOk(false);
}

function setProviderOk(ok) {
  providerOk = ok;
  if (wizard) updateNav();
}

async function saveProviderField(field, value) {
  await save({ providers: { [settings.provider]: { ...providerCfg(), [field]: value } } });
}

$('apiKey').addEventListener('change', () => saveProviderField('apiKey', $('apiKey').value.trim()));
$('host').addEventListener('change', () => saveProviderField('host', $('host').value.trim()));
for (const id of ['apiKey', 'host']) $(id).addEventListener('input', () => setProviderOk(false));
$('model').addEventListener('change', () => saveProviderField('model', $('model').value));

$('test-provider').addEventListener('click', async () => {
  const p = getProvider(settings.provider);
  await saveProviderField('apiKey', $('apiKey').value.trim());
  if (p.fields.includes('host')) await saveProviderField('host', $('host').value.trim());
  const el = $('provider-status');
  status(el, 'Checking…');
  setProviderOk(false);
  try {
    const models = await p.listModels(providerCfg());
    if (models.length) {
      const chosen = pickModel(p, models, providerCfg().model);
      $('model').innerHTML = models.map((m) => `<option ${m === chosen ? 'selected' : ''}>${m}</option>`).join('');
      await saveProviderField('model', chosen);
    } else if (p.id === 'ollama') {
      throw new Error('Ollama has no models yet. Run "ollama pull llama3.2" first.');
    }
    status(el, await testProvider(settings), 'ok');
    setProviderOk(true);
  } catch (e) {
    let msg = e.message;
    if (p.id === 'ollama' && /403|reach/.test(msg)) msg += ' Start Ollama with OLLAMA_ORIGINS=chrome-extension://* set.';
    status(el, msg, 'err');
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

async function updateKnownCount() {
  const { knownWords = [] } = await chrome.storage.local.get('knownWords');
  $('known-count').textContent = `${knownWords.length} known words saved`;
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

function fillAnki() {
  $('deck').value = settings.anki.deck;
  $('ankiUrl').value = settings.anki.url;
  $('ankiKey').value = settings.anki.key;
  const saveAnki = () =>
    save({ anki: { deck: $('deck').value.trim() || 'Translate Tube', url: $('ankiUrl').value.trim() || 'http://127.0.0.1:8765', key: $('ankiKey').value } });
  for (const id of ['deck', 'ankiUrl', 'ankiKey']) $(id).addEventListener('change', saveAnki);
  $('anki-connect').addEventListener('click', async () => {
    await saveAnki();
    status($('anki-status'), 'Look at Anki: it may ask to allow Translate Tube…');
    const r = await chrome.runtime.sendMessage({ type: 'bg:ankiCheck', anki: settings.anki });
    if (r?.ok) {
      status($('anki-status'), `Connected (AnkiConnect v${r.result}). Deck “${settings.anki.deck}” is ready.`, 'ok');
      chrome.runtime.sendMessage({ type: 'bg:flush' });
    } else {
      status($('anki-status'), r?.error ?? 'Could not reach Anki.', 'err');
    }
  });
}

// ---------- wizard ----------

function showStep(n) {
  step = n;
  document.querySelectorAll('section[data-step]').forEach((s) => (s.hidden = Number(s.dataset.step) !== n));
  document.querySelectorAll('#steps li').forEach((li) => li.classList.toggle('on', Number(li.dataset.step) === n));
  $('back').hidden = n === 0;
  $('next').textContent = n === 3 ? 'Finish' : 'Next';
  updateNav();
  window.scrollTo(0, 0);
}

function updateNav() {
  const locked = step === 1 && !providerOk;
  $('next').disabled = locked;
  $('next').title = locked ? 'Paste your key and press Test first' : '';
  $('skip').hidden = !locked;
  $('saved').textContent = locked ? 'Press Test to continue' : '';
}

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
  $('pauseOnClick').checked = settings.pauseOnClick;
  $('pauseOnClick').addEventListener('change', () => save({ pauseOnClick: $('pauseOnClick').checked }));
  if (wizard) setupWizard();
  else if (!settings.setupDone) await save({ setupDone: true });
})();
