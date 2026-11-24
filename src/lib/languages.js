// Languages offered in the settings. `code` is an ISO 639-1 code, which is
// also what YouTube uses for caption tracks.
export const LANGUAGES = [
  ['ar', 'Arabic'], ['bg', 'Bulgarian'], ['cs', 'Czech'], ['da', 'Danish'],
  ['de', 'German'], ['el', 'Greek'], ['en', 'English'], ['es', 'Spanish'],
  ['et', 'Estonian'], ['fi', 'Finnish'], ['fr', 'French'], ['he', 'Hebrew'],
  ['hi', 'Hindi'], ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['lt', 'Lithuanian'], ['lv', 'Latvian'],
  ['nb', 'Norwegian'], ['nl', 'Dutch'], ['pl', 'Polish'], ['pt', 'Portuguese'],
  ['ro', 'Romanian'], ['ru', 'Russian'], ['sk', 'Slovak'], ['sl', 'Slovenian'],
  ['sv', 'Swedish'], ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['vi', 'Vietnamese'],
  ['zh', 'Chinese']
].map(([code, name]) => ({ code, name }));

// Locale used by Anki's text-to-speech for each language.
const SPEECH = {
  ar: 'ar_SA', bg: 'bg_BG', cs: 'cs_CZ', da: 'da_DK', de: 'de_DE', el: 'el_GR', en: 'en_US', es: 'es_ES',
  et: 'et_EE', fi: 'fi_FI', fr: 'fr_FR', he: 'he_IL', hi: 'hi_IN', hu: 'hu_HU', id: 'id_ID', it: 'it_IT',
  ja: 'ja_JP', ko: 'ko_KR', lt: 'lt_LT', lv: 'lv_LV', nb: 'nb_NO', nl: 'nl_NL', pl: 'pl_PL', pt: 'pt_PT',
  ro: 'ro_RO', ru: 'ru_RU', sk: 'sk_SK', sl: 'sl_SI', sv: 'sv_SE', tr: 'tr_TR', uk: 'uk_UA', vi: 'vi_VN',
  zh: 'zh_CN'
};

export function speechLocale(code) {
  return SPEECH[code] ?? '';
}

export function languageName(code) {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}
