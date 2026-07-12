// App orchestrator: screen flow, session lifecycle (host / join / local),
// and the glue between the rules engine, board view, and data channel.

import { newGame, SIZE_NAMES } from './game/state.js';
import { applyMove, legalTargetsFor, randomMove } from './game/rules.js';
import { chooseMove } from './game/ai.js';
import { makeCode, normalizeCode, hostRoom, joinRoom, describePeerError } from './net/peer.js';
import { MSG, sendMsg, onMessages } from './net/protocol.js';
import { getProfile, saveProfile, recordGame, gameSettingsFrom } from './storage/history.js';
import { createBoardView } from './ui/board.js';
import { initShareButtons, renderHistory } from './ui/lobby.js';
import { initPreferences, initGameSettings } from './ui/settings.js';
import { initNotifications, notifyIfHidden } from './ui/notify.js';
import { primeAudio, playSound } from './ui/sound.js';
import { getTheme } from '../assets/themes.js';

const $ = (sel) => document.querySelector(sel);

let session = null; // { mode:'net'|'local', isHost, myPlayer, names:[p0,p1], state, pc, channel, ... }
let boardView = null;
let activeTheme = getTheme(getProfile().settings.theme);

// Board size is a display preference; drive it through a CSS var on #app.
function applyBoardScale() {
  const v = Number(getProfile().settings.boardScale) || 1;
  $('#app').style.setProperty('--board-scale', String(v));
}

// New game that captures the host's game settings, which then govern the whole
// game for both players (they ride along in the synced state).
function newSessionGame(firstPlayer) {
  const s = newGame(firstPlayer);
  s.gameSettings = gameSettingsFrom(getProfile().settings);
  return s;
}

// The game settings governing the current game (host's, synced), or this
// device's defaults before a game exists.
function gameSettings() {
  return session?.state?.gameSettings || gameSettingsFrom(getProfile().settings);
}

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
  if (session) {
    session.conns?.forEach((_info, conn) => { try { conn.close(); } catch { /* closed */ } });
    try { session.hostConn?.close(); } catch { /* closed */ }
    try { session.peer?.destroy(); } catch { /* already destroyed */ }
  }
  stopTurnClock();
  session = null;
  boardView = null;
}

// --- turn clock: counts up how long the current turn has lasted ---------------

const turnClock = { timer: null, lastMove: -1, autoFired: false };

function stopTurnClock() {
  if (turnClock.timer) { clearInterval(turnClock.timer); turnClock.timer = null; }
  turnClock.lastMove = -1;
}

function clock(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// How long the current turn has run, in whole seconds.
function turnElapsed() {
  return Math.max(0, Math.floor((Date.now() - (session?.turnStart || Date.now())) / 1000));
}

// Cumulative thinking time per player (ms), including the current turn in
// progress — the basis for the tug-of-war clock.
function liveTimeUsed() {
  const t = [...(session.state.timeUsed || [0, 0])];
  if (session.state.winner === null && session.turnStart) {
    t[session.state.turn] += Math.max(0, Date.now() - session.turnStart);
  }
  return t;
}

function renderTug(threshold) {
  const t = liveTimeUsed();
  const [left, right] = session.mode === 'net'
    ? [session.myPlayer, 1 - session.myPlayer] : [0, 1];
  const nameOf = (p) => session.names[p] || activeTheme.playerNames[p] || `P${p + 1}`;
  $('#tug-left').innerHTML = `${colorDot(left)} ${escape(nameOf(left))}`;
  $('#tug-right').innerHTML = `${escape(nameOf(right))} ${colorDot(right)}`;
  const deltaSec = (t[left] - t[right]) / 1000; // + => left has used more time
  const frac = Math.max(-1, Math.min(1, deltaSec / threshold));
  const marker = $('#tug-marker');
  marker.style.left = `${50 - frac * 50}%`; // 0% = left edge (left in danger)
  const mag = Math.abs(frac);
  marker.dataset.zone = mag < 0.5 ? 'safe' : (mag < 0.8 ? 'warn' : 'danger');
  const lead = deltaSec >= 0 ? left : right; // who has used more time
  $('#tug-note').textContent = Math.abs(deltaSec) < 0.1
    ? `Even — lose at ${threshold}s behind`
    : `${nameOf(lead)} +${Math.abs(deltaSec).toFixed(1)}s (loses at ${threshold}s)`;
}

function renderTimerDisplay(gs) {
  const timerEl = $('#game-timer');
  const tug = $('#tug-wrap');
  if (gs.timerMode === 'tug') {
    timerEl.classList.add('hidden');
    tug.classList.remove('hidden');
    renderTug(gs.timerThreshold);
  } else {
    tug.classList.add('hidden');
    timerEl.classList.remove('hidden');
    const elapsed = turnElapsed();
    const limit = gs.timerMode === 'perturn' ? gs.timerThreshold : 0;
    const over = limit > 0 && elapsed >= limit;
    timerEl.textContent = limit > 0 ? `⏱ ${clock(elapsed)} / ${clock(limit)}` : `⏱ ${clock(elapsed)}`;
    timerEl.classList.toggle('over', over);
  }
}

function tickTurnClock() {
  if (!session?.state) return;
  const gs = gameSettings();
  renderTimerDisplay(gs);

  // Local vs-computer tug-of-war: resolve it in BOTH directions here, since the
  // human isn't "acting" during the computer's turn and nothing else watches the
  // computer's clock. Whoever has fallen behind by the threshold loses.
  if (session.mode === 'ai' && gs.timerMode === 'tug' && !turnClock.autoFired) {
    const t = liveTimeUsed();
    const lead = (t[session.human] - t[session.aiPlayer]) / 1000;
    if (lead >= gs.timerThreshold) { turnClock.autoFired = true; endByTimeout(session.human); }
    else if (-lead >= gs.timerThreshold) { turnClock.autoFired = true; endByTimeout(session.aiPlayer); }
    return;
  }

  // Enforce the timeout consequence. Only the client controlling the current
  // player acts (canAct is true just for them), and only once per turn.
  if (!canAct() || turnClock.autoFired) return;
  const cur = session.state.turn;
  if (gs.timerMode === 'perturn' && gs.penaltyMode === 'automove') {
    if (turnElapsed() >= gs.timerThreshold) {
      turnClock.autoFired = true;
      const mv = randomMove(session.state, cur);
      if (mv) onLocalMoveAttempt(mv);
    }
  } else if (gs.timerMode === 'tug') {
    const t = liveTimeUsed();
    if ((t[cur] - t[1 - cur]) / 1000 >= gs.timerThreshold) {
      turnClock.autoFired = true;
      declareTimeoutLoss();
    }
  }
}

// Reset the clock when a new turn begins; freeze/clear it when the game ends.
function syncTurnClock() {
  const s = session?.state;
  if (!s || s.winner !== null) {
    if (turnClock.timer) { clearInterval(turnClock.timer); turnClock.timer = null; }
    $('#game-timer').classList.add('hidden');
    $('#tug-wrap').classList.add('hidden');
    return;
  }
  // Game is gated on a settings acknowledgement: show a frozen clock, don't run.
  if (session.paused) {
    if (turnClock.timer) { clearInterval(turnClock.timer); turnClock.timer = null; }
    turnClock.lastMove = s.moveCount;
    turnClock.autoFired = false;
    session.turnStart = Date.now(); // keep elapsed pinned at ~0 while frozen
    renderTimerDisplay(gameSettings());
    return;
  }
  if (s.moveCount !== turnClock.lastMove) {
    turnClock.lastMove = s.moveCount;
    turnClock.autoFired = false;
    session.turnStart = Date.now();
  }
  // 100ms so the tug-of-war marker moves smoothly (the underlying times are
  // millisecond-precise; this is just the visual refresh rate).
  if (!turnClock.timer) turnClock.timer = setInterval(tickTurnClock, 100);
  tickTurnClock();
}

// The current player ran out on the tug-of-war clock. The host (or a local
// game) resolves it authoritatively; a guest asks the host to.
function declareTimeoutLoss() {
  if (session.mode === 'local' || session.isHost) endByTimeout(session.state.turn);
  else sendToHost({ t: MSG.TIMEOUT });
}

function endByTimeout(loser) {
  if (!session?.state || session.state.winner !== null) return;
  session.state = { ...session.state, winner: 1 - loser, winLine: null, timeoutLoser: loser };
  if (session.mode === 'net' && session.isHost) broadcast({ t: MSG.STATE, state: session.state });
  afterStateChange();
}

function maybeNotifyTurn() {
  if (session?.mode !== 'net' || session.role === 'spectator' || !getProfile().settings.notifyTurns) return;
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
  if ($('#dlg-gate').open) $('#dlg-gate').close();
  teardown();
  setStatus('#home-status', '');
  show('screen-home');
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// --- message plumbing: host broadcasts to everyone; others talk to the host ---

function sendToHost(msg) {
  sendMsg(session.hostConn, msg);
}

function broadcast(msg, except) {
  if (!session?.conns) return;
  for (const conn of session.conns.keys()) {
    if (conn !== except) sendMsg(conn, msg);
  }
}

// --- room roster (players by seat + spectators), for the lobby popup ---

function buildRoster() {
  const players = [null, null];
  const spectators = [];
  if (session.myPlayer != null) players[session.myPlayer] = session.myName;
  if (session.conns) {
    for (const info of session.conns.values()) {
      if (info.role === 'player' && info.player != null) players[info.player] = info.name;
      else if (info.role === 'spectator') spectators.push(info.name);
    }
  }
  // buildRoster only runs on the host, so our seat is the host's seat.
  return { players, spectators, host: session.myPlayer };
}

function currentRoster() {
  return session.isHost ? buildRoster() : (session.roster || buildRoster());
}

function broadcastRoster() {
  if (!session?.isHost) return;
  session.roster = buildRoster();
  broadcast({ t: MSG.ROSTER, roster: session.roster, hostName: session.myName });
  refreshLobby();
  renderRoomBar();
}

// Is the seat opposite me occupied by a live connection? (Host view.)
function opponentPresent() {
  if (session.mode !== 'net') return true;
  if (session.isHost) {
    const other = 1 - session.myPlayer;
    if (session.myPlayer == null) return false;
    for (const info of session.conns.values()) {
      if (info.role === 'player' && info.player === other) return true;
    }
    return false;
  }
  return session.hostConn?.open === true;
}

// Assign a seat to a joining connection: honor a requested (reconnecting) seat
// if free, else the first open seat, else spectator; explicit spectators watch.
function assignSeat(meta) {
  if (meta.spectator) return { role: 'spectator', player: null };
  const occupied = new Set();
  if (session.myPlayer != null) occupied.add(session.myPlayer);
  for (const info of session.conns.values()) {
    if (info.role === 'player') occupied.add(info.player);
  }
  if (meta.seat != null && !occupied.has(meta.seat)) return { role: 'player', player: meta.seat };
  for (const p of [0, 1]) if (!occupied.has(p)) return { role: 'player', player: p };
  return { role: 'spectator', player: null };
}

// --- host side: accept many connections (2 players + spectators) ---

function becomeHost(peer) {
  session.isHost = true;
  session.peer = peer;
  session.hostConn = null;
  session.conns = session.conns || new Map();
  peer.on('connection', (conn) => {
    const attach = () => hostAcceptConn(conn);
    if (conn.open) attach();
    else conn.on('open', attach);
  });
  peer.on('disconnected', () => {
    // Broker link only matters for accepting (re)joins; restore it so the room
    // code keeps working.
    if (session?.peer === peer) peer.reconnect();
  });
}

function hostAcceptConn(conn) {
  if (!session?.isHost) { conn.close(); return; }
  const meta = conn.metadata || {};
  const { role, player } = assignSeat(meta);
  const name = String(meta.name || (role === 'spectator' ? 'Spectator' : 'Player')).slice(0, 20);
  session.conns.set(conn, { role, player, name });
  if (role === 'player' && player != null) session.names[player] = name;

  conn.on('data', (d) => hostOnData(conn, d));
  conn.on('close', () => hostOnClose(conn));
  conn.on('error', () => hostOnClose(conn));

  // A player joining a not-yet-started game must confirm the settings before the
  // clock runs; a reconnect mid-game (moveCount > 0) resumes without a gate.
  const freshJoin = role === 'player' && session.state
    && session.state.moveCount === 0 && session.state.winner === null;
  if (freshJoin) {
    session.pendingAck = session.pendingAck || new Set();
    session.pendingAck.add(player);
    session.paused = true;
    session.turnStart = Date.now();
  }
  const turnElapsedMs = session.state && session.state.winner === null && !session.paused
    ? Date.now() - (session.turnStart || Date.now()) : 0;
  sendMsg(conn, {
    t: MSG.START, state: session.state, names: session.names,
    you: player, role, roster: buildRoster(), turnElapsedMs, hostName: session.myName,
    gate: freshJoin ? 'join' : undefined,
  });
  broadcastRoster();

  // The host enters the game once a real player is seated.
  if (role === 'player') {
    if ($('#screen-game').classList.contains('hidden')) enterGame();
    else if (!freshJoin) { showBanner(`${name} joined`); setTimeout(hideBannerIfPlaying, 1600); }
    if (freshJoin) showBanner(`Waiting for ${name} to be ready…`);
  }
}

function hostOnData(conn, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  const info = session.conns.get(conn);
  if (!info) return;
  if (msg.t === MSG.MOVE) {
    if (info.role !== 'player' || session.state.turn !== info.player) {
      sendMsg(conn, { t: MSG.STATE, state: session.state }); // reject/resync
      return;
    }
    const ms = Date.now() - (session.turnStart || Date.now());
    const res = applyMove(session.state, msg.move, { ms });
    if (!res.ok) { sendMsg(conn, { t: MSG.STATE, state: session.state }); return; }
    session.state = res.state;
    broadcast({ t: MSG.STATE, state: session.state, move: msg.move, by: info.player });
    presentOpponentMove(msg.move);
    maybeNotifyTurn();
  } else if (msg.t === MSG.TIMEOUT) {
    if (info.role === 'player' && session.state.winner === null && session.state.turn === info.player) {
      endByTimeout(info.player);
    }
  } else if (msg.t === MSG.REMATCH) {
    if (info.role === 'player') { session.rematchWants.add(info.player); maybeRematch(); }
  } else if (msg.t === MSG.ACK) {
    if (info.role === 'player' && session.pendingAck?.has(info.player)) {
      session.pendingAck.delete(info.player);
      maybeBegin();
    }
  }
}

function hostOnClose(conn) {
  const info = session?.conns?.get(conn);
  if (!info) return;
  session.conns.delete(conn);
  broadcastRoster();
  if (info.role === 'player') {
    // If we were holding the clock for them, stop waiting.
    if (session.pendingAck?.has(info.player)) { session.pendingAck.delete(info.player); maybeBegin(); }
    if (!$('#screen-game').classList.contains('hidden')) {
      showBanner(`${info.name} disconnected — they can rejoin with code ${session.code}`);
    }
  }
}

// --- guest/spectator side: a single connection to the current host ---

function becomeGuest(conn) {
  session.isHost = false;
  session.peer = conn.provider;
  session.hostConn = conn;
  session.conns = null;
  conn.on('data', (d) => guestOnData(d));
  conn.on('close', () => guestOnClose(conn));
  conn.on('error', () => guestOnClose(conn));
}

function guestOnData(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.t === MSG.START) {
    session.state = msg.state;
    session.names = msg.names;
    if (msg.you !== undefined) session.myPlayer = msg.you;
    if (msg.role) session.role = msg.role;
    if (msg.roster) session.roster = msg.roster;
    if (msg.hostName) session.hostName = msg.hostName;
    session.rematchWants = new Set();
    session.recorded = msg.state.winner !== null;
    // A gated start (fresh join, or the host restarting with new settings): show
    // the settings and hold the clock until this player acknowledges.
    const gated = msg.gate && session.role === 'player' && msg.state.winner === null;
    if (gated) {
      session.paused = true;
      session.turnStart = Date.now();
      turnClock.lastMove = -1;
      enterGame();
      openGate(msg.gate);
      return;
    }
    session.paused = false;
    session.pendingAck = null;
    // On a resume, pick up the current turn's elapsed time instead of restarting.
    if (typeof msg.turnElapsedMs === 'number' && msg.state.winner === null) {
      session.turnStart = Date.now() - msg.turnElapsedMs;
      turnClock.lastMove = msg.state.moveCount;
    } else {
      turnClock.lastMove = -1;
    }
    enterGame();
    maybeNotifyTurn();
  } else if (msg.t === MSG.STATE) {
    session.state = msg.state;
    // Animate the opponent's move; our own optimistic move just re-syncs.
    if (msg.move && msg.by !== session.myPlayer) presentOpponentMove(msg.move);
    else afterStateChange();
    maybeNotifyTurn();
  } else if (msg.t === MSG.ROSTER) {
    session.roster = msg.roster;
    if (msg.hostName) session.hostName = msg.hostName;
    refreshLobby();
    renderRoomBar();
  }
}

function guestOnClose(conn) {
  if (session?.hostConn !== conn) return;
  session.hostConn = null;
  if ($('#screen-game').classList.contains('hidden')) return;
  showBanner('Connection lost — trying to reconnect…');
  $('#btn-reconnect').classList.remove('hidden');
  // Auto-attempt: the host may have left, in which case we (or the other
  // player) re-publish the room code and whoever's second rejoins it.
  connectToRoom({ reconnect: true });
}

function opponentName() {
  if (session.myPlayer == null) return 'Opponent';
  return session.names[1 - session.myPlayer] || 'Opponent';
}

// --- hosting ------------------------------------------------------------------

async function startHosting() {
  const name = myName();
  if (!name) return;
  saveProfile({ name });
  teardown();
  session = {
    mode: 'net', myPlayer: 0, role: 'player', myName: name,
    names: [name, ''], recorded: false, rematchWants: new Set(),
    conns: new Map(),
  };
  const mySession = session;
  show('screen-host');
  $('#host-code').textContent = '····';
  $('#host-share').innerHTML = '';
  setStatus('#host-status', 'Creating game…');

  // Random codes make collisions (including our own not-yet-expired ghost after
  // a refresh) a non-event: just draw a fresh code and try again.
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
  session.code = code;
  localStorage.setItem('gobblet.lastcode', code);
  session.state = newSessionGame(Math.random() < 0.5 ? 0 : 1); // deal now; play begins when a player joins
  becomeHost(peer);
  $('#host-code').textContent = code;
  const url = `${location.origin}${location.pathname}#j=${code}`;
  initShareButtons($('#host-share'), {
    text: `${name} is inviting you to a game of Gobblet! Game code: ${code}`,
    url,
    subject: 'Gobblet game invite',
  });
  setStatus('#host-status', 'Waiting for a player to join…');
}

// --- joining ------------------------------------------------------------------

function startJoin(prefill = '') {
  show('screen-join');
  setStatus('#join-status', '');
  // Prefill an invite code, else the last room we were in (for a quick rejoin).
  $('#join-code').value = prefill || localStorage.getItem('gobblet.lastcode') || '';
}

async function joinByCode() {
  const name = myName();
  if (!name) { show('screen-home'); return; }
  primeAudio(); // this click is our gesture to allow the move chime
  saveProfile({ name });
  const code = normalizeCode($('#join-code').value);
  if (!code) return setStatus('#join-status', 'Enter the 4-letter game code from the host.', true);
  localStorage.setItem('gobblet.lastcode', code);

  teardown();
  session = {
    mode: 'net', myPlayer: null, role: 'player', myName: name,
    names: ['', ''], recorded: false, rematchWants: new Set(), code,
  };
  const mySession = session;
  setStatus('#join-status', 'Connecting…');
  try {
    // A fresh join: the host assigns a seat, or spectator if both seats are full.
    const conn = await joinRoom(code, { name, seat: null, spectator: false });
    if (session !== mySession) { conn.close(); return; }
    becomeGuest(conn);
    setStatus('#join-status', 'Connected — starting…');
  } catch (err) {
    setStatus('#join-status', describePeerError(err), true);
  }
}

// Reconnect / host migration. A player claims the room code if it's free
// (becoming the new host and seeding from their own synced state), otherwise
// joins whoever holds it. Spectators only ever join. Whoever comes back first
// republishes; the other reconnects to them.
async function connectToRoom({ reconnect } = {}) {
  if (!session || session.reconnecting) return;
  session.reconnecting = true;
  const mySession = session;
  const { code } = session;
  const canClaim = session.role === 'player';
  try {
    for (let attempt = 0; attempt < 6 && session === mySession; attempt++) {
      if (canClaim) {
        try {
          session.peer?.destroy();
          const peer = await hostRoom(code);
          if (session !== mySession) { peer.destroy(); return; }
          becomeHost(peer);
          enterGame();
          broadcastRoster();
          showBanner('You’re hosting now — waiting for the others to reconnect…');
          return;
        } catch (err) {
          if (err?.type !== 'unavailable-id') { await delay(300); continue; }
          // someone already holds the code — join them instead
        }
      }
      try {
        const conn = await joinRoom(code, {
          name: session.myName, seat: session.myPlayer, spectator: session.role === 'spectator',
        });
        if (session !== mySession) { conn.close(); return; }
        becomeGuest(conn);
        return; // the host's START re-enters the game
      } catch {
        await delay(400); // holder not ready or just vanished — retry
      }
    }
    if (session === mySession && !$('#screen-game').classList.contains('hidden')) {
      showBanner('Couldn’t reconnect — tap Reconnect to try again.');
    }
  } finally {
    if (session === mySession) session.reconnecting = false;
  }
}

function reconnect() {
  const btn = $('#btn-reconnect');
  btn.disabled = true;
  btn.textContent = 'Reconnecting…';
  connectToRoom({ reconnect: true }).finally(() => {
    btn.disabled = false;
    btn.textContent = 'Reconnect';
  });
}

// --- local pass & play ----------------------------------------------------------

function startLocal() {
  primeAudio();
  teardown();
  session = {
    mode: 'local', isHost: true, myPlayer: null,
    names: [...activeTheme.playerNames],
    state: newSessionGame(0), recorded: true, // local games aren't recorded
  };
  enterGame();
}

// Offline vs the computer: you are seat 0, the AI is seat 1. First player random.
function startAI() {
  primeAudio();
  teardown();
  const me = 0;
  session = {
    mode: 'ai', isHost: true, myPlayer: me, human: me, aiPlayer: 1,
    names: [getProfile().name || 'You', 'Computer'],
    state: newSessionGame(Math.random() < 0.5 ? 0 : 1), recorded: true,
  };
  enterGame();
  maybeAIMove();
}

// Difficulty = how long the computer "thinks" before moving. A slower opponent
// accrues more time, so it's easier to out-pace on the tug-of-war clock.
const AI_THINK_BASE = { easy: 5000, medium: 4000, hard: 3000 };

// The think delay for one move: the difficulty's base time with a ±50% jitter.
// We also record this as the AI's move time so the tug clock reflects deliberate
// thinking, not real wall-clock (which balloons if the tab is backgrounded).
function aiThinkMs() {
  const base = AI_THINK_BASE[gameSettings().aiDifficulty] || AI_THINK_BASE.medium;
  return Math.round(base * (0.5 + Math.random()));
}

// If it's the computer's turn, think then play (and present it like an
// opponent's move — chime + animation).
function maybeAIMove() {
  if (!session || session.mode !== 'ai' || session.aiThinking) return;
  if (session.state.winner !== null || session.state.turn !== session.aiPlayer) return;
  session.aiThinking = true;
  const mine = session;
  const think = aiThinkMs();
  setTimeout(() => {
    if (session !== mine || session.mode !== 'ai') return;
    session.aiThinking = false;
    if (session.state.winner !== null || session.state.turn !== session.aiPlayer) return;
    const move = chooseMove(session.state, session.aiPlayer, gameSettings().aiType);
    if (!move) return;
    const res = applyMove(session.state, move, { ms: think });
    if (!res.ok) return;
    session.state = res.state;
    presentOpponentMove(move);
  }, think);
}

// --- game screen ----------------------------------------------------------------

function bottomPlayer() {
  // Net: the local player (seat 0 for a spectator). Vs computer: always the
  // human. Local pass & play: whoever's turn it is.
  if (session.mode === 'net') return session.myPlayer == null ? 0 : session.myPlayer;
  if (session.mode === 'ai') return session.human;
  return session.state.turn;
}

function canAct() {
  if (!session?.state || session.state.winner !== null) return false;
  if (session.paused) return false; // waiting on a settings acknowledgement
  if (session.role === 'spectator') return false;
  if (session.mode === 'local') return true;
  if (session.mode === 'ai') return session.state.turn === session.human && !session.aiThinking;
  if (session.state.turn !== session.myPlayer) return false;
  // Need the opponent present (host) / a live link to the host (guest) so the
  // move doesn't diverge into the void.
  return opponentPresent();
}

function mountBoard() {
  boardView = createBoardView($('#board-mount'), {
    theme: activeTheme,
    getState: () => session?.state,
    getBottomPlayer: bottomPlayer,
    canAct,
    // Highlight is a game setting (shared); input mode is a device preference.
    getSettings: () => ({
      highlightMoves: gameSettings().highlightMoves,
      inputMode: getProfile().settings.inputMode,
    }),
    legalTargets: (sel) => legalTargetsFor(session.state, bottomPlayer(), sel),
    attemptMove: onLocalMoveAttempt,
  });
}

function enterGame() {
  show('screen-game');
  hideBanner();
  $('#btn-rematch').classList.add('hidden');
  $('#btn-reconnect').classList.add('hidden');
  $('#btn-stats').classList.add('hidden');
  $('#btn-replay').classList.add('hidden');
  renderRoomBar();
  mountBoard();
  afterStateChange();
}

function hideBannerIfPlaying() {
  if (session?.state?.winner === null) hideBanner();
}

// --- room bar + lobby popup ---

function renderRoomBar() {
  const bar = $('#game-room');
  if (!bar) return;
  if (session?.mode === 'net' && session.code) {
    const specs = currentRoster().spectators.length;
    bar.classList.remove('hidden');
    bar.innerHTML = `<span class="room-tag">Room ${session.code}</span>`
      + (specs ? `<span class="room-spec">👁 ${specs}</span>` : '');
  } else {
    bar.classList.add('hidden');
  }
}

function openLobby() {
  if (session?.mode !== 'net') return;
  refreshLobby(true);
  $('#dlg-room').showModal();
}

function refreshLobby(force) {
  const dlg = $('#dlg-room');
  if (!dlg || (!force && !dlg.open)) return;
  const r = currentRoster();
  const seat = (p) => {
    const nm = r.players[p];
    const tags = [];
    if (nm && p === r.host) tags.push('<span class="host-badge">host</span>');
    if (session.myPlayer === p) tags.push('<span class="hint">(you)</span>');
    if (!nm) tags.push('<span class="hint">open</span>');
    return `<div class="lobby-seat">${colorDot(p)} <b>${nm ? escape(nm) : '—'}</b> ${tags.join(' ')}</div>`;
  };
  const specs = r.spectators.length
    ? `<div class="lobby-spec"><b>Spectators</b><br>${r.spectators.map(escape).join('<br>')}</div>`
    : '<div class="lobby-spec hint">No spectators watching</div>';
  $('#room-body').innerHTML =
    `<div class="hint">Game code</div><div class="room-code">${session.code}</div>`
    + seat(0) + seat(1) + specs;
  const url = `${location.origin}${location.pathname}#j=${session.code}`;
  initShareButtons($('#room-share'), {
    text: `Join my Gobblet game! Game code: ${session.code}`, url, subject: 'Gobblet game invite',
  });
}

// --- settings gate ---------------------------------------------------------
//
// A player joining a game they haven't seen — or facing a settings-change
// restart — confirms the game settings before their clock starts, so time never
// ticks while they're unaware the game has (re)started. Rematches and plain
// reconnects skip this (both players already know the settings).

function describeGameSettings(gs) {
  const rows = [
    ['Highlight moves', gs.highlightMoves ? 'On' : 'Off'],
    ['Replay last move', gs.allowReplay ? 'Allowed' : 'Off'],
  ];
  if (gs.timerMode === 'perturn') {
    rows.push(['Turn timer', `${gs.timerThreshold}s per turn`]);
    rows.push(['When time’s up', gs.penaltyMode === 'automove' ? 'Random auto-move' : 'Keep going']);
  } else if (gs.timerMode === 'tug') {
    rows.push(['Turn timer', `Tug-of-war · lose at ${gs.timerThreshold}s behind`]);
  } else {
    rows.push(['Turn timer', 'Off']);
  }
  return rows;
}

function openGate(kind) {
  $('#gate-title').textContent = kind === 'settings' ? 'Game restarted' : `${session.hostName || 'Host'}’s game`;
  $('#gate-intro').textContent = kind === 'settings'
    ? 'The host changed the settings and restarted the game. Review them, then start when you’re ready — your clock won’t run until you do.'
    : 'Review the game settings, then start when you’re ready — your clock won’t run until you do.';
  $('#gate-body').innerHTML = describeGameSettings(gameSettings())
    .map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join('');
  if (!$('#dlg-gate').open) $('#dlg-gate').showModal();
}

// The guest accepted the settings: tell the host to start, and unfreeze locally.
function confirmGate() {
  $('#dlg-gate').close();
  if (!session || session.mode !== 'net' || !session.paused) return;
  session.paused = false;
  session.turnStart = Date.now();
  turnClock.lastMove = -1;
  sendToHost({ t: MSG.ACK });
  afterStateChange();
  maybeNotifyTurn();
}

// Host: begin play once every gated player has acknowledged the settings (or
// none remain to wait on).
function maybeBegin() {
  if (!session?.paused) return;
  if (session.pendingAck && session.pendingAck.size > 0) return;
  session.paused = false;
  session.pendingAck = null;
  session.turnStart = Date.now();
  turnClock.lastMove = -1;
  hideBannerIfPlaying();
  afterStateChange();
  maybeNotifyTurn();
}

// The opponent just moved: play the chosen sound and slide the piece into place
// (if animation is on) before settling on the new state.
function presentOpponentMove(move) {
  playSound(getProfile().settings.moveSound);
  const animate = getProfile().settings.animateMoves && boardView
    && !$('#screen-game').classList.contains('hidden');
  if (animate) boardView.animateMove(move, afterStateChange);
  else afterStateChange();
}

// Reconstruct the board as it was just before `entry` by undoing that move:
// lift the piece off its destination (revealing anything it gobbled) and put it
// back on its origin square or in its reserve stack.
function undoLast(state, entry) {
  const s = structuredClone(state);
  const moved = s.board[entry.to[0]][entry.to[1]].pop();
  if (entry.kind === 'place') s.reserves[entry.by][entry.stack] += 1;
  else if (moved) s.board[entry.from[0]][entry.from[1]].push(moved);
  return s;
}

function replayLastMove() {
  if (!boardView || session.state.winner !== null) return;
  const log = session.state.log;
  const entry = log?.[log.length - 1];
  if (entry) boardView.replayMove(entry, undoLast(session.state, entry));
}

function onLocalMoveAttempt(move) {
  if (session.role === 'spectator') return false;
  const ms = Date.now() - (session.turnStart || Date.now());
  const res = applyMove(session.state, move, { ms });
  if (!res.ok) return false;
  session.state = res.state;
  if (session.mode === 'net') {
    // Host applies + broadcasts to everyone; a guest sends the move for the host
    // to validate (it already showed optimistically here).
    if (session.isHost) broadcast({ t: MSG.STATE, state: session.state, move, by: session.myPlayer });
    else sendToHost({ t: MSG.MOVE, move });
  }
  afterStateChange();
  if (session.mode === 'ai') maybeAIMove(); // hand the turn to the computer
  return true;
}

function afterStateChange() {
  if (!session?.state) return;
  boardView?.update();
  renderHeader();
  syncTurnClock();
  updateReplayButton();
  const { winner } = session.state;
  if (winner === null) return;

  const isPlayer = session.role !== 'spectator' && session.myPlayer != null;
  if (isPlayer && !session.recorded) {
    session.recorded = true;
    recordGame({
      opponent: opponentName(),
      iHosted: session.isHost,
      result: winner === session.myPlayer ? 'win' : 'loss',
      moveCount: session.state.moveCount,
    });
  }
  const loser = session.state.timeoutLoser;
  const nm = (p) => session.names[p] || activeTheme.playerNames[p];
  // Neutral wording for spectators and local play; personalized for a player.
  if (session.mode === 'local' || !isPlayer) {
    if (loser != null) showBanner(`${nm(loser)} ran out of time — ${nm(1 - loser)} wins! 🏆`);
    else showBanner(`${nm(winner)} wins! 🏆`);
  } else if (loser != null) {
    showBanner(loser === session.myPlayer
      ? 'You ran out of time' : `${opponentName()} ran out of time — you win! 🏆`);
  } else {
    showBanner(winner === session.myPlayer ? 'You win! 🏆' : `${opponentName()} wins`);
  }
  $('#btn-stats').classList.remove('hidden');
  if (isPlayer) $('#btn-rematch').classList.remove('hidden');
}

// Show the "replay opponent's move" button when replay is allowed, a move
// exists to replay, and the local player is up (net) or always (local).
function updateReplayButton() {
  const s = session.state;
  const show = gameSettings().allowReplay && s.winner === null && (s.log?.length > 0)
    && (session.mode === 'local' || s.turn === session.myPlayer);
  $('#btn-replay').classList.toggle('hidden', !show);
}

function colorDot(p) {
  return `<span class="dot" style="background:${activeTheme.colors[p]}"></span>`;
}

// Move-by-move breakdown shown on the win screen: who moved, what they did, and
// how long the turn took (flagging turns that went over the limit).
function renderStats(container) {
  const s = session.state;
  const log = Array.isArray(s.log) ? s.log : [];
  // Overage only makes sense in per-turn mode; tug-of-war has no per-move limit.
  const limit = s.gameSettings?.timerMode === 'perturn' ? s.gameSettings.timerThreshold : 0;
  const cellName = ([r, c]) => `${'abcd'[c]}${r + 1}`;
  const nameOf = (p) => session.names[p] || activeTheme.playerNames[p] || `P${p + 1}`;
  const describe = (e) => (e.kind === 'place'
    ? `placed ${SIZE_NAMES[e.size]} on ${cellName(e.to)}`
    : `moved ${SIZE_NAMES[e.size]} ${cellName(e.from)}→${cellName(e.to)}`);

  const totals = [{ t: 0, n: 0, over: 0 }, { t: 0, n: 0, over: 0 }];
  const rows = log.map((e, i) => {
    const secs = e.ms / 1000;
    totals[e.by].t += secs;
    totals[e.by].n += 1;
    const over = limit && secs > limit;
    if (over) totals[e.by].over += secs - limit;
    return `<li class="${over ? 'over' : ''}"><span>${i + 1}. ${colorDot(e.by)} ${describe(e)}</span><b>${secs.toFixed(1)}s</b></li>`;
  }).join('');

  const summary = [0, 1].map((p) => {
    if (!totals[p].n) return '';
    const avg = totals[p].t / totals[p].n;
    const overStr = limit ? ` · ${totals[p].over.toFixed(1)}s over` : '';
    return `<div class="stat-sum">${colorDot(p)} <b>${escape(nameOf(p))}</b> — ${totals[p].n} moves · ${totals[p].t.toFixed(1)}s total · ${avg.toFixed(1)}s avg${overStr}</div>`;
  }).join('');

  container.innerHTML = (summary || '<p class="hint">No moves recorded.</p>')
    + (rows ? `<ol class="stat-list">${rows}</ol>` : '')
    + (limit ? `<p class="hint">Turn limit was ${limit}s per move.</p>` : '');
}

function renderHeader() {
  const s = session.state;
  const dot = colorDot;
  // A round is one move by each player; it advances after both have moved.
  const round = ` · R${Math.floor(s.moveCount / 2) + 1}`;
  if (session.mode === 'local') {
    $('#game-players').innerHTML = `${dot(s.turn)} <b>${escape(session.names[s.turn])}</b>`;
    $('#game-turn').textContent = s.winner === null ? `to move${round}` : '';
  } else if (session.role === 'spectator' || session.myPlayer == null) {
    const nm = (p) => session.names[p] || activeTheme.playerNames[p];
    $('#game-players').innerHTML = `${dot(0)} <b>${escape(nm(0))}</b> vs ${dot(1)} <b>${escape(nm(1))}</b>`;
    $('#game-turn').textContent = s.winner !== null ? '' : `${escape(nm(s.turn))} to move${round}`;
  } else {
    const mine = s.turn === session.myPlayer;
    $('#game-players').innerHTML =
      `${dot(session.myPlayer)} <b>${escape(session.names[session.myPlayer] || activeTheme.playerNames[session.myPlayer])}</b> vs ` +
      `${dot(1 - session.myPlayer)} <b>${escape(opponentName())}</b>`;
    $('#game-turn').textContent = s.winner !== null ? ''
      : (mine ? `Your turn${round}` : `Their turn${round}`);
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
  if (session.role === 'spectator') return;
  if (session.mode === 'local' || session.mode === 'ai') {
    session.state = newSessionGame(session.state.winner === 0 ? 1 : 0);
    hideBanner();
    $('#btn-rematch').classList.add('hidden');
    $('#btn-stats').classList.add('hidden');
    afterStateChange();
    if (session.mode === 'ai') maybeAIMove();
    return;
  }
  if (session.isHost) {
    session.rematchWants.add(session.myPlayer);
    showBanner('Waiting for the other player…');
    maybeRematch();
  } else {
    sendToHost({ t: MSG.REMATCH });
    showBanner('Waiting for the other player…');
  }
}

// Restart the game with the current (just-saved) game settings — used when the
// host changes game settings, which only take effect on a fresh game.
function restartGame() {
  if (!session?.state) return;
  const first = Math.random() < 0.5 ? 0 : 1;
  session.state = newSessionGame(first);
  session.recorded = session.mode !== 'net'; // only net games are recorded
  session.rematchWants = new Set();
  session.paused = false;
  session.pendingAck = null;
  if (session.mode === 'net' && session.isHost) {
    // Hold the clock until the other player accepts the new settings; the host
    // set them, so they're already ready.
    session.pendingAck = new Set();
    for (const info of session.conns.values()) {
      if (info.role === 'player') session.pendingAck.add(info.player);
    }
    session.paused = session.pendingAck.size > 0;
    session.turnStart = Date.now();
    broadcast({
      t: MSG.START, state: session.state, names: session.names,
      roster: buildRoster(), hostName: session.myName, gate: 'settings',
    });
  }
  enterGame();
  if (session.paused) showBanner('Waiting for the other player to accept the new settings…');
  if (session.mode === 'ai') maybeAIMove();
}

// Host-only: once both seated players have asked, deal a new game and broadcast
// it to everyone (players and spectators).
function maybeRematch() {
  if (!session.isHost) return;
  const seats = new Set();
  if (session.myPlayer != null) seats.add(session.myPlayer);
  for (const info of session.conns.values()) if (info.role === 'player') seats.add(info.player);
  if (seats.size < 2) return;
  for (const p of seats) if (!session.rematchWants.has(p)) return;
  const first = session.state?.winner != null ? 1 - session.state.winner : (Math.random() < 0.5 ? 0 : 1);
  session.state = newSessionGame(first);
  session.rematchWants = new Set();
  session.recorded = false;
  session.paused = false;
  session.pendingAck = null;
  // No gate: both players agreed to the rematch, so they already know the rules.
  broadcast({ t: MSG.START, state: session.state, names: session.names, roster: buildRoster(), hostName: session.myName });
  enterGame();
}

// --- boot ------------------------------------------------------------------------

function boot() {
  const profile = getProfile();
  $('#my-name').value = profile.name;
  $('#my-name').addEventListener('change', () => saveProfile({ name: $('#my-name').value.trim() }));

  const prefsDialog = initPreferences($('#dlg-prefs'), onPrefsChange);
  const gameDialog = initGameSettings($('#dlg-game'), {
    context: () => ({
      editable: !session || session.isHost,
      inGame: !!session?.state && !$('#screen-game').classList.contains('hidden'),
      hostName: session ? (session.isHost ? session.myName : session.hostName) : null,
      mode: session?.mode || null,
    }),
    effective: () => gameSettings(),
    saveDefaults: (s) => saveProfile({ settings: s }),
    applyRestart: (s) => { saveProfile({ settings: s }); restartGame(); },
  });
  const historyDialog = $('#dlg-history');

  // Preferences apply live: rebuild the board if the theme changed, else refresh.
  function onPrefsChange() {
    applyBoardScale();
    const desired = getProfile().settings.theme;
    if (desired !== activeTheme.id) {
      activeTheme = getTheme(desired);
      if (boardView && !$('#screen-game').classList.contains('hidden')) {
        mountBoard();
        renderHeader();
      }
    }
    boardView?.update();
  }

  // Prime audio from these gestures so the move chime can play later (autoplay).
  $('#btn-online').addEventListener('click', () => startJoin(pendingInvite || ''));
  $('#btn-create-new').addEventListener('click', () => { primeAudio(); startHosting(); });
  $('#btn-local').addEventListener('click', startLocal);
  $('#btn-ai').addEventListener('click', startAI);
  $('#btn-game').addEventListener('click', () => gameDialog.open());
  $('#btn-prefs').addEventListener('click', () => prefsDialog.open());
  $('#btn-game-game').addEventListener('click', () => gameDialog.open());
  $('#btn-game-prefs').addEventListener('click', () => prefsDialog.open());
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
  $('#btn-reconnect').addEventListener('click', reconnect);
  $('#game-room').addEventListener('click', openLobby);
  $('#btn-room-close').addEventListener('click', () => $('#dlg-room').close());
  $('#btn-gate-ok').addEventListener('click', confirmGate);
  // The gate must be answered with the button; Escape shouldn't leave it paused.
  $('#dlg-gate').addEventListener('cancel', (e) => e.preventDefault());
  $('#btn-stats').addEventListener('click', () => {
    if (!session?.state) return;
    renderStats($('#stats-body'));
    $('#dlg-stats').showModal();
  });
  $('#btn-stats-close').addEventListener('click', () => $('#dlg-stats').close());
  $('#btn-replay').addEventListener('click', replayLastMove);
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
    setStatus('#home-status', 'Game invite detected — enter your name and tap Play Online.');
  }
  window.addEventListener('hashchange', checkInviteHash);
  // Tell the broker goodbye on refresh/close so our name frees immediately
  // instead of lingering until the broker's heartbeat timeout.
  window.addEventListener('pagehide', () => {
    try { session?.peer?.destroy(); } catch { /* already gone */ }
  });
  applyBoardScale();
  initNotifications();
  show('screen-home');
  checkInviteHash();
}

boot();
