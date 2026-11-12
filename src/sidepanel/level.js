// The level control in the header: − shows more words, + shows fewer.
import { $, state, on } from './core.js';
import { saveSettings, LEVELS } from '../lib/storage.js';

// Quick presses add up: each one starts from the level the last press asked for.
let wanted = null;

export function levelLabel(level = state.settings.level) {
  return LEVELS.find((l) => l.value === Number(level))?.label ?? '';
}

export function renderLevel() {
  const level = wanted ?? Number(state.settings.level);
  const l = LEVELS.find((x) => x.value === level);
  $('lvl-label').textContent = `Level ${level}`;
  $('lvl-label').title = l ? `${l.label}: ${l.hint}` : '';
  $('lvl-down').disabled = level <= 1;
  $('lvl-up').disabled = level >= LEVELS.length;
}

export async function changeLevel(delta) {
  const from = wanted ?? Number(state.settings.level);
  const level = Math.max(1, Math.min(LEVELS.length, from + delta));
  if (level === from) return;
  wanted = level;
  renderLevel();
  await saveSettings({ level }); // the storage listener repaints everything
}

$('lvl-down').addEventListener('click', () => changeLevel(-1));
$('lvl-up').addEventListener('click', () => changeLevel(+1));

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
  if (e.key === '-') changeLevel(-1);
  else if (e.key === '+' || e.key === '=') changeLevel(+1);
  else return;
  e.preventDefault();
});

on('settings', () => {
  if (Number(state.settings.level) === wanted) wanted = null;
  renderLevel();
});
