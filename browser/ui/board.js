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
  let animating = false;

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

  function update(stateOverride) {
    const state = stateOverride || ctx.getState();
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

  function cellEl(r, c) {
    return grid.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
  }

  // For a placement, the source is a reserve stack — the top row for an
  // opponent's move, the bottom row when animating the local player's own move
  // (fromBottom). For a board move it's the origin cell either way.
  function sourceEl(move, fromBottom) {
    if (move.type !== 'place') return cellEl(move.from[0], move.from[1]);
    return (fromBottom ? reserveBottom : reserveTop).children[move.stack];
  }

  // Fly a ghost element from one rect's center to another's over ~1.15s, then
  // call done(). Blocks input while in flight.
  function flyGhost(ghost, from, to, hideEl, done) {
    ghost.classList.add('ghost');
    ghost.style.width = `${from.width}px`;
    ghost.style.height = `${from.height}px`;
    ghost.style.transform = 'translate(-50%, -50%)';
    ghost.style.left = `${from.left + from.width / 2}px`;
    ghost.style.top = `${from.top + from.height / 2}px`;
    document.body.append(ghost);
    if (hideEl) hideEl.style.visibility = 'hidden';
    animating = true;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      animating = false;
      ghost.remove();
      done();
    };
    // Commit the start position with a forced reflow BEFORE applying the
    // transition and end position. Without this, some engines (notably Samsung
    // Internet) fold both style changes into a single paint and the piece jumps
    // instantly instead of gliding — the Replay path only worked by accident,
    // because its board re-render flushed layout first.
    void ghost.getBoundingClientRect();
    ghost.style.transition = 'left 1.15s cubic-bezier(0.35, 0, 0.2, 1), top 1.15s cubic-bezier(0.35, 0, 0.2, 1)';
    ghost.style.left = `${to.left + to.width / 2}px`;
    ghost.style.top = `${to.top + to.height / 2}px`;
    ghost.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 1500); // safety net if transitionend never fires
  }

  // Slide the moving piece from source to destination, then call done(). Must
  // be invoked while the board still shows the pre-move state; done() re-renders
  // the settled state. Falls back to an instant done() if endpoints are missing.
  function animateMove(move, done, fromBottom = false) {
    const dest = cellEl(move.to[0], move.to[1]);
    const srcPiece = sourceEl(move, fromBottom)?.querySelector('.piece');
    if (!srcPiece || !dest) { done(); return; }
    const ghost = srcPiece.cloneNode(true);
    ghost.classList.remove('dragging', 'selected');
    flyGhost(ghost, srcPiece.getBoundingClientRect(), dest.getBoundingClientRect(), srcPiece, done);
  }

  // Replay the last move for review: rewind the board to how it looked BEFORE
  // the move (revealing what was about to be gobbled), fly the piece in again,
  // then settle back to the current state — so you can see if you got gobbled.
  // prevState is the reconstructed pre-move state; game state is never touched.
  function replayMove(entry, prevState) {
    if (animating || !prevState) return;
    update(prevState); // show the board as it was before the move
    const dest = cellEl(entry.to[0], entry.to[1]);
    const mine = entry.by === ctx.getBottomPlayer();
    const reserveEl = mine ? reserveBottom : reserveTop;
    const srcEl = entry.kind === 'place'
      ? reserveEl.children[entry.stack]
      : cellEl(entry.from[0], entry.from[1]);
    const srcPiece = srcEl?.querySelector('.piece');
    if (!srcPiece || !dest) { update(); return; }
    const ghost = srcPiece.cloneNode(true);
    ghost.classList.remove('dragging', 'selected');
    // On landing, re-render the real (settled) state so the piece covers its prey.
    flyGhost(ghost, srcPiece.getBoundingClientRect(), dest.getBoundingClientRect(), srcPiece, () => update());
  }

  const view = {
    update,
    animateMove,
    replayMove,
    getSelection: () => selection,
    setSelection(sel) {
      selection = sel;
      update();
    },
    settings: () => ctx.getSettings(),
    canAct: () => !animating && ctx.canAct(),
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
