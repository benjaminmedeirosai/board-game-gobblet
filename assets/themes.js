// Theme registry. Each theme lives in assets/<id>/theme.js and shares the same
// interface (id, name, playerNames, colors, sizeScale, pieceSVG). Add a theme by
// importing it here — the Settings picker is built from THEME_LIST.

import classic from './classic/theme.js';
import notched from './notched/theme.js';

export const THEMES = { classic, notched };

export const THEME_LIST = Object.values(THEMES).map((t) => ({ id: t.id, name: t.name }));

export function getTheme(id) {
  return THEMES[id] || classic;
}
