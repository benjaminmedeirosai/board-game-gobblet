// "Notched" theme: the same goblets as Classic, but each size carries a row of
// pips (1 for Small … 4 for XL) so you can tell sizes apart at a glance — handy
// when a big goblet's footprint alone is hard to judge.

const PLAYERS = [
  { name: 'Amber', base: '#e39d38', dark: '#9c6118', light: '#ffd991' },
  { name: 'Blue', base: '#3b9ad9', dark: '#1c5e93', light: '#a5d8ff' },
];

function pips(size, dark) {
  const n = size + 1; // S=1, M=2, L=3, XL=4
  const gap = 12;
  const start = 50 - ((n - 1) * gap) / 2;
  let dots = '';
  for (let i = 0; i < n; i++) {
    dots += `<circle cx="${start + i * gap}" cy="64" r="3.4" fill="${dark}"/>`;
  }
  return dots;
}

function goblet({ base, dark, light }, size) {
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="50" cy="78" rx="30" ry="9" fill="${dark}"/>
    <path d="M50 8 C 29 8 24 34 21.5 78 L 78.5 78 C 76 34 71 8 50 8 Z"
      fill="${base}" stroke="${dark}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M37 20 C 32.5 27 30.5 38 29.5 50"
      fill="none" stroke="${light}" stroke-width="5" stroke-linecap="round" opacity="0.65"/>
    ${pips(size, dark)}
  </svg>`;
}

export default {
  id: 'notched',
  name: 'Marked Goblets',
  playerNames: PLAYERS.map((p) => p.name),
  colors: PLAYERS.map((p) => p.base),
  sizeScale: [0.42, 0.6, 0.78, 0.96],
  pieceSVG(player, size) {
    return goblet(PLAYERS[player], size);
  },
};
