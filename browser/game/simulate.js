// Offline AI-vs-AI simulator. Plays a curated set of matchups using the SAME
// rules engine and move-pickers as the live game (no separate copy of the
// logic), so the results reflect exactly how the computer opponents behave.
//
// A "contender" is { type, difficulty } — difficulty feeds the imperfect-memory
// model (easy/medium forget buried pieces; hard is perfect). Random ignores it.
//
// We don't run all permutations — just the interesting ones: each style against
// a mirror of itself, the two real styles against each other, each difficulty
// axis (hard vs easy of the same style), and a sanity check against Random.

import { newGame } from './state.js';
import { applyMove } from './rules.js';
import { chooseMove, FORGET_PROB } from './ai.js';

const C = (type, difficulty) => ({ type, difficulty });

// label: human-readable pairing name shown in the results table.
// a / b: seat 0 and seat 1 contenders (fixed; the FIRST move alternates instead).
export const MATCHUPS = [
  { label: 'Speedrunner mirror', a: C('speedrunner', 'medium'), b: C('speedrunner', 'medium') },
  { label: 'Gobbler mirror', a: C('gobbler', 'medium'), b: C('gobbler', 'medium') },
  { label: 'Random mirror', a: C('random'), b: C('random') },
  { label: 'Gobbler vs Speedrunner', a: C('gobbler', 'medium'), b: C('speedrunner', 'medium') },
  { label: 'Speedrunner: Hard vs Easy', a: C('speedrunner', 'hard'), b: C('speedrunner', 'easy') },
  { label: 'Gobbler: Hard vs Easy', a: C('gobbler', 'hard'), b: C('gobbler', 'easy') },
  { label: 'Speedrunner vs Random', a: C('speedrunner', 'medium'), b: C('random') },
  { label: 'Gobbler vs Random', a: C('gobbler', 'medium'), b: C('random') },
];

// Memory arg for chooseMove: none for perfect recall (hard / random), else a
// fresh per-game, per-seat forget set carried across that seat's turns.
function memoryFor(contender, forgetSet) {
  if (!contender.difficulty || contender.difficulty === 'hard') return undefined;
  return { forgotten: forgetSet, prob: FORGET_PROB[contender.difficulty] || 0 };
}

// Play one game. Returns { winner: 0|1|null, plies }. winner null = hit the ply
// cap unresolved (a heuristic loop / stalemate), reported as a draw.
function playGame(a, b, firstPlayer, plyCap) {
  const forget = [new Set(), new Set()];
  let s = newGame(firstPlayer);
  for (let ply = 0; ply < plyCap && s.winner === null; ply++) {
    const who = s.turn === 0 ? a : b;
    const move = chooseMove(s, s.turn, who.type, memoryFor(who, forget[s.turn]));
    if (!move) break;
    const res = applyMove(s, move);
    if (!res.ok) break;
    s = res.state;
  }
  return { winner: s.winner, plies: s.moveCount };
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// Run every matchup `games` times, alternating who moves first for fairness.
// onProgress(done, total) fires between games (with a yield) so the UI can paint
// a progress bar and stay responsive. Returns per-matchup tallies plus the total
// COMPUTE time (excludes the cooperative yields) and wall time.
export async function runSimulations({ games = 4, plyCap = 80, onProgress } = {}) {
  const results = [];
  const total = MATCHUPS.length * games;
  let done = 0;
  let computeMs = 0;
  const wallStart = performance.now();

  for (const mu of MATCHUPS) {
    let aWins = 0;
    let bWins = 0;
    let draws = 0;
    let plies = 0;
    for (let g = 0; g < games; g++) {
      const t0 = performance.now();
      const r = playGame(mu.a, mu.b, g % 2, plyCap);
      computeMs += performance.now() - t0;
      if (r.winner === 0) aWins += 1;
      else if (r.winner === 1) bWins += 1;
      else draws += 1;
      plies += r.plies;
      done += 1;
      if (onProgress) onProgress(done, total);
      await nextFrame(); // let the browser paint between games
    }
    results.push({
      label: mu.label, a: mu.a, b: mu.b,
      aWins, bWins, draws, avgPlies: Math.round(plies / games),
    });
  }

  return {
    results, games, plyCap, total,
    computeMs: Math.round(computeMs),
    wallMs: Math.round(performance.now() - wallStart),
  };
}
