// Gobblet rules: legal-move generation, move application, win detection.
// Pure functions over the state shape defined in state.js.

import { BOARD_SIZE, top, reserveTopSize, cloneState } from './state.js';

let LINES = null;

// The 10 winning lines of a 4x4 board, as arrays of [row, col].
export function allLines() {
  if (!LINES) {
    LINES = [];
    for (let i = 0; i < BOARD_SIZE; i++) {
      LINES.push([0, 1, 2, 3].map((j) => [i, j]));
      LINES.push([0, 1, 2, 3].map((j) => [j, i]));
    }
    LINES.push([0, 1, 2, 3].map((i) => [i, i]));
    LINES.push([0, 1, 2, 3].map((i) => [i, BOARD_SIZE - 1 - i]));
  }
  return LINES;
}

export function findWinLine(state, player) {
  for (const line of allLines()) {
    if (line.every(([r, c]) => top(state.board[r][c])?.p === player)) return line;
  }
  return null;
}

// Rule of three: cells topped by `player` that belong to a line where that
// player has 3+ visible pieces. The opponent may gobble these directly from reserve.
function ruleOfThreeCells(state, player) {
  const cells = new Set();
  for (const line of allLines()) {
    const owned = line.filter(([r, c]) => top(state.board[r][c])?.p === player);
    if (owned.length >= 3) owned.forEach(([r, c]) => cells.add(r * BOARD_SIZE + c));
  }
  return cells;
}

// Reserve pieces may only go on empty squares, except onto a smaller opponent
// piece that is part of an opponent three-in-a-row (rule of three).
export function legalPlacements(state, player, size) {
  const targets = [];
  const threatCells = ruleOfThreeCells(state, 1 - player);
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const t = top(state.board[r][c]);
      if (!t) targets.push([r, c]);
      else if (t.p !== player && t.s < size && threatCells.has(r * BOARD_SIZE + c)) {
        targets.push([r, c]);
      }
    }
  }
  return targets;
}

// A piece already on the board may move to any other square that is empty or
// topped by a strictly smaller piece of either color.
export function legalBoardMoves(state, player, from) {
  const [fr, fc] = from;
  const piece = top(state.board[fr]?.[fc] ?? []);
  if (!piece || piece.p !== player) return [];
  const targets = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (r === fr && c === fc) continue;
      const t = top(state.board[r][c]);
      if (!t || t.s < piece.s) targets.push([r, c]);
    }
  }
  return targets;
}

// Every legal move available to a player, as move objects.
export function allLegalMoves(state, player) {
  const moves = [];
  for (let i = 0; i < state.reserves[player].length; i++) {
    const size = reserveTopSize(state, player, i);
    if (size === null) continue;
    for (const to of legalPlacements(state, player, size)) {
      moves.push({ type: 'place', stack: i, to });
    }
  }
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const t = top(state.board[r][c]);
      if (t && t.p === player) {
        for (const to of legalBoardMoves(state, player, [r, c])) {
          moves.push({ type: 'move', from: [r, c], to });
        }
      }
    }
  }
  return moves;
}

// A move for a player who ran out of time: place their biggest available
// reserve piece on a random legal square; fall back to any legal move.
export function randomMove(state, player) {
  let bestSize = -1;
  let bestStack = -1;
  for (let i = 0; i < state.reserves[player].length; i++) {
    const size = reserveTopSize(state, player, i);
    if (size !== null && size > bestSize) { bestSize = size; bestStack = i; }
  }
  if (bestStack >= 0) {
    const cells = legalPlacements(state, player, bestSize);
    if (cells.length) {
      return { type: 'place', stack: bestStack, to: cells[Math.floor(Math.random() * cells.length)] };
    }
  }
  const all = allLegalMoves(state, player);
  return all.length ? all[Math.floor(Math.random() * all.length)] : null;
}

// sel is either { kind:'reserve', stack } or { kind:'cell', from:[r,c] }.
export function legalTargetsFor(state, player, sel) {
  if (!sel) return [];
  if (sel.kind === 'reserve') {
    const size = reserveTopSize(state, player, sel.stack);
    return size === null ? [] : legalPlacements(state, player, size);
  }
  return legalBoardMoves(state, player, sel.from);
}

function err(error) {
  return { ok: false, error };
}

// Validates and applies a move for the current player. Returns { ok, state } or
// { ok:false, error }. Never mutates the input state. meta.ms (time the turn
// took) is recorded in the state's move log.
export function applyMove(state, move, meta = {}) {
  if (!state || state.winner !== null) return err('The game is over');
  if (!move || typeof move !== 'object') return err('Malformed move');
  const player = state.turn;
  const s = cloneState(state);
  let entry;

  if (move.type === 'place') {
    const stack = Number(move.stack);
    const [r, c] = [Number(move.to?.[0]), Number(move.to?.[1])];
    const size = reserveTopSize(s, player, stack);
    if (size === null) return err('That reserve stack is empty');
    if (!legalPlacements(s, player, size).some(([tr, tc]) => tr === r && tc === c)) {
      return err('Illegal placement');
    }
    s.reserves[player][stack] -= 1;
    s.board[r][c].push({ p: player, s: size });
    entry = { by: player, kind: 'place', size, from: null, to: [r, c], stack };
  } else if (move.type === 'move') {
    const from = [Number(move.from?.[0]), Number(move.from?.[1])];
    const [r, c] = [Number(move.to?.[0]), Number(move.to?.[1])];
    if (!legalBoardMoves(s, player, from).some(([tr, tc]) => tr === r && tc === c)) {
      return err('Illegal move');
    }
    const piece = s.board[from[0]][from[1]].pop();
    s.board[r][c].push(piece);
    entry = { by: player, kind: 'move', size: piece.s, from, to: [r, c], stack: null };
  } else {
    return err('Unknown move type');
  }

  entry.ms = Math.max(0, Math.round(Number(meta.ms) || 0));
  if (!Array.isArray(s.log)) s.log = [];
  s.log.push(entry);
  if (!Array.isArray(s.timeUsed)) s.timeUsed = [0, 0];
  s.timeUsed[player] += entry.ms;
  s.moveCount += 1;

  // Win detection. The opponent is checked first: if this move revealed (or
  // left standing) an opponent four-in-a-row, the opponent wins even if the
  // mover also completed a line.
  const opponent = 1 - player;
  const oppLine = findWinLine(s, opponent);
  if (oppLine) {
    s.winner = opponent;
    s.winLine = oppLine;
  } else {
    const myLine = findWinLine(s, player);
    if (myLine) {
      s.winner = player;
      s.winLine = myLine;
    } else {
      s.turn = opponent;
    }
  }
  return { ok: true, state: s };
}
