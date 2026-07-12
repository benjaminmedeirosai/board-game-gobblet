// Offline "computer" opponents. Each is a heuristic move-picker over the pure
// rules engine — no deep search, just prioritized strategies.
//
// Every opponent — even random — first takes a guaranteed win via
// winningMove(). The logic AIs also keep their gobbles covered: they won't lift
// a piece off an opponent piece unless nothing else is available.
//
//  random      — dummy: a uniformly random legal move (but still wins if it can).
//  gobbler     — hunts gobbles. Reserve-gobble (rule of three) is the prize
//                since it saves a move; otherwise direct gobbles, ideally one
//                size down. Stays defensive (avoids making its own three-in-a-
//                row, which would expose it to a reserve gobble) and develops
//                by draining its stacks evenly (level-load: play the fullest).
//  speedrunner — dumps pieces fast: reserve-gobble if available, else drains
//                ONE stack top-to-bottom (XL→L→M→S) before starting the next.

import { top, reserveTopSize } from './state.js';
import { applyMove, allLegalMoves, allLines, winningMove } from './rules.js';

export const AI_TYPES = [
  { id: 'random', name: 'Random' },
  { id: 'gobbler', name: 'Gobbler' },
  { id: 'speedrunner', name: 'Speedrunner' },
];

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

function makesThreeInARow(state, p) {
  for (const line of allLines()) {
    let count = 0;
    for (const [r, c] of line) if (top(state.board[r][c])?.p === p) count += 1;
    if (count === 3) return true;
  }
  return false;
}

// Tactical properties of a candidate move for player p.
function annotate(state, p, move) {
  const o = 1 - p;
  const res = applyMove(state, move);
  const a = {
    move, win: false, handsWin: false, oppCanWin: false,
    reserveGobble: false, directGobble: false, movedSize: null, preySize: null,
    ownThree: false, releasesGobble: false,
  };
  if (!res.ok) return a;
  const ns = res.state;
  a.win = ns.winner === p;
  a.handsWin = ns.winner === o; // e.g. a reveal that completes the opponent's line
  if (ns.winner === null) {
    a.ownThree = makesThreeInARow(ns, p);
    a.oppCanWin = allLegalMoves(ns, o).some((om) => {
      const r = applyMove(ns, om);
      return r.ok && r.state.winner === o;
    });
  }
  if (move.type === 'place') {
    a.movedSize = reserveTopSize(state, p, move.stack);
    const t = top(state.board[move.to[0]][move.to[1]]);
    if (t && t.p === o) { a.reserveGobble = true; a.preySize = t.s; }
  } else {
    const stack = state.board[move.from[0]][move.from[1]];
    a.movedSize = top(stack).s;
    // Lifting a piece that sits directly on an opponent piece un-covers it —
    // "releasing" a gobble we'd generally rather keep in place.
    const under = stack[stack.length - 2];
    if (under && under.p === o) a.releasesGobble = true;
    const t = top(state.board[move.to[0]][move.to[1]]);
    if (t && t.p === o) { a.directGobble = true; a.preySize = t.s; }
  }
  return a;
}

export function chooseMove(state, player, type) {
  // 0) Take a guaranteed win — shared by every opponent, including random.
  const win = winningMove(state, player);
  if (win) return win;

  const moves = allLegalMoves(state, player);
  if (!moves.length) return null;
  if (type === 'random') return rand(moves);

  const anns = moves.map((m) => annotate(state, player, m));
  // Never hand the opponent a win if avoidable.
  const safe = anns.filter((a) => !a.handsWin);
  const base = safe.length ? safe : anns;
  // 1) Block the opponent's immediate win if we can.
  const blocking = base.filter((a) => !a.oppCanWin);
  let pool = blocking.length ? blocking : base;
  // 2) Keep our gobbles covered: don't lift a piece off an opponent piece
  //    unless every remaining move would (nothing else to do).
  const kept = pool.filter((a) => !a.releasesGobble);
  if (kept.length) pool = kept;
  // 3) Reserve gobble (rule of three) — the shared top priority; it saves a move.
  const reserveGobbles = pool.filter((a) => a.reserveGobble);
  if (reserveGobbles.length) return rand(reserveGobbles).move;

  return type === 'speedrunner' ? speedrunner(state, player, pool) : gobbler(state, player, pool);
}

function gobbler(state, p, pool) {
  const oneDown = pool.filter((a) => a.directGobble && a.movedSize - a.preySize === 1);
  if (oneDown.length) return rand(oneDown).move;
  const anyGobble = pool.filter((a) => a.directGobble);
  if (anyGobble.length) return rand(anyGobble).move;

  const reservesLeft = state.reserves[p].reduce((sum, n) => sum + n, 0);
  if (reservesLeft <= 6) {
    // Late game: stop hiding — start building a line toward a win.
    const building = pool.filter((a) => a.ownThree);
    if (building.length) return rand(building).move;
  } else {
    // Early game: stay defensive — don't expose a three-in-a-row to a reserve gobble.
    const defensive = pool.filter((a) => !a.ownThree);
    if (defensive.length) pool = defensive;
  }
  const placements = pool.filter((a) => a.move.type === 'place');
  if (placements.length) {
    // Level-load: play from the fullest stack so all stacks drain evenly.
    const max = Math.max(...placements.map((a) => state.reserves[p][a.move.stack]));
    return rand(placements.filter((a) => state.reserves[p][a.move.stack] === max)).move;
  }
  return rand(pool).move;
}

function speedrunner(state, p, pool) {
  const placements = pool.filter((a) => a.move.type === 'place');
  if (placements.length) {
    // Drain one stack fully first: play from the most-drained non-empty stack.
    const min = Math.min(...placements.map((a) => state.reserves[p][a.move.stack]));
    return rand(placements.filter((a) => state.reserves[p][a.move.stack] === min)).move;
  }
  const gobbles = pool.filter((a) => a.directGobble);
  if (gobbles.length) return rand(gobbles).move;
  return rand(pool).move;
}
