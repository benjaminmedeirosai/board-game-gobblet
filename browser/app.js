// App orchestrator: screen flow, session lifecycle (host / join / local),
// and the glue between the rules engine, board view, and data channel.

import { newGame } from './game/state.js';
import { applyMove, legalTargetsFor } from './game/rules.js';
import { makeCode, normalizeCode, hostRoom, joinRoom, describePeerError } from './net/peer.js';
import { MSG, sendMsg, onMessages } from './net/protocol.js';
import { getProfile, saveProfile, recordGame } from './storage/history.js';
import { createBoardView } from './ui/board.js';
import { initShareButtons, renderHistory } from './ui/lobby.js';
import { initSettings } from './ui/settings.js';
import { initNotifications, notifyIfHidden } from './ui/notify.js';
import theme from '../assets/classic/theme.js';

const $ = (sel) => document.querySelector(sel);

let session = null; // { mode:'net'|'local', isHost, myPlayer, names:[p0,p1], state, pc, channel, ... }
let boardView = null;

// --- screens ----------------------------------------------------------------

function show(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('hidden', el.id !== id));
}

function setStatus(sel, text, isError = false) {
  const el = $(sel);
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function myName() {
  const name = $('#my-name').value.trim();
  if (!name) {
    $('#my-name').focus();
    setStatus('#home-status', 'Enter your name first', true);
  }
  return name;
}

// --- session lifecycle --------------------------------------------------------

function teardown() {
  if (session?.peer) {
    try { session.peer.destroy(); } catch { /* already destroyed */ }
  }
  session = null;
  boardView = null;
}

function maybeNotifyTurn() {
  if (session?.mode !== 'net' || !getProfile().settings.notifyTurns) return;
  const s = session.state;
  if (s.winner !== null) {
    notifyIfHidden('Gobblet', s.winner === session.myPlayer
      ? `You beat ${opponentName()}! 🏆`
      : `${opponentName()} won the game`);
  } else if (s.turn === session.myPlayer) {
    notifyIfHidden('Gobblet', `${opponentName()} moved — your turn!`);
  }
}

function goHome() {
  teardown();
  setStatus('#home-status', '');
  show('screen-home');
}

function bindConn(conn) {
  session.channel = conn;
  conn.on('close', () => {
    if (session && !$('#screen-game').classList.contains('hidden')) {
      showBanner('Opponent disconnected');
    }
  });
  conn.on('error', () => {
    if (session && !$('#screen-game').classList.contains('hidden')) {
      showBanner('Connection lost');
    }
  });
  onMessages(conn, {
    [MSG.START](msg) {
      session.state = msg.state;
      session.names = msg.names;
      session.rematch = { me: false, them: false };
      session.recorded = false;
      enterGame();
      maybeNotifyTurn();
    },
    [MSG.MOVE](msg) {
      if (!session.isHost) return;
      const res = applyMove(session.state, msg.move);
      if (res.ok) session.state = res.state;
      // Broadcast authoritative state either way (resyncs the guest on rejects).
      sendMsg(session.channel, { t: MSG.STATE, state: session.state });
      if (res.ok) {
        afterStateChange();
        maybeNotifyTurn();
      }
    },
    [MSG.STATE](msg) {
      if (session.isHost) return;
      session.state = msg.state;
      afterStateChange();
      maybeNotifyTurn();
    },
    [MSG.REMATCH]() {
      session.rematch.them = true;
      if (!session.rematch.me) showBanner(`${opponentName()} wants a rematch`);
      maybeRematch();
    },
  });
}

function opponentName() {
  return session.names[1 - session.myPlayer] || 'Opponent';
}

// --- hosting ------------------------------------------------------------------

async function startHosting() {
  const name = myName();
  if (!name) return;
  saveProfile({ name });
  teardown();
  session = {
    mode: 'net', isHost: true, myPlayer: 0, names: [name, ''],
    rematch: { me: false, them: false }, recorded: false,
  };
  show('screen-host');
  $('#host-code').textContent = '····';
  $('#host-share').innerHTML = '';
  setStatus('#host-status', 'Creating game…');

  // Register a room code with the broker; retry on the rare code collision.
  let code, peer;
  for (let attempt = 0; attempt < 3; attempt++) {
    code = makeCode();
    try {
      peer = await hostRoom(code);
      break;
    } catch (err) {
      if (err?.type !== 'unavailable-id' || attempt === 2) {
        setStatus('#host-status', describePeerError(err), true);
        return;
      }
    }
  }
  if (!session?.isHost) { peer.destroy(); return; } // user left the screen meanwhile
  session.peer = peer;
  session.code = code;
  $('#host-code').textContent = code;
  const url = `${location.origin}${location.pathname}#j=${code}`;
  initShareButtons($('#host-share'), {
    text: `${name} is inviting you to a game of Gobblet! Game code: ${code}`,
    url,
    subject: 'Gobblet game invite',
  });
  setStatus('#host-status', 'Waiting for your friend to join…');

  peer.on('connection', (conn) => {
    if (session?.channel) { conn.close(); return; } // room is full
    session.names[1] = String(conn.metadata?.name || 'Guest').slice(0, 20);
    bindConn(conn);
    if (conn.open) hostStartGame();
    else conn.on('open', hostStartGame);
  });
  peer.on('disconnected', () => {
    // Broker link dropped (it is only needed for new joins) — try to restore it.
    if (session?.peer === peer && !session.channel) peer.reconnect();
  });
}

function hostStartGame() {
  session.state = newGame(Math.random() < 0.5 ? 0 : 1);
  sendMsg(session.channel, { t: MSG.START, state: session.state, names: session.names });
  enterGame();
}

// --- joining ------------------------------------------------------------------

function startJoin(prefill = '') {
  show('screen-join');
  setStatus('#join-status', '');
  if (prefill) $('#join-code').value = prefill;
}

async function joinByCode() {
  const name = myName();
  if (!name) { show('screen-home'); return; }
  saveProfile({ name });
  const code = normalizeCode($('#join-code').value);
  if (!code) return setStatus('#join-status', 'Enter the 4-character game code from the host.', true);

  teardown();
  session = {
    mode: 'net', isHost: false, myPlayer: 1,
    names: ['Host', name],
    rematch: { me: false, them: false }, recorded: false,
  };
  setStatus('#join-status', 'Connecting…');
  try {
    const conn = await joinRoom(code, name);
    if (!session || session.isHost) { conn.close(); return; }
    session.peer = conn.provider;
    bindConn(conn);
    setStatus('#join-status', 'Connected — starting game…');
    // The host's 'start' message carries the state and both names.
  } catch (err) {
    setStatus('#join-status', describePeerError(err), true);
  }
}

// --- local pass & play ----------------------------------------------------------

function startLocal() {
  teardown();
  session = {
    mode: 'local', isHost: true, myPlayer: null,
    names: [...theme.playerNames],
    state: newGame(0), recorded: true, // local games aren't recorded
    rematch: { me: false, them: false },
  };
  enterGame();
}

// --- game screen ----------------------------------------------------------------

function bottomPlayer() {
  // Net: always the local player. Local: whoever's turn it is (pass & play).
  return session.mode === 'net' ? session.myPlayer : session.state.turn;
}

function canAct() {
  if (!session?.state || session.state.winner !== null) return false;
  return session.mode === 'local' || session.state.turn === session.myPlayer;
}

function enterGame() {
  show('screen-game');
  hideBanner();
  $('#btn-rematch').classList.add('hidden');
  boardView = createBoardView($('#board-mount'), {
    theme,
    getState: () => session?.state,
    getBottomPlayer: bottomPlayer,
    canAct,
    getSettings: () => getProfile().settings,
    legalTargets: (sel) => legalTargetsFor(session.state, bottomPlayer(), sel),
    attemptMove: onLocalMoveAttempt,
  });
  afterStateChange();
}

function onLocalMoveAttempt(move) {
  const res = applyMove(session.state, move);
  if (!res.ok) return false;
  session.state = res.state;
  if (session.mode === 'net') {
    if (session.isHost) sendMsg(session.channel, { t: MSG.STATE, state: session.state });
    else sendMsg(session.channel, { t: MSG.MOVE, move });
  }
  afterStateChange();
  return true;
}

function afterStateChange() {
  if (!session?.state) return;
  boardView?.update();
  renderHeader();
  const { winner } = session.state;
  if (winner === null) return;

  if (!session.recorded) {
    session.recorded = true;
    recordGame({
      opponent: opponentName(),
      iHosted: session.isHost,
      result: winner === session.myPlayer ? 'win' : 'loss',
      moveCount: session.state.moveCount,
    });
  }
  if (session.mode === 'local') {
    showBanner(`${session.names[winner]} wins! 🏆`);
  } else {
    showBanner(winner === session.myPlayer ? 'You win! 🏆' : `${opponentName()} wins`);
  }
  $('#btn-rematch').classList.remove('hidden');
}

function renderHeader() {
  const s = session.state;
  const dot = (p) => `<span class="dot" style="background:${theme.colors[p]}"></span>`;
  // A round is one move by each player; it advances after both have moved.
  const round = ` · R${Math.floor(s.moveCount / 2) + 1}`;
  if (session.mode === 'local') {
    $('#game-players').innerHTML = `${dot(s.turn)} <b>${escape(session.names[s.turn])}</b>`;
    $('#game-turn').textContent = s.winner === null ? `to move${round}` : '';
  } else {
    const mine = s.turn === session.myPlayer;
    $('#game-players').innerHTML =
      `${dot(session.myPlayer)} <b>${escape(session.names[session.myPlayer])}</b> vs ` +
      `${dot(1 - session.myPlayer)} <b>${escape(opponentName())}</b>`;
    $('#game-turn').textContent = s.winner !== null ? ''
      : (mine ? `Your turn${round}` : `${opponentName()}’s turn${round}`);
  }
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function showBanner(text) {
  $('#game-banner').textContent = text;
  $('#game-banner').classList.remove('hidden');
}

function hideBanner() {
  $('#game-banner').classList.add('hidden');
}

function requestRematch() {
  if (session.mode === 'local') {
    session.state = newGame(session.state.winner === 0 ? 1 : 0);
    hideBanner();
    $('#btn-rematch').classList.add('hidden');
    afterStateChange();
    return;
  }
  session.rematch.me = true;
  sendMsg(session.channel, { t: MSG.REMATCH });
  showBanner(session.rematch.them ? 'Starting rematch…' : `Waiting for ${opponentName()}…`);
  maybeRematch();
}

function maybeRematch() {
  if (!session.rematch.me || !session.rematch.them) return;
  if (session.isHost) {
    // Loser of the last game moves first; random if somehow unset.
    const first = session.state?.winner !== null ? 1 - session.state.winner : (Math.random() < 0.5 ? 0 : 1);
    session.state = newGame(first);
    session.rematch = { me: false, them: false };
    session.recorded = false;
    sendMsg(session.channel, { t: MSG.START, state: session.state, names: session.names });
    enterGame();
  }
  // Guest waits for the host's 'start'.
}

// --- boot ------------------------------------------------------------------------

function boot() {
  const profile = getProfile();
  $('#my-name').value = profile.name;
  $('#my-name').addEventListener('change', () => saveProfile({ name: $('#my-name').value.trim() }));

  const settingsDialog = initSettings($('#dlg-settings'), () => boardView?.update());
  const historyDialog = $('#dlg-history');

  $('#btn-host').addEventListener('click', () => { startHosting(); });
  $('#btn-join').addEventListener('click', () => startJoin(pendingInvite || ''));
  $('#btn-local').addEventListener('click', startLocal);
  $('#btn-settings').addEventListener('click', () => settingsDialog.open());
  $('#btn-game-settings').addEventListener('click', () => settingsDialog.open());
  $('#btn-history').addEventListener('click', () => {
    renderHistory($('#history-list'));
    historyDialog.showModal();
  });
  $('#btn-history-close').addEventListener('click', () => historyDialog.close());
  $('#btn-rules').addEventListener('click', () => $('#dlg-rules').showModal());
  $('#btn-rules-close').addEventListener('click', () => $('#dlg-rules').close());
  $('#btn-join-go').addEventListener('click', joinByCode);
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinByCode(); });
  $('#btn-rematch').addEventListener('click', requestRematch);
  $('#btn-leave').addEventListener('click', goHome);
  document.querySelectorAll('.btn-back').forEach((b) => b.addEventListener('click', goHome));

  // Arriving via an invite link (index.html#j=<room code>) — either on a fresh
  // page load or via a hash-only navigation when the app is already open.
  let pendingInvite = null;
  function checkInviteHash() {
    const m = location.hash.match(/^#j=(.+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    pendingInvite = normalizeCode(m[1]);
    if (!pendingInvite) return;
    if ($('#screen-home').classList.contains('hidden')) goHome();
    setStatus('#home-status', 'Game invite detected — enter your name and tap Join Game.');
  }
  window.addEventListener('hashchange', checkInviteHash);
  initNotifications();
  show('screen-home');
  checkInviteHash();
}

boot();
