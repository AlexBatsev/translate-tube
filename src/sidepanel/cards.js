// Cards tab: review list (edit, tick words, delete), then send to Anki.
import { $, state, on, toast, bg, escapeHtml } from './core.js';
import { getDrafts, updateDraft, removeDrafts, draftToCards, groupByVideo } from '../lib/drafts.js';
import { explainTerm } from '../lib/ai.js';
import { cardsToTsv, videoLink } from '../lib/card.js';

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
  $('waiting-box').hidden = !ankiQueue.length;
  $('cards-queue').innerHTML = ankiQueue
    .map((c) => `<li><b>${c.fields.Word}</b> <span class="muted">— ${c.fields.Translation}</span>${c.lastError ? `<span class="err">${escapeHtml(c.lastError)}</span>` : ''}</li>`)
    .join('');
  $('sent-count').textContent = ankiSent.length ? `(${ankiSent.length})` : '';
  $('cards-sent').innerHTML =
    ankiSent.slice(-100).reverse().map((c) => `<li><b>${c.fields.Word}</b> <span class="muted">— ${c.fields.Translation}</span></li>`).join('') ||
    '<li class="muted">Nothing sent yet.</li>';
  updateCount(drafts.length);
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

$('drafts').addEventListener('change', async (e) => {
  const el = draftEl(e);
  if (!el) return;
  const id = el.dataset.id;
  const t = e.target;
  if (t.classList.contains('d-tr')) await updateDraft(id, { translation: t.value.trim() });
  else if (t.classList.contains('d-note')) await updateDraft(id, { note: t.value.trim() });
  else if (t.classList.contains('d-whole')) await updateDraft(id, { includeWhole: t.checked });
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
  await removeDrafts([draftEl(e).dataset.id]);
  renderCards();
});

// ---- sending ----

$('send-cards').addEventListener('click', async () => {
  const drafts = await getDrafts();
  const cards = drafts.flatMap(draftToCards);
  if (!cards.length) return;
  $('send-cards').disabled = true;
  try {
    const r = await bg('bg:sendCards', { cards });
    await removeDrafts(drafts.map((d) => d.id));
    toast(r.queued ? `Anki is closed: ${r.left} card(s) will be sent when you open it.` : `Sent ${cards.length} card(s) to Anki.`, 4000);
  } catch (err) {
    toast(err.message, 5000);
  }
  renderCards();
});

// ---- export (⋯ menu) ----

async function exportCards(which) {
  const { ankiQueue = [], ankiSent = [] } = await chrome.storage.local.get(['ankiQueue', 'ankiSent']);
  const cards = which === 'all' ? [...ankiSent, ...ankiQueue] : ankiQueue;
  if (!cards.length) {
    toast(which === 'all' ? 'No cards sent yet.' : 'No cards are waiting for Anki.');
    return;
  }
  const url = `data:text/tab-separated-values;charset=utf-8,${encodeURIComponent(cardsToTsv(cards, state.settings.anki.deck))}`;
  await chrome.downloads.download({ url, filename: `translate-tube-${which}-${new Date().toISOString().slice(0, 10)}.txt`, saveAs: true });
  document.querySelector('.menu').open = false;
}
$('export-waiting').addEventListener('click', () => exportCards('waiting'));
$('export-all').addEventListener('click', () => exportCards('all'));

on('drafts', () => (state.tab === 'cards' ? renderCards() : refreshCount()));
