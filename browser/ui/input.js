// Input handling for the board: drag-and-drop mode and tap-to-select mode.
// Talks to the board view through a small interface (see board.js).

function sameSel(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'reserve') return a.stack === b.stack;
  return a.from[0] === b.from[0] && a.from[1] === b.from[1];
}

export function attachInput(root, view) {
  root.addEventListener('pointerdown', (e) => {
    if (view.settings().inputMode !== 'drag' || !view.canAct()) return;
    const srcEl = e.target.closest('[data-src]');
    if (!srcEl || !root.contains(srcEl)) return;
    const sel = view.sourceFromEl(srcEl);
    if (!sel) return;
    e.preventDefault();
    startDrag(e, sel, srcEl);
  });

  root.addEventListener('click', (e) => {
    if (view.settings().inputMode !== 'tap' || !view.canAct()) return;
    const current = view.getSelection();
    const cellEl = e.target.closest('.cell');

    // A cell can be both a legal destination and a selectable own piece
    // (gobbling your own smaller piece); the move takes precedence.
    if (current && cellEl) {
      const to = [Number(cellEl.dataset.r), Number(cellEl.dataset.c)];
      if (view.isLegalTarget(current, to)) {
        view.attempt(current, to);
        view.setSelection(null);
        return;
      }
    }
    const srcEl = e.target.closest('[data-src]');
    if (srcEl) {
      const sel = view.sourceFromEl(srcEl);
      if (sel) {
        view.setSelection(sameSel(current, sel) ? null : sel);
        return;
      }
    }
    if (current) view.setSelection(null);
  });

  function startDrag(e, sel, srcEl) {
    const pieceEl = srcEl.querySelector('.piece');
    if (!pieceEl) return;
    const rect = pieceEl.getBoundingClientRect();
    const ghost = pieceEl.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.classList.remove('dragging', 'selected');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.append(ghost);

    const place = (ev) => {
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;
    };
    place(e);
    view.setSelection(sel); // marks the source piece and highlights targets

    const onMove = (ev) => {
      ev.preventDefault();
      place(ev);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      ghost.remove();
      view.setSelection(null);
    };
    const onCancel = () => cleanup();
    const onUp = (ev) => {
      const overEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const cellEl = overEl && overEl.closest('.cell');
      cleanup();
      if (cellEl) {
        view.attempt(sel, [Number(cellEl.dataset.r), Number(cellEl.dataset.c)]);
      }
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }
}
