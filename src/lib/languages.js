// Languages offered in the settings. `code` is an ISO 639-1 code, which is
// also what YouTube uses for caption tracks and what DeepL accepts.
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

export function languageName(code) {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}
