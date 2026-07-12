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
import { primeAudio, playMoveSound } from './ui/sound.js';
import { getTheme } from '../assets/themes.js';

const $ = (sel) => document.querySelector(sel);

let session = null; // { mode:'net'|'local', isHost, myPlayer, names:[p0,p1], state, pc, channel, ... }
let boardView = null;
let activeTheme = getTheme(getProfile().settings.theme);

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

// The connection dropped, but the game (and the host's room code) lives on:
// the host keeps accepting joins on the same code, and the guest can rejoin it.
function handleDisconnect() {
  if (!session || session.mode !== 'net') return;
  session.channel = null;
  if ($('#screen-game').classList.contains('hidden')) return;
  if (session.isHost) {
    showBanner(`${opponentName()} disconnected — they can rejoin with code ${session.code}`);
  } else {
    showBanner('Disconnected from the host');
    $('#btn-reconnect').classList.remove('hidden');
  }
}

function bindConn(conn) {
  session.channel = conn;
  conn.on('close', () => {
    if (session?.channel === conn) handleDisconnect();
  });
  conn.on('error', () => {
    if (session?.channel === conn) handleDisconnect();
  });
  onMessages(conn, {
    [MSG.START](msg) {
      session.state = msg.state;
      session.names = msg.names;
      session.rematch = { me: false, them: false };
      // A resume can replay an already-finished game — don't re-record it.
      session.recorded = msg.state.winner !== null;
      enterGame();
      maybeNotifyTurn();
    },
    [MSG.MOVE](msg) {
      if (!session.isHost) return;
      const res = applyMove(session.state, msg.move);
      const applied = res.ok;
      if (applied) session.state = res.state;
      // Broadcast authoritative state either way (resyncs the guest on rejects);
      // carry the move so the guest can animate it. by:1 = the guest moved.
      sendMsg(session.channel, {
        t: MSG.STATE, state: session.state, move: applied ? msg.move : null, by: 1,
      });
      if (applied) {
        presentOpponentMove(msg.move); // host watches the guest's move
        maybeNotifyTurn();
      }
    },
    [MSG.STATE](msg) {
      if (session.isHost) return;
      session.state = msg.state;
      // Animate only the opponent's moves — the guest's own move already showed
      // optimistically and just gets re-synced here.
      if (msg.move && msg.by !== session.myPlayer) presentOpponentMove(msg.move);
      else afterStateChange();
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

  // Random codes make collisions (including our own not-yet-expired ghost after
  // a refresh) a non-event: just draw a fresh code and try again.
  const mySession = session;
  let code, peer = null;
  for (let attempt = 1; !peer; attempt++) {
    code = makeCode();
    try {
      peer = await hostRoom(code);
    } catch (err) {
      if (session !== mySession) return; // user left the screen meanwhile
      if (err?.type === 'unavailable-id' && attempt < 5) continue;
      setStatus('#host-status', describePeerError(err), true);
      return;
    }
  }
  if (session !== mySession) { peer.destroy(); return; }
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
    if (!session?.isHost || session.channel?.open) { conn.close(); return; } // room is full
    session.names[1] = String(conn.metadata?.name || 'Guest').slice(0, 20);
    bindConn(conn);
    // A join with a game already underway is a reconnect — resume, don't reset.
    const begin = () => (session.state ? hostResumeGame() : hostStartGame());
    if (conn.open) begin();
    else conn.on('open', begin);
  });
  peer.on('disconnected', () => {
    // Broker link dropped. It's only needed to accept (re)joins, but rejoining
    // is exactly what makes the room code durable — so always restore it.
    if (session?.peer === peer) peer.reconnect();
  });
}

function hostStartGame() {
  session.state = newGame(Math.random() < 0.5 ? 0 : 1);
  sendMsg(session.channel, { t: MSG.START, state: session.state, names: session.names });
  enterGame();
}

function hostResumeGame() {
  session.rematch = { me: false, them: false };
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
  primeAudio(); // this click is our gesture to allow the move chime
  saveProfile({ name });
  const code = normalizeCode($('#join-code').value);
  if (!code) return setStatus('#join-status', 'Enter the 4-letter game code from the host.', true);

  teardown();
  session = {
    mode: 'net', isHost: false, myPlayer: 1,
    names: ['Host', name],
    rematch: { me: false, them: false }, recorded: false,
  };
  session.code = code;
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

// Guest-side rejoin after a drop: the host's room code is still registered,
// so joining it again resumes the game (the host re-sends the current state).
async function reconnectGuest() {
  if (!session || session.isHost || session.channel?.open) return;
  const btn = $('#btn-reconnect');
  btn.disabled = true;
  btn.textContent = 'Reconnecting…';
  try {
    session.peer?.destroy();
    const conn = await joinRoom(session.code, session.names[1]);
    session.peer = conn.provider;
    bindConn(conn);
    // The host's 'start' hides the banner and re-renders via enterGame().
  } catch (err) {
    showBanner(describePeerError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reconnect';
  }
}

// --- local pass & play ----------------------------------------------------------

function startLocal() {
  teardown();
  session = {
    mode: 'local', isHost: true, myPlayer: null,
    names: [...activeTheme.playerNames],
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
  if (session.mode === 'local') return true;
  // While disconnected, moves would silently diverge from the host — block them.
  return session.state.turn === session.myPlayer && session.channel?.open === true;
}

function mountBoard() {
  boardView = createBoardView($('#board-mount'), {
    theme: activeTheme,
    getState: () => session?.state,
    getBottomPlayer: bottomPlayer,
    canAct,
    getSettings: () => getProfile().settings,
    legalTargets: (sel) => legalTargetsFor(session.state, bottomPlayer(), sel),
    attemptMove: onLocalMoveAttempt,
  });
}

function enterGame() {
  show('screen-game');
  hideBanner();
  $('#btn-rematch').classList.add('hidden');
  $('#btn-reconnect').classList.add('hidden');
  mountBoard();
  afterStateChange();
}

// The opponent just moved: chime (if enabled) and slide the piece into place
// (if enabled) before settling on the new state.
function presentOpponentMove(move) {
  if (getProfile().settings.soundOnMove) playMoveSound();
  const animate = getProfile().settings.animateMoves && boardView
    && !$('#screen-game').classList.contains('hidden');
  if (animate) boardView.animateMove(move, afterStateChange);
  else afterStateChange();
}

function onLocalMoveAttempt(move) {
  const res = applyMove(session.state, move);
  if (!res.ok) return false;
  session.state = res.state;
  if (session.mode === 'net') {
    // by:0 = host moved. The guest's own move goes as a MOVE for the host to
    // validate; it already showed optimistically here.
    if (session.isHost) sendMsg(session.channel, { t: MSG.STATE, state: session.state, move, by: 0 });
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
  const dot = (p) => `<span class="dot" style="background:${activeTheme.colors[p]}"></span>`;
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

  const settingsDialog = initSettings($('#dlg-settings'), onSettingsChange);
  const historyDialog = $('#dlg-history');

  function onSettingsChange() {
    const desired = getProfile().settings.theme;
    if (desired !== activeTheme.id) {
      activeTheme = getTheme(desired);
      // Rebuild the board so the new theme's pieces render; keep game state.
      if (boardView && !$('#screen-game').classList.contains('hidden')) {
        mountBoard();
        renderHeader();
      }
    }
    boardView?.update();
  }

  // Prime audio from these gestures so the move chime can play later (autoplay).
  $('#btn-host').addEventListener('click', () => { primeAudio(); startHosting(); });
  $('#btn-join').addEventListener('click', () => startJoin(pendingInvite || ''));
  $('#btn-local').addEventListener('click', () => { primeAudio(); startLocal(); });
  $('#btn-settings').addEventListener('click', () => settingsDialog.open());
  $('#btn-game-settings').addEventListener('click', () => settingsDialog.open());
  $('#btn-game-rules').addEventListener('click', () => $('#dlg-rules').showModal());
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
  $('#btn-reconnect').addEventListener('click', reconnectGuest);
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
  // Tell the broker goodbye on refresh/close so our name frees immediately
  // instead of lingering until the broker's heartbeat timeout.
  window.addEventListener('pagehide', () => {
    try { session?.peer?.destroy(); } catch { /* already gone */ }
  });
  initNotifications();
  show('screen-home');
  checkInviteHash();
}

boot();
