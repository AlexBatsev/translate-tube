// Quick vocabulary self-check (English only for now). Each band is a bit
// rarer than the one before. Level = the last band where the learner knows
// at least 4 of 5 words, counting from the easiest.
export const SELF_CHECK = {
  en: [
    ['house', 'water', 'friend', 'happy', 'money'],
    ['weather', 'borrow', 'journey', 'honest', 'invite'],
    ['achieve', 'reluctant', 'budget', 'gather', 'rely'],
    ['thorough', 'cunning', 'scrutiny', 'wary', 'blunt'],
    ['ubiquitous', 'cajole', 'quaint', 'brusque', 'mollify'],
    ['obsequious', 'perfunctory', 'pusillanimous', 'crapulent', 'tergiversate']
  ]
};

export function levelFromCheck(bands, knownSet) {
  let level = 1;
  for (let i = 0; i < bands.length; i++) {
    const hits = bands[i].filter((w) => knownSet.has(w)).length;
    if (hits >= 4) level = i + 1;
    else break;
  }
  return level;
}

// Accepts plain lists, CSV/TSV rows or "word — translation" lines and keeps
// the first column (the word in the learning language).
export function parseWordList(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const first = line.split(/\t|;|,|\s[—–-]\s|=/)[0].trim();
    if (first && first.length <= 60) out.push(first);
  }
  return out;
}
