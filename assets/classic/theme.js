// "Classic" theme: SVG goblets (inverted cups). A theme provides player colors,
// per-size scale factors, and an SVG for each (player, size) combination.
// Additional themes drop into assets/<name>/theme.js with the same interface.

const PLAYERS = [
  { name: 'Amber', base: '#e39d38', dark: '#9c6118', light: '#ffd991' },
  { name: 'Blue', base: '#3b9ad9', dark: '#1c5e93', light: '#a5d8ff' },
];

function goblet({ base, dark, light }) {
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="50" cy="78" rx="30" ry="9" fill="${dark}"/>
    <path d="M50 8 C 29 8 24 34 21.5 78 L 78.5 78 C 76 34 71 8 50 8 Z"
      fill="${base}" stroke="${dark}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M37 20 C 32.5 27 30.5 38 29.5 50"
      fill="none" stroke="${light}" stroke-width="5" stroke-linecap="round" opacity="0.65"/>
  </svg>`;
}

export default {
  id: 'classic',
  name: 'Classic Goblets',
  playerNames: PLAYERS.map((p) => p.name),
  colors: PLAYERS.map((p) => p.base),
  // Rendered footprint of each size (S..XL) relative to a board cell.
  sizeScale: [0.42, 0.6, 0.78, 0.96],
  pieceSVG(player, _size) {
    return goblet(PLAYERS[player]);
  },
};
