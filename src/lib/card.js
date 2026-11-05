// Builds the Anki note fields for a word.

export const NOTE_TYPE = 'Translate Tube';
export const NOTE_FIELDS = ['Word', 'Translation', 'Note', 'Sentence', 'SentenceTranslation', 'VideoTitle', 'VideoLink'];

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function videoLink(videoId, ms) {
  if (!videoId) return '';
  const t = Math.max(0, Math.floor((ms ?? 0) / 1000) - 1);
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${t}s`;
}

export function boldTerm(sentence, term) {
  const safe = escapeHtml(sentence);
  if (!term) return safe;
  const esc = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(^|[^\\p{L}])(${esc})(?=[^\\p{L}]|$)`, 'iu'), '$1<b>$2</b>');
}

// `term` is the dictionary form shown on the card front ("blow it");
// `surface` is the form used in the video ("blew it"), bolded in the sentence.
export function buildCard({ term, surface, translation, note, sentence, sentenceTranslation, videoId, videoTitle, ms }) {
  return {
    Word: escapeHtml(term),
    Translation: escapeHtml(translation),
    Note: escapeHtml(note),
    Sentence: sentence ? boldTerm(sentence, surface || term) : '',
    SentenceTranslation: escapeHtml(sentenceTranslation),
    VideoTitle: escapeHtml(videoTitle || 'YouTube'),
    VideoLink: videoLink(videoId, ms)
  };
}

function tsvCell(s) {
  return String(s ?? '').replace(/[\t\r\n]+/g, ' ');
}

// Anki "Import File" text format. Needs the "Translate Tube" note type, which
// the extension creates the first time it reaches Anki.
export function cardsToTsv(cards, deck) {
  const head = ['#separator:tab', '#html:true', `#notetype:${NOTE_TYPE}`, `#deck:${deck}`, '#tags column:8'];
  const rows = cards.map((c) => [...NOTE_FIELDS.map((f) => tsvCell(c.fields[f])), 'translate-tube'].join('\t'));
  return [...head, ...rows].join('\n') + '\n';
}
