// Turns YouTube caption data (json3 format) into sentences with timings.

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Returns pieces of text with start/end in ms. Auto captions give word-level
// segments; manual captions give whole lines.
export function parseJson3(json) {
  const pieces = [];
  const events = (json?.events ?? []).filter((e) => e.segs && e.tStartMs !== undefined);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const evEnd = e.tStartMs + (e.dDurationMs ?? 0);
    const segs = e.segs.filter((s) => s.utf8 && s.utf8 !== '\n');
    segs.forEach((s, j) => {
      const start = e.tStartMs + (s.tOffsetMs ?? 0);
      const nextOffset = segs[j + 1]?.tOffsetMs;
      const end = nextOffset !== undefined ? e.tStartMs + nextOffset : evEnd;
      const text = decodeEntities(s.utf8).replace(/\s+/g, ' ');
      if (text.trim()) pieces.push({ text, start, end: Math.max(end, start) });
    });
  }
  return pieces;
}

const SENTENCE_END = /[.!?…]["')\]]*\s*$/;

export function buildSentences(pieces, { maxWords = 28, maxGapMs = 1600 } = {}) {
  const sentences = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text.trim()) {
      cur.text = cur.text.replace(/\s+/g, ' ').replace(/^\s*[-–]\s*/, '').trim();
      if (cur.text) sentences.push(cur);
    }
    cur = null;
  };
  for (const p of pieces) {
    const text = p.text.replace(/\[[^\]]*\]/g, ' ');
    if (cur && p.start - cur.end > maxGapMs) flush();
    if (!cur) cur = { text: '', start: p.start, end: p.end };
    const needsSpace = cur.text && !/\s$/.test(cur.text) && !/^\s/.test(text);
    cur.text += (needsSpace ? ' ' : '') + text;
    cur.end = Math.max(cur.end, p.end);
    const words = cur.text.trim().split(/\s+/).length;
    if (SENTENCE_END.test(text) || words >= maxWords) flush();
  }
  flush();
  return sentences.map((s, id) => ({ id, ...s }));
}

export function sentenceAt(sentences, ms) {
  let lo = 0;
  let hi = sentences.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid].start <= ms) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// Splits a sentence into word and non-word tokens, keeping everything so the
// sentence can be rendered back exactly.
export function tokenize(text) {
  const tokens = [];
  const re = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) tokens.push({ text: text.slice(last, m.index), word: false });
    tokens.push({ text: m[0], word: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), word: false });
  return tokens;
}

// Finds the token ranges covered by each highlight phrase.
export function markHighlights(tokens, phrases) {
  const marks = new Array(tokens.length).fill(-1);
  const lower = tokens.map((t) => t.text.toLowerCase());
  phrases.forEach((phrase, pi) => {
    const want = tokenize(String(phrase).toLowerCase()).filter((t) => t.word).map((t) => t.text);
    if (!want.length) return;
    for (let i = 0; i < tokens.length; i++) {
      if (!tokens[i].word || lower[i] !== want[0] || marks[i] !== -1) continue;
      const covered = [i];
      let j = i + 1;
      let k = 1;
      while (k < want.length && j < tokens.length) {
        if (tokens[j].word) {
          if (lower[j] !== want[k]) break;
          covered.push(j);
          k++;
        }
        j++;
      }
      if (k === want.length) {
        for (let x = covered[0]; x <= covered[covered.length - 1]; x++) marks[x] = pi;
        break;
      }
    }
  });
  return marks;
}
