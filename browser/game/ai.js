// Offline "computer" opponents. Each is a heuristic move-picker over the pure
// rules engine — no deep search beyond a two-ply forced-win check.
//
// Shared spine (all opponents):
//   • take a guaranteed win (winningMove), even random;
//   • never hand the opponent a win, and block their immediate win;
//   • keep gobbles covered — don't lift a piece off an opponent piece;
//   • CLOSING MOVE: play a move that forces a win against every reply (a double
//     threat, or a threat the opponent can't cover); and
//   • grab the rule-of-three reserve gobble (saves a tempo either way).
//
// Where they differ is the EARLY/MID game, before a finish is on:
//   gobbler     — a board bully. Hunts gobbles (efficient one-size-down first),
//                 seizes high-value squares (center/diagonals), and develops its
//                 lines — staying off exposed threes early, then building to win.
//   speedrunner — a line rusher. Commits to one uncontested line and races to
//                 fill four, draining a single stack for tempo; gobbles or drains
//                 only when it can't extend its line.
//   random      — dummy: a uniformly random legal move (but still wins if it can).

import { top, reserveTopSize } from './state.js';
import { applyMove, allLegalMoves, allLines, winningMove } from './rules.js';

export const AI_TYPES = [
  { id: 'random', name: 'Random' },
  { id: 'gobbler', name: 'Gobbler' },
  { id: 'speedrunner', name: 'Speedrunner' },
];

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Pick the move scoring highest by scoreFn, breaking ties at random.
function pickBest(anns, scoreFn) {
  let bestScore = -Infinity;
  let bucket = [];
  for (const a of anns) {
    const s = scoreFn(a);
    if (s > bestScore) { bestScore = s; bucket = [a]; }
    else if (s === bestScore) bucket.push(a);
  }
  return rand(bucket).move;
}

function makesThreeInARow(state, p) {
  for (const line of allLines()) {
    let count = 0;
    for (const [r, c] of line) if (top(state.board[r][c])?.p === p) count += 1;
    if (count === 3) return true;
  }
  return false;
}

// How developed p's lines are: a near-win (3 in a line with no opponent piece)
// weighs heavily; pairs and singles a little. Contested lines (an opponent piece
// present) can't be completed, so they score nothing.
function lineScore(state, p) {
  const o = 1 - p;
  let score = 0;
  for (const line of allLines()) {
    let mine = 0;
    let opp = 0;
    for (const [r, c] of line) {
      const t = top(state.board[r][c]);
      if (t?.p === p) mine += 1;
      else if (t?.p === o) opp += 1;
    }
    if (opp) continue;
    score += mine === 3 ? 10 : mine === 2 ? 2 : mine;
  }
  return score;
}

// How many winning lines each cell sits on (corners/center/diagonals count for
// more) — worth grabbing early since they feed more potential fours.
const CELL_WEIGHT = (() => {
  const w = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (const line of allLines()) for (const [r, c] of line) w[r][c] += 1;
  return w;
})();

const inLine = (line, [r, c]) => line.some(([lr, lc]) => lr === r && lc === c);

// The best uncontested line for p to build: most of its cells already ours,
// tie-broken toward higher-value open cells. Null if every line is contested.
function bestBuildLine(state, p) {
  const o = 1 - p;
  let best = null;
  for (const line of allLines()) {
    let mine = 0;
    let opp = 0;
    let openWeight = 0;
    for (const [r, c] of line) {
      const t = top(state.board[r][c]);
      if (t?.p === p) mine += 1;
      else if (t?.p === o) opp += 1;
      else openWeight += CELL_WEIGHT[r][c];
    }
    if (opp || mine === 0) continue;
    const key = mine * 100 + openWeight;
    if (!best || key > best.key) best = { line, key };
  }
  return best?.line || null;
}

// Tactical properties of a candidate move for player p.
function annotate(state, p, move) {
  const o = 1 - p;
  const res = applyMove(state, move);
  const a = {
    move, next: null, win: false, handsWin: false, oppCanWin: false,
    reserveGobble: false, directGobble: false, movedSize: null, preySize: null,
    ownThree: false, releasesGobble: false, lineScore: 0,
    toWeight: CELL_WEIGHT[move.to[0]][move.to[1]],
  };
  if (!res.ok) return a;
  const ns = res.state;
  a.next = ns;
  a.win = ns.winner === p;
  a.handsWin = ns.winner === o; // e.g. a reveal that completes the opponent's line
  if (ns.winner === null) {
    a.ownThree = makesThreeInARow(ns, p);
    a.oppCanWin = allLegalMoves(ns, o).some((om) => {
      const r = applyMove(ns, om);
      return r.ok && r.state.winner === o;
    });
    a.lineScore = lineScore(ns, p);
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

// SHARED CLOSING MOVE: a move after which we have a winning reply to every
// opponent response — a forced win (typically a double threat, or a threat the
// opponent can neither block nor gobble). Candidates come from the safe pool, so
// they already don't hand the opponent an immediate win.
function forcedWin(state, p, pool) {
  const o = 1 - p;
  for (const a of pool) {
    if (!a.next || a.win) continue;
    const replies = allLegalMoves(a.next, o);
    if (!replies.length) continue;
    const unstoppable = replies.every((om) => {
      const r = applyMove(a.next, om);
      return r.ok && r.state.winner !== o && winningMove(r.state, p) !== null;
    });
    if (unstoppable) return a.move;
  }
  return null;
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
  // Block the opponent's immediate win if we can.
  const blocking = base.filter((a) => !a.oppCanWin);
  let pool = blocking.length ? blocking : base;
  // Keep our gobbles covered: don't lift a piece off an opponent piece unless
  // every remaining move would.
  const kept = pool.filter((a) => !a.releasesGobble);
  if (kept.length) pool = kept;

  // Shared closing move: force a win if one can be set up right now.
  const forced = forcedWin(state, player, pool);
  if (forced) return forced;

  // Shared: the rule-of-three reserve gobble saves a tempo for either style;
  // prefer the one that best advances our own lines.
  const reserveGobbles = pool.filter((a) => a.reserveGobble);
  if (reserveGobbles.length) return pickBest(reserveGobbles, (a) => a.lineScore);

  return type === 'speedrunner' ? speedrunner(state, player, pool) : gobbler(state, player, pool);
}

// Board bully: capture, control key squares, and develop lines.
function gobbler(state, p, pool) {
  // 1) Direct gobbles — one size down is the efficient capture; among gobbles,
  //    prefer the one that best improves our line development.
  const oneDown = pool.filter((a) => a.directGobble && a.movedSize - a.preySize === 1);
  if (oneDown.length) return pickBest(oneDown, (a) => a.lineScore);
  const anyGobble = pool.filter((a) => a.directGobble);
  if (anyGobble.length) return pickBest(anyGobble, (a) => a.lineScore);

  const reservesLeft = state.reserves[p].reduce((sum, n) => sum + n, 0);
  const placements = pool.filter((a) => a.move.type === 'place');
  if (placements.length) {
    // Level-load nudge: keep stacks even so big pieces stay available.
    const fullness = (a) => state.reserves[p][a.move.stack] * 0.1;
    if (reservesLeft > 6) {
      // Early: seize high-value squares and develop, but don't expose a
      // three-in-a-row to a rule-of-three gobble yet.
      const undefended = placements.filter((a) => !a.ownThree);
      const dev = undefended.length ? undefended : placements;
      return pickBest(dev, (a) => a.lineScore * 2 + a.toWeight + fullness(a));
    }
    // Late: build toward the win — favor placements that raise our line score
    // (making threes and setting up double threats).
    return pickBest(placements, (a) => a.lineScore * 3 + a.toWeight + fullness(a));
  }
  // Reserves spent: shuffle board pieces toward stronger lines.
  return pickBest(pool, (a) => a.lineScore);
}

// Line rusher: commit to one line and fill it fast, draining a single stack.
function speedrunner(state, p, pool) {
  const target = bestBuildLine(state, p);
  const placements = pool.filter((a) => a.move.type === 'place');

  if (target && placements.length) {
    const onLine = placements.filter((a) => inLine(target, a.move.to));
    // Extend the target line; among those, keep draining one stack (fewest left)
    // and prefer bigger pieces so the line is harder to gobble.
    if (onLine.length) {
      return pickBest(onLine, (a) => -state.reserves[p][a.move.stack] * 10 + a.movedSize);
    }
  }
  // Can't extend the line by placing: capture to advance, else keep dumping.
  const gobbles = pool.filter((a) => a.directGobble);
  if (gobbles.length) return pickBest(gobbles, (a) => a.lineScore);
  if (placements.length) {
    // Drain the most-drained non-empty stack (top-to-bottom, one at a time).
    return pickBest(placements, (a) => -state.reserves[p][a.move.stack]);
  }
  return pickBest(pool, (a) => a.lineScore);
}
