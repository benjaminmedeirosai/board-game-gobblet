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

export function cloneState(state) {
  return structuredClone(state);
}
