// Cards the learner picked while watching or preparing. They wait here, to be
// edited and then sent to Anki together. Never discarded automatically.

export async function getDrafts() {
  const { drafts = [] } = await chrome.storage.local.get('drafts');
  return drafts;
}

async function setDrafts(drafts) {
  await chrome.storage.local.set({ drafts });
}

export function sameCard(a, b) {
  return a.videoId === b.videoId && a.lemma.toLowerCase() === b.lemma.toLowerCase() && a.sentence === b.sentence;
}

// item: { text, lemma, translation, note, kind, parts }
export async function addDraft(item, { sentence, sentenceTranslation, videoId, videoTitle, ms }) {
  const drafts = await getDrafts();
  const draft = {
    id: crypto.randomUUID(),
    addedAt: Date.now(),
    term: item.text,
    lemma: item.lemma || item.text,
    translation: item.translation,
    note: item.note,
    kind: item.kind,
    parts: (item.parts ?? []).map((p) => ({ ...p, checked: false })),
    includeWhole: true,
    sentence,
    sentenceTranslation,
    videoId,
    videoTitle,
    ms
  };
  if (drafts.some((d) => sameCard(d, draft))) return { added: false, count: drafts.length };
  drafts.push(draft);
  await setDrafts(drafts);
  return { added: true, count: drafts.length };
}

export async function updateDraft(id, patch) {
  const drafts = await getDrafts();
  const d = drafts.find((x) => x.id === id);
  if (d) Object.assign(d, patch);
  await setDrafts(drafts);
  return d;
}

export async function removeDrafts(ids) {
  const drop = new Set(ids);
  await setDrafts((await getDrafts()).filter((d) => !drop.has(d.id)));
}

// One draft can become several cards: the whole phrase and/or ticked words.
export function draftToCards(d) {
  const base = { sentence: d.sentence, sentenceTranslation: d.sentenceTranslation, videoId: d.videoId, videoTitle: d.videoTitle, ms: d.ms };
  const cards = [];
  if (d.includeWhole) {
    cards.push({ ...base, term: d.lemma, surface: d.term, lemma: d.lemma, translation: d.translation, note: d.note, kind: d.kind, parts: d.parts });
  }
  for (const p of d.parts ?? []) {
    if (p.checked) cards.push({ ...base, term: p.text, surface: d.term, lemma: p.text, translation: p.translation, note: `${d.lemma} — ${d.translation}`, kind: 'word', parts: [] });
  }
  return cards;
}

export function groupByVideo(drafts) {
  const groups = new Map();
  for (const d of drafts) {
    if (!groups.has(d.videoId)) groups.set(d.videoId, { videoId: d.videoId, title: d.videoTitle, drafts: [] });
    groups.get(d.videoId).drafts.push(d);
  }
  return [...groups.values()];
}
