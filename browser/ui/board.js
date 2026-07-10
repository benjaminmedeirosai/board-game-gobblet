// Board view: renders the 4x4 grid plus both players' reserve stacks, and
// exposes the selection/legality hooks the input layer drives.

import { BOARD_SIZE, top, reserveTopSize } from '../game/state.js';
import { attachInput } from './input.js';

// ctx: {
//   theme,
//   getState()        -> game state (or null)
//   getBottomPlayer() -> player index rendered at the bottom / allowed to act
//   canAct()          -> is local interaction allowed right now
//   getSettings()     -> { highlightMoves, inputMode }
//   legalTargets(sel) -> [[r,c], ...]
//   attemptMove(move) -> boolean (move was accepted)
// }
export function createBoardView(mount, ctx) {
  mount.innerHTML = `
    <div class="board-wrap">
      <div class="reserve reserve-top"></div>
      <div class="grid"></div>
      <div class="reserve reserve-bottom"></div>
    </div>`;
  const wrap = mount.querySelector('.board-wrap');
  const grid = mount.querySelector('.grid');
  const reserveTop = mount.querySelector('.reserve-top');
  const reserveBottom = mount.querySelector('.reserve-bottom');

  let selection = null;

  function pieceHTML(player, size, extraClass = '') {
    const scale = ctx.theme.sizeScale[size];
    return `<div class="piece ${extraClass}" style="width:${scale * 100}%;height:${scale * 100}%">${ctx.theme.pieceSVG(player, size)}</div>`;
  }

  function selectedClass() {
    return ctx.getSettings().inputMode === 'drag' ? 'dragging' : 'selected';
  }

  function reserveHTML(state, player, interactive) {
    const act = interactive && ctx.canAct();
    let html = '';
    for (let i = 0; i < state.reserves[player].length; i++) {
      const size = reserveTopSize(state, player, i);
      const count = state.reserves[player][i];
      const selHere = interactive && selection?.kind === 'reserve' && selection.stack === i;
      const src = act && size !== null ? ` data-src="reserve" data-stack="${i}"` : '';
      html += `<div class="stack${selHere ? ' sel' : ''}"${src}>` +
        (size !== null ? pieceHTML(player, size, selHere ? selectedClass() : '') : '') +
        `<span class="count">${count}</span></div>`;
    }
    return html;
  }

  function update() {
    const state = ctx.getState();
    if (!state) return;
    const me = ctx.getBottomPlayer();
    const act = ctx.canAct();
    const highlight = ctx.getSettings().highlightMoves;
    const targets = selection ? ctx.legalTargets(selection) : [];
    const isTarget = (r, c) => targets.some(([tr, tc]) => tr === r && tc === c);
    const winSet = new Set((state.winLine || []).map(([r, c]) => r * BOARD_SIZE + c));

    let g = '';
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const t = top(state.board[r][c]);
        const classes = ['cell'];
        if (highlight && selection && isTarget(r, c)) classes.push('target');
        if (winSet.has(r * BOARD_SIZE + c)) classes.push('win');
        const src = act && t && t.p === me ? ' data-src="cell"' : '';
        const selHere = selection?.kind === 'cell' &&
          selection.from[0] === r && selection.from[1] === c;
        const inner = t ? pieceHTML(t.p, t.s, selHere ? selectedClass() : '') : '';
        g += `<div class="${classes.join(' ')}" data-r="${r}" data-c="${c}"${src}>${inner}</div>`;
      }
    }
    grid.innerHTML = g;
    reserveTop.innerHTML = reserveHTML(state, 1 - me, false);
    reserveBottom.innerHTML = reserveHTML(state, me, true);
  }

  const view = {
    update,
    getSelection: () => selection,
    setSelection(sel) {
      selection = sel;
      update();
    },
    settings: () => ctx.getSettings(),
    canAct: () => ctx.canAct(),
    sourceFromEl(el) {
      const state = ctx.getState();
      if (!state) return null;
      const me = ctx.getBottomPlayer();
      if (el.dataset.src === 'reserve') {
        const stack = Number(el.dataset.stack);
        return reserveTopSize(state, me, stack) === null ? null : { kind: 'reserve', stack };
      }
      if (el.dataset.src === 'cell') {
        const from = [Number(el.dataset.r), Number(el.dataset.c)];
        const t = top(state.board[from[0]][from[1]]);
        return t && t.p === me ? { kind: 'cell', from } : null;
      }
      return null;
    },
    isLegalTarget(sel, [r, c]) {
      return ctx.legalTargets(sel).some(([tr, tc]) => tr === r && tc === c);
    },
    attempt(sel, to) {
      if (!view.isLegalTarget(sel, to)) return false;
      const move = sel.kind === 'reserve'
        ? { type: 'place', stack: sel.stack, to }
        : { type: 'move', from: sel.from, to };
      return ctx.attemptMove(move);
    },
  };

  attachInput(wrap, view);
  update();
  return view;
}
