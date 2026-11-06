// Cards tab: review list (edit, tick words, delete), then send to Anki.
import { $, state, on, toast, bg, escapeHtml } from './core.js';
import { getDrafts, updateDraft, removeDrafts, restoreDrafts, draftToCards, groupByVideo } from '../lib/drafts.js';
import { explainTerm } from '../lib/ai.js';
import { cardsToTsv, videoLink, buildCard } from '../lib/card.js';

function draftHtml(d) {
  const parts = d.parts?.length
    ? `<div class="d-parts">
        <label><input type="checkbox" class="d-whole" ${d.includeWhole ? 'checked' : ''}> whole phrase</label>
        ${d.parts.map((p, i) => `<label><input type="checkbox" class="d-part" data-p="${i}" ${p.checked ? 'checked' : ''}> <b>${escapeHtml(p.text)}</b> — ${escapeHtml(p.translation)}</label>`).join('')}
      </div>`
    : '';
  return `<div class="draft" data-id="${d.id}">
    <div class="draft-head">
      <input type="text" class="d-lemma" value="${escapeHtml(d.lemma)}" title="Edit the word; the translation updates">
      ${d.kind && d.kind !== 'word' ? `<span class="kind">${escapeHtml(d.kind)}</span>` : ''}
      <button class="icon d-del" title="Remove">✕</button>
    </div>
    <input type="text" class="d-tr" value="${escapeHtml(d.translation)}">
    <div class="d-status"></div>
    ${parts}
    <details><summary>Note and sentence</summary>
      <textarea class="d-note" rows="2">${escapeHtml(d.note)}</textarea>
      <div class="d-sent">${escapeHtml(d.sentence)}</div>
    </details>
  </div>`;
}

export async function renderCards() {
  const drafts = await getDrafts();
  const { ankiQueue = [], ankiSent = [] } = await chrome.storage.local.get(['ankiQueue', 'ankiSent']);
  const groups = groupByVideo(drafts);
  // Current video first.
  groups.sort((a, b) => (b.videoId === state.videoId) - (a.videoId === state.videoId));
  $('review-title').textContent = drafts.length ? `To review (${drafts.length})` : 'To review';
  $('review-hint').textContent = drafts.length
    ? 'Fix anything you like, tick single words of a phrase, then send.'
    : 'Words you add with A in Transcript or Prepare appear here for a final check before they go to Anki.';
  $('drafts').innerHTML = groups
    .map(
      (g) => `<div class="group-title"><a href="${videoLink(g.videoId, 0)}" target="_blank" rel="noopener">${escapeHtml(g.title || 'Video')}</a></div>${g.drafts.map(draftHtml).join('')}`
    )
    .join('');
  const total = drafts.reduce((n, d) => n + draftToCards(d).length, 0);
  $('send-bar').hidden = !drafts.length;
  $('send-cards').textContent = `Send ${total} card${total === 1 ? '' : 's'} to Anki`;
  $('send-cards').disabled = !total;
  renderAnkiNotice();
  $('waiting-box').hidden = !ankiQueue.length;
  $('cards-queue').innerHTML = ankiQueue
    .map(
      (c) => `<li data-q="${c.id}"><button class="icon q-del" title="Remove (it will not be sent)">✕</button><b>${c.fields.Word}</b> <span class="muted">— ${c.fields.Translation}</span>${c.lastError ? `<div class="err small">${escapeHtml(c.lastError)}</div>` : ''}</li>`
    )
    .join('');
  $('sent-count').textContent = ankiSent.length ? `(${ankiSent.length})` : '';
  $('cards-sent').innerHTML =
    ankiSent
      .slice(-100)
      .reverse()
      .map((c) => `<li><b>${c.fields.Word}</b> <span class="muted">— ${c.fields.Translation}</span>${c.duplicate ? ' <span class="dup">(already in Anki, skipped)</span>' : ''}</li>`)
      .join('') || '<li class="muted">Nothing sent yet.</li>';
  updateCount(drafts.length);
}

// Tells the user when sending cannot reach Anki because it was never set up.
function renderAnkiNotice() {
  const anki = state.settings.anki;
  const el = $('anki-off');
  if (anki.enabled === false) {
    el.innerHTML = 'Anki is turned off. <button class="link" data-action="open-settings">Set up Anki</button> or use <b>⋯ → Export cards to review</b>.';
  } else if (!anki.connected) {
    el.innerHTML = 'Anki is not connected yet. <button class="link" data-action="open-settings">Set up Anki</button> or use <b>⋯ → Export cards to review</b>.';
  } else {
    el.innerHTML = '';
  }
  el.hidden = !el.innerHTML;
  $('send-cards').hidden = anki.enabled === false;
}

export function updateCount(n) {
  $('cards-count').hidden = !n;
  $('cards-count').textContent = n;
  $('cards-count').classList.add('blue');
}

export async function refreshCount() {
  updateCount((await getDrafts()).length);
}

// ---- editing ----

function draftEl(e) {
  return e.target.closest('.draft');
}

// Text edits are saved as you type, so pressing Send right away never loses them.
let saving = Promise.resolve();
function save(id, patch) {
  saving = saving.then(() => updateDraft(id, patch));
  return saving;
}

$('drafts').addEventListener('input', (e) => {
  const el = draftEl(e);
  const t = e.target;
  if (!el) return;
  if (t.classList.contains('d-tr')) save(el.dataset.id, { translation: t.value.trim() });
  else if (t.classList.contains('d-note')) save(el.dataset.id, { note: t.value.trim() });
});

$('drafts').addEventListener('change', async (e) => {
  const el = draftEl(e);
  if (!el) return;
  const id = el.dataset.id;
  const t = e.target;
  if (t.classList.contains('d-tr') || t.classList.contains('d-note')) return; // saved on input
  if (t.classList.contains('d-whole')) await updateDraft(id, { includeWhole: t.checked });
  else if (t.classList.contains('d-part')) {
    const d = (await getDrafts()).find((x) => x.id === id);
    d.parts[Number(t.dataset.p)].checked = t.checked;
    await updateDraft(id, { parts: d.parts });
  } else if (t.classList.contains('d-lemma')) {
    await relookup(el, id, t.value.trim());
    return;
  }
  renderSendButton();
});

async function renderSendButton() {
  const drafts = await getDrafts();
  const total = drafts.reduce((n, d) => n + draftToCards(d).length, 0);
  $('send-cards').textContent = `Send ${total} card${total === 1 ? '' : 's'} to Anki`;
  $('send-cards').disabled = !total;
}

// The word was edited (e.g. "common decency" -> "decency"): fetch its own translation.
async function relookup(el, id, term) {
  if (!term) return;
  const d = (await getDrafts()).find((x) => x.id === id);
  if (!d || term === d.lemma) return;
  el.querySelector('.d-status').innerHTML = '<span class="spinner"></span>Updating translation…';
  try {
    const r = await explainTerm(state.settings, { term, sentence: d.sentence });
    const inSentence = d.sentence.toLowerCase().includes(r.item.text.toLowerCase());
    await updateDraft(id, {
      lemma: term,
      term: inSentence ? r.item.text : term,
      translation: r.item.translation,
      note: r.item.note,
      kind: r.item.kind,
      parts: r.item.parts.map((p) => ({ ...p, checked: false })),
      includeWhole: true
    });
    renderCards();
  } catch (e) {
    await updateDraft(id, { lemma: term, term });
    el.querySelector('.d-status').innerHTML = `<span class="err">${escapeHtml(e.message)}</span> The word is saved; edit the translation by hand.`;
  }
}

$('drafts').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('d-del')) return;
  const id = draftEl(e).dataset.id;
  const draft = (await getDrafts()).find((d) => d.id === id);
  await removeDrafts([id]);
  renderCards();
  if (draft) {
    toast(`Removed “${draft.lemma}”`, 6000, {
      label: 'Undo',
      run: async () => {
        await restoreDrafts([draft]);
        renderCards();
      }
    });
  }
});

$('cards-queue').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('q-del')) return;
  await bg('bg:removeQueued', { id: e.target.closest('li').dataset.q });
  renderCards();
});

// ---- sending ----

$('send-cards').addEventListener('click', async () => {
  document.activeElement?.blur?.();
  await saving;
  const drafts = await getDrafts();
  const cards = drafts.flatMap(draftToCards);
  if (!cards.length) return;
  $('send-cards').disabled = true;
  try {
    const r = await bg('bg:sendCards', { cards });
    await removeDrafts(drafts.map((d) => d.id));
    const dup = r.duplicates ? ` ${r.duplicates} already in Anki, skipped.` : '';
    let msg;
    if (!r.queued) msg = `Sent ${r.sent} card${r.sent === 1 ? '' : 's'} to Anki.${dup}`;
    else if (!state.settings.anki.connected) msg = `Saved ${r.left} card(s) for Anki. Connect Anki in Settings and they will be sent.`;
    else msg = `Anki is closed: ${r.left} card(s) will be sent when you open it.${dup}`;
    toast(msg, 5000);
  } catch (err) {
    toast(err.message, 5000);
  }
  renderCards();
});

// ---- export (⋯ menu) ----

async function exportCards(which) {
  const { ankiQueue = [], ankiSent = [] } = await chrome.storage.local.get(['ankiQueue', 'ankiSent']);
  let cards;
  if (which === 'drafts') cards = (await getDrafts()).flatMap(draftToCards).map((c) => ({ fields: buildCard(c) }));
  else cards = which === 'all' ? [...ankiSent, ...ankiQueue] : ankiQueue;
  if (!cards.length) {
    toast({ all: 'No cards sent yet.', waiting: 'No cards are waiting for Anki.', drafts: 'No cards to review.' }[which]);
    return;
  }
  const url = `data:text/tab-separated-values;charset=utf-8,${encodeURIComponent(cardsToTsv(cards, state.settings.anki.deck))}`;
  await chrome.downloads.download({ url, filename: `translate-tube-${which}-${new Date().toISOString().slice(0, 10)}.txt`, saveAs: true });
  document.querySelector('.menu').open = false;
}
$('export-drafts').addEventListener('click', () => exportCards('drafts'));
$('export-waiting').addEventListener('click', () => exportCards('waiting'));
$('export-all').addEventListener('click', () => exportCards('all'));

on('drafts', () => (state.tab === 'cards' ? renderCards() : refreshCount()));
on('settings', () => state.tab === 'cards' && renderAnkiNotice());
