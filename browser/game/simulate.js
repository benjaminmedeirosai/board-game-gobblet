// Offline AI-vs-AI simulator. Plays a round-robin among the computer opponents
// using the SAME rules engine and move-pickers as the live game (no separate
// copy of the logic), so the results reflect exactly how they behave.
//
// A "contender" is { type, difficulty } — difficulty feeds the imperfect-memory
// model (easy/medium forget buried pieces; hard is perfect). Random ignores it,
// so it's a single contender.
//
// Every unordered pairing (including mirrors) plays `games` games, alternating
// who moves first (an even count, so each side starts an equal number of
// times). Each game is fingerprinted by its full move history, then hashed to a
// short base-36 id: two games with the same id are the same game, so duplicates
// are visible at a glance.

import { newGame, BOARD_SIZE } from './state.js';
import { applyMove } from './rules.js';
import { chooseMove, FORGET_PROB } from './ai.js';

// The field. Random has no meaningful difficulty (it ignores memory).
export const CONTENDERS = [
  { type: 'random' },
  { type: 'gobbler', difficulty: 'easy' },
  { type: 'gobbler', difficulty: 'medium' },
  { type: 'gobbler', difficulty: 'hard' },
  { type: 'speedrunner', difficulty: 'easy' },
  { type: 'speedrunner', difficulty: 'medium' },
  { type: 'speedrunner', difficulty: 'hard' },
];

// A stable key for a contender, e.g. "gobbler/hard" or "random/".
export const contenderKey = (c) => `${c.type}/${c.difficulty || ''}`;

// Memory arg for chooseMove: none for perfect recall (hard / random), else a
// fresh per-game, per-seat forget set carried across that seat's turns.
function memoryFor(contender, forgetSet) {
  if (!contender.difficulty || contender.difficulty === 'hard') return undefined;
  return { forgotten: forgetSet, prob: FORGET_PROB[contender.difficulty] || 0 };
}

// A full fingerprint of a game: the first player plus every move (placement =
// P<stack><cell>, board move = M<from><to>, cells 0–f). The game is fully
// determined by this string, so identical strings === identical games.
const HEX = '0123456789abcdef';
const cellHex = (r, c) => HEX[r * BOARD_SIZE + c];
function gameSignature(log, firstPlayer) {
  let sig = String(firstPlayer);
  for (const e of log) {
    sig += e.kind === 'place'
      ? `P${e.stack}${cellHex(e.to[0], e.to[1])}`
      : `M${cellHex(e.from[0], e.from[1])}${cellHex(e.to[0], e.to[1])}`;
  }
  return sig;
}

// Collapse that fingerprint into a short, stable base-36 id for display
// (cyrb53 → 53-bit, ~10 alphanumeric chars). Same history → same id; a
// collision between two *different* games is astronomically unlikely at this
// scale, so equal ids mean "the same game played out".
function gameId(sig) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < sig.length; i++) {
    const ch = sig.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Play one game. Returns { winner: 0|1|null, turns, id, first }. winner null =
// hit the turn cap unresolved. turns = number of turns (plies) played. first =
// the seat (0 = contender a, 1 = contender b) that moved first.
function playGame(a, b, firstPlayer, turnCap) {
  const forget = [new Set(), new Set()];
  let s = newGame(firstPlayer);
  for (let ply = 0; ply < turnCap && s.winner === null; ply++) {
    const who = s.turn === 0 ? a : b;
    const move = chooseMove(s, s.turn, who.type, memoryFor(who, forget[s.turn]));
    if (!move) break;
    const res = applyMove(s, move);
    if (!res.ok) break;
    s = res.state;
  }
  return {
    winner: s.winner, turns: s.moveCount, first: firstPlayer,
    id: gameId(gameSignature(s.log, firstPlayer)),
  };
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// Run the whole round-robin `games` times per pairing, alternating who moves
// first. onProgress(done, total) fires per game so the UI can show a bar;
// yielding happens per pairing to stay responsive without much overhead.
// Returns per-matchup game records plus timing (compute excludes the yields).
export async function runSimulations({ games = 6, turnCap = 50, onProgress } = {}) {
  const matchups = [];
  const total = (CONTENDERS.length * (CONTENDERS.length + 1)) / 2 * games;
  let done = 0;
  let computeMs = 0;
  const wallStart = performance.now();

  for (let i = 0; i < CONTENDERS.length; i++) {
    for (let j = i; j < CONTENDERS.length; j++) {
      const a = CONTENDERS[i];
      const b = CONTENDERS[j];
      const record = [];
      for (let g = 0; g < games; g++) {
        const t0 = performance.now();
        record.push(playGame(a, b, g % 2, turnCap));
        computeMs += performance.now() - t0;
        done += 1;
        if (onProgress) onProgress(done, total);
      }
      matchups.push({ a, b, games: record });
      await nextFrame(); // let the browser paint between pairings
    }
  }

  return {
    version: 2,
    games,
    turnCap,
    total,
    computeMs: Math.round(computeMs),
    wallMs: Math.round(performance.now() - wallStart),
    matchups,
  };
}
