// Lobby helpers: share buttons for invite/reply codes and the history dialog.

import { getHistory } from '../storage/history.js';

// Fills a container with Share / Email / Text / Copy buttons for a payload.
// opts: { text (human message), url (optional link carrying the code), subject }
export function initShareButtons(container, { text, url, subject }) {
  container.innerHTML = '';
  const full = url ? `${text}\n${url}` : text;
  const add = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-small';
    b.textContent = label;
    b.addEventListener('click', () => onClick(b));
    container.append(b);
  };

  if (navigator.share) {
    add('Share…', async () => {
      try {
        await navigator.share(url ? { title: 'Gobblet', text, url } : { title: 'Gobblet', text: full });
      } catch { /* user dismissed the share sheet */ }
    });
  }
  add('Email', () => {
    location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(full)}`;
  });
  add('Text', () => {
    location.href = `sms:?&body=${encodeURIComponent(full)}`;
  });
  add('Copy', async (btn) => {
    try {
      await navigator.clipboard.writeText(full);
      const old = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch { /* clipboard unavailable */ }
  });
}

export function renderHistory(container) {
  const { opponents } = getHistory();
  const names = Object.keys(opponents);
  if (!names.length) {
    container.innerHTML = '<p class="hint">No games played yet. Beat someone!</p>';
    return;
  }
  const latest = (n) => opponents[n].games[opponents[n].games.length - 1]?.date || '';
  names.sort((a, b) => latest(b).localeCompare(latest(a)));

  container.innerHTML = names.map((name) => {
    const games = opponents[name].games;
    const wins = games.filter((g) => g.result === 'win').length;
    const rows = games.slice().reverse().map((g) => {
      const date = new Date(g.date).toLocaleDateString();
      const role = g.iHosted ? 'hosted' : 'joined';
      const result = g.result === 'win' ? 'Won' : 'Lost';
      return `<li><span>${date} · ${role} · ${g.moveCount} moves</span><b class="${g.result}">${result}</b></li>`;
    }).join('');
    return `<details class="opp">
      <summary><b>${escapeHTML(name)}</b><span>${wins}–${games.length - wins}</span></summary>
      <ul>${rows}</ul>
    </details>`;
  }).join('');
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
