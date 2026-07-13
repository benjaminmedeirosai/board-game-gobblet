// Core game state for Gobblet. Pure data + helpers, no DOM or network.

export const BOARD_SIZE = 4;
export const STACKS_PER_PLAYER = 3;
export const PIECES_PER_STACK = 4;
export const SIZE_NAMES = ['S', 'M', 'L', 'XL'];

// Board cells are stacks of pieces, bottom to top. A piece is { p: 0|1, s: 0..3 }.
// Reserves track how many pieces remain in each of a player's 3 nested stacks;
// the exposed (playable) piece of a reserve stack is always its largest: size = count - 1.
export function newGame(firstPlayer = 0) {
  return {
    board: Array.from({ length: BOARD_SIZE }, () =>
      Array.from({ length: BOARD_SIZE }, () => [])),
    reserves: [
      Array(STACKS_PER_PLAYER).fill(PIECES_PER_STACK),
      Array(STACKS_PER_PLAYER).fill(PIECES_PER_STACK),
    ],
    turn: firstPlayer,
    winner: null,
    winLine: null,
    moveCount: 0,
    // Per-move record: { by, kind:'place'|'move', size, from, to, stack, ms }.
    log: [],
    // Cumulative thinking time per player (ms), for the tug-of-war clock.
    timeUsed: [0, 0],
  };
}

export function top(cell) {
  return cell.length ? cell[cell.length - 1] : null;
}

export function reserveTopSize(state, player, stack) {
  const count = state.reserves[player]?.[stack];
  return count > 0 ? count - 1 : null;
}

// Deep clone of a game state. The shape is fixed and shallow (a grid of small
// {p,s} pieces, number arrays, and a log of flat records), so a hand-rolled copy
// is dramatically faster than structuredClone — which matters because the AI
// clones a state for every hypothetical move in its look-ahead.
export function cloneState(state) {
  const board = new Array(state.board.length);
  for (let r = 0; r < state.board.length; r++) {
    const row = state.board[r];
    const nrow = new Array(row.length);
    for (let c = 0; c < row.length; c++) {
      const stack = row[c];
      const ns = new Array(stack.length);
      for (let i = 0; i < stack.length; i++) ns[i] = { p: stack[i].p, s: stack[i].s };
      nrow[c] = ns;
    }
    board[r] = nrow;
  }
  const log = new Array(state.log ? state.log.length : 0);
  for (let i = 0; i < log.length; i++) {
    const e = state.log[i];
    log[i] = {
      by: e.by, kind: e.kind, size: e.size,
      from: e.from ? [e.from[0], e.from[1]] : null,
      to: e.to ? [e.to[0], e.to[1]] : null,
      stack: e.stack, ms: e.ms,
    };
  }
  return {
    ...state,
    board,
    reserves: [state.reserves[0].slice(), state.reserves[1].slice()],
    winLine: state.winLine ? state.winLine.map(([r, c]) => [r, c]) : null,
    log,
    timeUsed: state.timeUsed ? state.timeUsed.slice() : [0, 0],
    gameSettings: state.gameSettings ? { ...state.gameSettings } : state.gameSettings,
  };
}
