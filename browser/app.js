// App orchestrator: screen flow, session lifecycle (host / join / local),
// and the glue between the rules engine, board view, and data channel.

import { newGame, SIZE_NAMES } from './game/state.js';
import { applyMove, legalTargetsFor, randomMove } from './game/rules.js';
import { chooseMove, FORGET_PROB } from './game/ai.js';
import { runSimulations, CONTENDERS, contenderKey } from './game/simulate.js';
import { makeCode, normalizeCode, hostRoom, joinRoom, describePeerError } from './net/peer.js';
import { MSG, sendMsg, onMessages } from './net/protocol.js';
import { getProfile, saveProfile, recordGame, gameSettingsFrom } from './storage/history.js';
import { createBoardView } from './ui/board.js';
import { initShareButtons, renderHistory } from './ui/lobby.js';
import { initPreferences, initGameSettings } from './ui/settings.js';
import { initNotifications, notifyIfHidden } from './ui/notify.js';
import { primeAudio, playSound } from './ui/sound.js';
import { createVoiceRecorder, voiceSupported } from './ui/voice.js';
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
    clearTimeout(session.aiTimer);
    session.conns?.forEach((_info, conn) => { try { conn.close(); } catch { /* closed */ } });
    try { session.hostConn?.close(); } catch { /* closed */ }
    try { session.peer?.destroy(); } catch { /* already destroyed */ }
  }
  stopTurnClock();
  teardownVoice();
  session = null;
  boardView = null;
}

// --- turn clock: counts up how long the current turn has lasted ---------------

const turnClock = { timer: null, lastMove: -1, autoFired: false };

function stopTurnClock() {
  if (turnClock.timer) { clearInterval(turnClock.timer); turnClock.timer = null; }
  turnClock.lastMove = -1;
  turnClock.autoFired = false;
}

// Wipe the local game's clock + any pending AI move so nothing from the old
// game carries into a restart/rematch (a stale interval or timeout made the
// timer look like it never reset).
function resetClockAndAI() {
  stopTurnClock();
  if (session) {
    clearTimeout(session.aiTimer);
    session.aiThinking = false;
    session.turnStart = null;
    session.aiForget = new Set(); // fresh memory for the new game
  }
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

  // Local vs-computer tug-of-war: only the human can lose on time — the computer
  // paces itself (see aiThinkMs) to never cross the line. Nothing else watches
  // this clock, so resolve the human's side here.
  if (session.mode === 'ai' && gs.timerMode === 'tug') {
    if (!turnClock.autoFired) {
      const t = liveTimeUsed();
      if ((t[session.human] - t[session.aiPlayer]) / 1000 >= gs.timerThreshold) {
        turnClock.autoFired = true;
        endByTimeout(session.human);
      }
    }
    return;
  }

  // Enforce the timeout consequence. Only the client controlling the current
  // player acts (canAct is true just for them), and only once per turn.
  if (!canAct() || turnClock.autoFired) return;
  const cur = session.state.turn;
  if (gs.timerMode === 'perturn' && gs.penaltyMode === 'automove') {
    if (turnElapsed() >= gs.timerThreshold) {
      turnClock.autoFired = true;
      fireAutoMove(cur);
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

// Confirm before abandoning a game in progress (any mode).
function confirmLeave() {
  $('#leave-note').textContent = session?.mode === 'net'
    ? 'You’ll disconnect from the online game — you can rejoin later with the room code.'
    : 'Your current game won’t be saved.';
  $('#dlg-leave').showModal();
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

// --- voice messages (online games) --------------------------------------------
// Record a clip, optionally review it, then send it over the data channel as
// base64 chunks (channels cap a single message ~256KB). In the host-authoritative
// star, a guest's chunks go to the host, which relays them to the rest of the
// room; the host's own chunks broadcast straight out.

let voiceRecorder = null;
let voiceState = 'idle'; // 'idle' | 'recording' | 'recorded'
let voiceBlob = null;
let voiceSeq = 0;
let voiceStartMs = 0;    // when the current recording began
let voiceTimerId = 0;    // interval updating the elapsed readout
// Incoming clips show as a stack of badges (top-left), oldest first. One plays
// at a time, auto-advancing; the playing badge is highlighted, any can be tapped
// to (re)play, and a finished clip lingers briefly for replay then disappears.
let voiceClips = [];     // ordered { id, from, url, audio, state, dismiss }
let voicePlayingId = null;
let voiceClipSeq = 0;
const voiceInbox = new Map(); // id -> { from, mime, total, parts, got }
const VOICE_CHUNK = 12000;    // base64 chars per message (~9KB binary)
const VOICE_MAX_CHUNKS = 800; // sanity cap on a reassembled clip

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Float the voice panel just above the footer, detached from the flow so it
// never shifts the board.
function positionVoicePanel() {
  const footer = $('#game-footer');
  $('#voice-panel').style.bottom = `${(footer?.offsetHeight || 0) + 10}px`;
}

const fmtClock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function stopVoiceTimer() {
  clearInterval(voiceTimerId);
  voiceTimerId = 0;
}

function startVoiceTimer() {
  stopVoiceTimer();
  voiceStartMs = Date.now();
  const tick = () => { $('#voice-time').textContent = fmtClock(Date.now() - voiceStartMs); };
  tick();
  voiceTimerId = setInterval(tick, 250);
}

function setVoiceState(s) {
  voiceState = s;
  $('#voice-rec').classList.toggle('hidden', s === 'idle');
  $('#btn-voice').classList.toggle('active', s !== 'idle');
  $('#btn-voice-review').textContent = s === 'recorded' ? 'Replay' : 'Review';
  if (s !== 'idle') positionVoicePanel();
}

function resetVoice() {
  stopVoiceTimer();
  voiceRecorder?.stopPlayback();
  voiceBlob = null;
  $('#voice-time').textContent = '0:00';
  setVoiceState('idle');
}

// Mic capture toggles live only in the recorder (not Prefs), persisted locally.
const MIC_KEY = 'gobblet.mic';
function loadMicOpts() {
  const opts = { ns: true, agc: true };
  try { Object.assign(opts, JSON.parse(localStorage.getItem(MIC_KEY)) || {}); } catch { /* default */ }
  return opts;
}
function saveMicOpts() {
  try {
    localStorage.setItem(MIC_KEY, JSON.stringify({ ns: $('#voice-ns').checked, agc: $('#voice-agc').checked }));
  } catch { /* quota */ }
}
function micConstraints() {
  return { noiseSuppression: $('#voice-ns').checked, autoGainControl: $('#voice-agc').checked };
}
async function onMicOptChange() {
  saveMicOpts();
  // noiseSuppression / autoGainControl are baked in when the mic stream opens —
  // a live track won't honor them reliably. So if we're mid-take, throw away the
  // current recording and restart capture with the new constraints.
  if (voiceState === 'recording' && voiceRecorder) {
    voiceRecorder.cancel();
    stopVoiceTimer();
    try {
      await voiceRecorder.start(micConstraints());
      startVoiceTimer();
    } catch {
      stopVoiceTimer();
      setVoiceState('idle');
      showBanner('Couldn’t use the mic — check the site’s microphone permission.');
    }
  }
}

async function startVoice() {
  if (session?.mode !== 'net' || voiceState !== 'idle') return;
  if (!voiceSupported()) {
    showBanner('Voice needs mic support — try Chrome, Firefox, or Safari.');
    return;
  }
  if (!voiceRecorder) voiceRecorder = createVoiceRecorder($('#voice-wave'));
  primeAudio();
  // Show the panel first so the canvas has a real size before the meter draws.
  setVoiceState('recording');
  try {
    await voiceRecorder.start(micConstraints());
    startVoiceTimer();
  } catch {
    stopVoiceTimer();
    setVoiceState('idle');
    showBanner('Couldn’t use the mic — check the site’s microphone permission.');
  }
}

async function reviewVoice() {
  if (voiceState === 'recording') {
    voiceBlob = await voiceRecorder.finish();
    stopVoiceTimer();
    $('#voice-time').textContent = fmtClock(Date.now() - voiceStartMs); // freeze the clip length
    setVoiceState('recorded');
  }
  if (voiceBlob) voiceRecorder.play(voiceBlob);
}

async function sendVoice() {
  let blob = voiceBlob;
  if (voiceState === 'recording') blob = await voiceRecorder.finish();
  resetVoice();
  if (!blob || !blob.size || session?.mode !== 'net') return;
  const b64 = bufToBase64(await blob.arrayBuffer());
  const mime = blob.type || 'audio/webm';
  const id = `${session.myPlayer ?? 'h'}-${Date.now()}-${voiceSeq++}`;
  const total = Math.ceil(b64.length / VOICE_CHUNK) || 1;
  for (let seq = 0; seq < total; seq++) {
    const msg = {
      t: MSG.VOICE, id, from: session.myName || 'Player',
      seq, total, mime, chunk: b64.slice(seq * VOICE_CHUNK, (seq + 1) * VOICE_CHUNK),
    };
    if (session.isHost) broadcast(msg); else sendToHost(msg);
  }
}

function cancelVoice() {
  voiceRecorder?.cancel();
  resetVoice();
}

// Accumulate one chunk; when the clip is complete, play it.
function receiveVoiceChunk(msg) {
  if (!msg || typeof msg.id !== 'string' || typeof msg.chunk !== 'string') return;
  const total = msg.total | 0;
  const seq = msg.seq | 0;
  if (total < 1 || total > VOICE_MAX_CHUNKS || seq < 0 || seq >= total) return;
  if (msg.chunk.length > VOICE_CHUNK * 2) return;
  if (voiceInbox.size > 8 && !voiceInbox.has(msg.id)) voiceInbox.clear(); // drop stragglers
  let e = voiceInbox.get(msg.id);
  if (!e) { e = { from: msg.from, mime: msg.mime, total, parts: new Array(total), got: 0 }; voiceInbox.set(msg.id, e); }
  if (e.parts[seq] === undefined) { e.parts[seq] = msg.chunk; e.got += 1; }
  if (e.got === e.total) {
    voiceInbox.delete(msg.id);
    enqueueVoice(base64ToBlob(e.parts.join(''), e.mime || 'audio/webm'), e.from || 'Player');
  }
}

const VOICE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
const VOICE_GRACE_MS = 5000; // linger after a clip finishes, so it can be replayed

// A new clip joins the badge stack and auto-plays when it's next in line.
function enqueueVoice(blob, from) {
  const clip = {
    id: `v${voiceClipSeq++}`, from,
    url: URL.createObjectURL(blob), audio: null, state: 'queued', dismiss: 0,
  };
  voiceClips.push(clip);
  renderVoiceBadges();
  autoplayVoice();
}

function autoplayVoice() {
  if (voicePlayingId) return; // something's already playing
  const next = voiceClips.find((c) => c.state === 'queued');
  if (next) playClip(next);
}

// Play (or replay) a specific clip, interrupting whatever's playing.
function playClip(clip) {
  if (voicePlayingId && voicePlayingId !== clip.id) {
    const cur = voiceClips.find((c) => c.id === voicePlayingId);
    if (cur) { try { cur.audio?.pause(); } catch { /* noop */ } cur.state = 'done'; scheduleClipDismiss(cur); }
  }
  clearTimeout(clip.dismiss);
  if (!clip.audio) clip.audio = new Audio(clip.url);
  clip.audio.onended = () => onClipEnded(clip);
  clip.state = 'playing';
  voicePlayingId = clip.id;
  clip.audio.currentTime = 0;
  // Audio is primed from game sounds, so autoplay usually works; if it's blocked
  // the badge stays queued so a tap (a gesture) can play it.
  clip.audio.play().catch(() => {
    if (voicePlayingId === clip.id) voicePlayingId = null;
    clip.state = 'queued';
    renderVoiceBadges();
  });
  renderVoiceBadges();
}

function onClipEnded(clip) {
  if (voicePlayingId === clip.id) voicePlayingId = null;
  clip.state = 'done';
  scheduleClipDismiss(clip);
  renderVoiceBadges();
  autoplayVoice(); // drain the rest of the queue
}

function scheduleClipDismiss(clip) {
  clearTimeout(clip.dismiss);
  clip.dismiss = setTimeout(() => removeClip(clip), VOICE_GRACE_MS);
}

function removeClip(clip) {
  clearTimeout(clip.dismiss);
  try { clip.audio?.pause(); } catch { /* noop */ }
  URL.revokeObjectURL(clip.url);
  if (voicePlayingId === clip.id) voicePlayingId = null;
  voiceClips = voiceClips.filter((c) => c !== clip);
  renderVoiceBadges();
}

function clearVoiceBadges() {
  for (const clip of voiceClips) {
    clearTimeout(clip.dismiss);
    try { clip.audio?.pause(); } catch { /* noop */ }
    URL.revokeObjectURL(clip.url);
  }
  voiceClips = [];
  voicePlayingId = null;
  renderVoiceBadges();
}

// The badge stack (top-left), oldest first; the playing one is highlighted.
function renderVoiceBadges() {
  const box = $('#voice-badges');
  box.textContent = '';
  for (const clip of voiceClips) {
    const badge = document.createElement('div');
    badge.className = `voice-badge${clip.state === 'playing' ? ' playing' : ''}`;
    const label = document.createElement('span');
    label.textContent = `🔊 ${clip.from}`;
    const btn = document.createElement('button');
    btn.className = 'voice-replay';
    btn.title = 'Play';
    btn.setAttribute('aria-label', `Play ${clip.from}'s message`);
    btn.innerHTML = VOICE_ICON;
    btn.addEventListener('click', () => playClip(clip));
    badge.append(label, btn);
    box.append(badge);
  }
  box.classList.toggle('hidden', voiceClips.length === 0);
  if (voiceClips.length) {
    const hdr = $('#game-header');
    box.style.top = `${(hdr?.offsetHeight || 0) + 10}px`;
  }
}

function teardownVoice() {
  voiceRecorder?.teardown();
  voiceRecorder = null;
  voiceBlob = null;
  voiceInbox.clear();
  clearVoiceBadges();
  setVoiceState('idle');
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
  } else if (msg.t === MSG.VOICE) {
    broadcast(msg, conn);   // relay to the rest of the room
    receiveVoiceChunk(msg); // and play it here too
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
  } else if (msg.t === MSG.VOICE) {
    receiveVoiceChunk(msg);
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

// Name-entry screen: Player 1 (bottom) defaults to the home-screen name, Player
// 2 (top) is remembered from last time.
function startLocalSetup() {
  $('#local-p1').value = getProfile().name || '';
  $('#local-p2').value = localStorage.getItem('gobblet.p2name') || '';
  show('screen-local');
}

function startLocal() {
  primeAudio();
  const p1 = $('#local-p1').value.trim() || activeTheme.playerNames[0];
  const p2 = $('#local-p2').value.trim() || activeTheme.playerNames[1];
  if ($('#local-p1').value.trim()) saveProfile({ name: $('#local-p1').value.trim() });
  localStorage.setItem('gobblet.p2name', $('#local-p2').value.trim());
  teardown();
  session = {
    // Fixed orientation: Player 1 (seat 0) always at the bottom, Player 2 at the
    // top. The board never flips; each player acts on their own turn.
    mode: 'local', isHost: true, myPlayer: null,
    names: [p1, p2],
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
    aiForget: new Set(), // pieces the computer has forgotten are buried (imperfect memory)
  };
  enterGame();
  maybeAIMove();
}

// Difficulty = how long the computer "thinks" before moving. A slower opponent
// accrues more time, so it's easier to out-pace on the tug-of-war clock.
const AI_THINK_BASE = { easy: 6000, medium: 5000, hard: 4000 };

// Difficulty also controls the computer's MEMORY — see FORGET_PROB in ai.js.
//
// The think delay for one move: the difficulty's base time with a ±50% jitter.
// We also record this as the AI's move time so the tug clock reflects deliberate
// thinking, not real wall-clock (which balloons if the tab is backgrounded).
//
// In tug-of-war the computer never loses on time: if its remaining budget is
// tight it "thinks faster", capping the delay below what's left — but still
// jittered so it looks variable rather than snapping to a constant.
function aiThinkMs() {
  const gs = gameSettings();
  // Deliberate slow thinking only matters on the tug-of-war clock; in every
  // other mode the computer just moves promptly.
  if (gs.timerMode !== 'tug' || session?.mode !== 'ai') {
    return 450 + Math.round(Math.random() * 300); // ~0.45–0.75s: snappy, not instant
  }
  const base = AI_THINK_BASE[gs.aiDifficulty] || AI_THINK_BASE.medium;
  let think = Math.round(base * (0.5 + Math.random()));
  const t = liveTimeUsed();
  const budgetMs = gs.timerThreshold * 1000 - (t[session.aiPlayer] - t[session.human]);
  const safeCap = Math.max(0, budgetMs - 500); // stay 0.5s clear of the line
  if (think > safeCap) think = Math.round(safeCap * (0.4 + Math.random() * 0.5)); // 40–90% of what's left
  return Math.max(50, think); // always a tiny beat, never a truly instant move
}

// If it's the computer's turn, think then play (and present it like an
// opponent's move — chime + animation).
function maybeAIMove() {
  if (!session || session.mode !== 'ai' || session.aiThinking) return;
  if (session.state.winner !== null || session.state.turn !== session.aiPlayer) return;
  session.aiThinking = true;
  const mine = session;
  const think = aiThinkMs();
  session.aiTimer = setTimeout(() => {
    if (session !== mine || session.mode !== 'ai') return;
    session.aiThinking = false;
    if (session.state.winner !== null || session.state.turn !== session.aiPlayer) return;
    const move = chooseMove(session.state, session.aiPlayer, gameSettings().aiType, {
      forgotten: session.aiForget,
      prob: FORGET_PROB[gameSettings().aiDifficulty] || 0,
    });
    if (!move) return;
    const res = applyMove(session.state, move, { ms: think });
    if (!res.ok) return;
    session.state = res.state;
    presentOpponentMove(move);
  }, think);
}

// --- game screen ----------------------------------------------------------------

function bottomPlayer() {
  // Orientation only. Net: the local player (seat 0 for a spectator). Vs
  // computer: the human. Local pass & play: always Player 1 — the board doesn't
  // flip, so Player 2 plays from the top.
  if (session.mode === 'net') return session.myPlayer == null ? 0 : session.myPlayer;
  if (session.mode === 'ai') return session.human;
  return 0;
}

// The player whose pieces are interactive right now (the one to move). Matches
// the bottom seat except in local pass & play, where the actor may be Player 2
// at the top.
function actingPlayer() {
  if (!session?.state) return 0;
  if (session.mode === 'local') return session.state.turn;
  if (session.mode === 'ai') return session.human;
  return session.myPlayer == null ? 0 : session.myPlayer;
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
    getActor: actingPlayer,
    canAct,
    // Highlight is a game setting (shared); input mode is a device preference.
    getSettings: () => ({
      highlightMoves: gameSettings().highlightMoves,
      inputMode: getProfile().settings.inputMode,
    }),
    legalTargets: (sel) => legalTargetsFor(session.state, actingPlayer(), sel),
    attemptMove: onLocalMoveAttempt,
  });
}

function enterGame() {
  show('screen-game');
  hideBanner();
  hideGameOver();
  resetVoice();
  clearVoiceBadges();
  $('#btn-voice').classList.toggle('hidden', session.mode !== 'net'); // voice is for online games
  $('#btn-reconnect').classList.add('hidden');
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
    rows.push(['When time’s up', gs.penaltyMode === 'automove' ? 'Random auto-move' : 'No penalty']);
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
  // animateMove settles the state first (starting the clock against the new
  // current player at submit), then glides cosmetically — no freeze needed.
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

// Per-turn "auto-move" penalty: the current player ran out, so we play a random
// move on their behalf. Unlike a normal local move, present it — a fleeting
// banner, the opponent-move sound, and (if enabled) the piece gliding into
// place — so the player sees what happened rather than the board just changing.
function fireAutoMove(player) {
  const move = randomMove(session.state, player);
  if (!move) return;
  const ms = Date.now() - (session.turnStart || Date.now());
  const res = applyMove(session.state, move, { ms });
  if (!res.ok) return;
  session.state = res.state;
  if (session.mode === 'net') {
    if (session.isHost) broadcast({ t: MSG.STATE, state: session.state, move, by: player });
    else sendToHost({ t: MSG.MOVE, move });
  }
  showBanner('⏱ Time’s up — auto-move');
  playSound(getProfile().settings.moveSound);
  const settle = () => {
    afterStateChange();
    if (session.state.winner === null) setTimeout(hideBannerIfPlaying, 1600);
    if (session.mode === 'ai') maybeAIMove();
  };
  const animate = getProfile().settings.animateMoves && boardView
    && !$('#screen-game').classList.contains('hidden');
  // Fly from whichever reserve holds this player's pieces (bottom for the
  // bottom seat; top for Player 2 in fixed-orientation pass & play).
  if (animate) boardView.animateMove(move, settle, player === bottomPlayer());
  else settle();
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
  let msg;
  if (session.mode === 'local' || !isPlayer) {
    msg = loser != null
      ? `${nm(loser)} ran out of time — ${nm(1 - loser)} wins! 🏆`
      : `${nm(winner)} wins! 🏆`;
  } else if (loser != null) {
    msg = loser === session.myPlayer
      ? 'You ran out of time' : `${opponentName()} ran out of time — you win! 🏆`;
  } else {
    msg = winner === session.myPlayer ? 'You win! 🏆' : `${opponentName()} wins`;
  }
  showGameOver(msg, isPlayer);
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
    const nm = (p) => session.names[p] || activeTheme.playerNames[p];
    $('#game-players').innerHTML = `${dot(0)} <b>${escape(nm(0))}</b> vs ${dot(1)} <b>${escape(nm(1))}</b>`;
    $('#game-turn').textContent = s.winner === null ? `${escape(nm(s.turn))} to move${round}` : '';
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

// The end-of-game overlay: result text plus its own actions (Stats, optionally
// Rematch, Leave). Unlike the informational banner it's interactive, so it lives
// separately. Showing it replaces the transient banner.
function showGameOver(text, canRematch) {
  hideBanner();
  $('#game-over-msg').textContent = text;
  $('#btn-rematch').classList.toggle('hidden', !canRematch);
  $('#game-over').classList.remove('hidden');
}

function hideGameOver() {
  $('#game-over').classList.add('hidden');
  $('#btn-rematch').classList.add('hidden'); // reset for the next game
}

function requestRematch() {
  if (session.role === 'spectator') return;
  if (session.mode === 'local' || session.mode === 'ai') {
    resetClockAndAI();
    session.state = newSessionGame(session.state.winner === 0 ? 1 : 0);
    hideBanner();
    hideGameOver();
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
  resetClockAndAI();
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

  // ---- AI simulations (home → Sims) ----------------------------------------
  // Results are cached in localStorage: the opponents' logic doesn't change
  // between visits, so there's no reason to recompute — we only re-run on
  // demand. You can filter to one contender (type + difficulty) and read its
  // record against the whole field, with the move count of every game.
  const SIMS_KEY = 'gobblet.sims';
  const capWord = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const describeContender = (c) =>
    c.type === 'random' ? 'Random' : `${capWord(c.type)} · ${capWord(c.difficulty)}`;
  const contenderByKey = (k) => CONTENDERS.find((c) => contenderKey(c) === k);

  const SIMS_VERSION = 2;
  let simsData = null;    // last run (from storage or freshly computed)
  let simsRunning = false;
  // Two tabs pick what's shown. The Leaderboards tab is one sortable table;
  // the By-player tab uses the View dropdown to pick a contender.
  let simsTab = 'leaderboards'; // 'leaderboards' | 'players'
  let leaderSort = 'total';     // 'total' | 'first' | 'second' — the ranked column
  let playerView = contenderKey(CONTENDERS[0]);

  const loadSims = () => {
    try {
      const d = JSON.parse(localStorage.getItem(SIMS_KEY));
      return d && d.version === SIMS_VERSION ? d : null; // ignore an old schema
    } catch { return null; }
  };
  const saveSims = (d) => {
    try { localStorage.setItem(SIMS_KEY, JSON.stringify(d)); } catch { /* quota */ }
  };

  // One row per pairing the contender `key` took part in, from its perspective.
  // In a mirror both seats are the contender, so we read seat A as "us". Each
  // game carries its result (W/L/D), move count, and short history id; games
  // whose id repeats within the pairing are flagged as duplicates.
  function recordsFor(key) {
    const rows = [];
    for (const m of simsData.matchups) {
      const aK = contenderKey(m.a);
      const bK = contenderKey(m.b);
      if (aK !== key && bK !== key) continue;
      const mirror = aK === bK;
      const meIsA = aK === key;
      const opp = mirror ? m.a : (meIsA ? m.b : m.a);
      let w = 0;
      let l = 0;
      let d = 0;
      const seen = new Set();
      const games = m.games.map((g, i) => {
        let res;
        if (g.winner === null) { d += 1; res = 'D'; }
        else if ((g.winner === 0) === meIsA) { w += 1; res = 'W'; }
        else { l += 1; res = 'L'; }
        const dup = seen.has(g.id);
        seen.add(g.id);
        // Did the shown contender move first this game? (first is the seat 0/1.)
        const mineFirst = (g.first === 0) === meIsA;
        return { n: i + 1, res, turns: g.turns, id: g.id, dup, mineFirst };
      });
      rows.push({ opp, mirror, w, l, d, games });
    }
    return rows;
  }

  // Standings for every contender against the field (self-play excluded), split
  // three ways: overall, and restricted to games where the contender moved
  // first / second — first-move advantage tends to matter. Each split gets a
  // rank (1 = best by win differential; ties share a rank).
  function standings() {
    const rows = CONTENDERS.map((c) => {
      const key = contenderKey(c);
      const acc = {
        total: { w: 0, l: 0, d: 0 }, first: { w: 0, l: 0, d: 0 }, second: { w: 0, l: 0, d: 0 },
      };
      for (const m of simsData.matchups) {
        const aK = contenderKey(m.a);
        const bK = contenderKey(m.b);
        if (aK === bK) continue; // skip self-play
        if (aK !== key && bK !== key) continue;
        const meIsA = aK === key;
        for (const g of m.games) {
          const mineFirst = (g.first === 0) === meIsA;
          for (const bucket of ['total', mineFirst ? 'first' : 'second']) {
            const t = acc[bucket];
            if (g.winner === null) t.d += 1;
            else if ((g.winner === 0) === meIsA) t.w += 1;
            else t.l += 1;
          }
        }
      }
      for (const cat of ['total', 'first', 'second']) acc[cat].diff = acc[cat].w - acc[cat].l;
      return { c, key, ...acc };
    });
    // Assign a rank per category (competition ranking: equal diff → equal rank).
    for (const cat of ['total', 'first', 'second']) {
      const sorted = [...rows].sort((a, b) => b[cat].diff - a[cat].diff);
      let rank = 0;
      let prev = null;
      sorted.forEach((r, i) => {
        if (r[cat].diff !== prev) { rank = i + 1; prev = r[cat].diff; }
        r[cat].rank = rank;
      });
    }
    return rows;
  }

  const recordHTML = (w, l, d) =>
    `<span class="sim-rec">${w}<i>–</i>${l}${d ? `<i>–</i>${d}` : ''}</span>`;

  // One category cell: rank (#) over the W–L(–D) record.
  const statCell = (t, active) =>
    `<span class="sim-td stat${active ? ' active' : ''}"><b class="rk">#${t.rank}</b>` +
    `<span class="rec">${t.w}–${t.l}${t.d ? `–${t.d}` : ''}</span></span>`;

  function renderSims() {
    if (!simsData) return;
    let dupNote = false;
    let html;
    if (simsTab === 'leaderboards') {
      html = '<div class="sim-caption">Record vs the field — overall, and split by whether the contender moved first or second. The # is its rank in that column; tap a column to sort.</div>';
      const th = (sort, label) =>
        `<button class="sim-th stat sortable${leaderSort === sort ? ' active' : ''}" data-sort="${sort}">${label}${leaderSort === sort ? ' ▾' : ''}</button>`;
      const rows = standings().sort((a, b) => a[leaderSort].rank - b[leaderSort].rank);
      html += `<div class="sim-table">
        <div class="sim-trow sim-thead">
          <span class="sim-td name">Contender</span>
          ${th('total', 'Total')}${th('first', '1st')}${th('second', '2nd')}
        </div>` +
        rows.map((r) => `
          <div class="sim-trow">
            <span class="sim-td name">${describeContender(r.c)}</span>
            ${statCell(r.total, leaderSort === 'total')}${statCell(r.first, leaderSort === 'first')}${statCell(r.second, leaderSort === 'second')}
          </div>`).join('') +
        `</div>`;
    } else {
      const view = playerView;
      const c = contenderByKey(view);
      const rows = recordsFor(view);
      dupNote = rows.some((r) => r.games.some((g) => g.dup));
      html = `<div class="sim-caption">${describeContender(c)} vs each opponent — every game's result, whether it moved first (1st) or second (2nd), turn count, and history id.</div>`;
      html += rows.map((r) => `
        <div class="sim-block">
          <div class="sim-block-head">
            <span class="sim-name">${describeContender(r.opp)}${r.mirror ? ' <em>(mirror)</em>' : ''}</span>
            ${recordHTML(r.w, r.l, r.d)}
          </div>
          <ul class="sim-games">
            ${r.games.map((g) => `<li${g.dup ? ' class="dup"' : ''}><span class="g-res r-${g.res}">${g.res}</span><span class="g-order">${g.mineFirst ? '1st' : '2nd'}</span><span class="g-moves">${g.turns} turns</span><code class="g-id">${g.id}</code></li>`).join('')}
          </ul>
        </div>`).join('');
    }
    if (dupNote) html += `<p class="hint sim-foot">Repeated ids (marked ↺) are the exact same game played twice.</p>`;
    $('#sims-body').innerHTML = html;
    const when = simsData.ranAt ? new Date(simsData.ranAt).toLocaleString() : 'unknown';
    $('#sims-note').textContent =
      `${simsData.total} games · cap ${simsData.turnCap} turns · ${simsData.computeMs} ms compute · last run ${when}`;
  }

  // From the last run we know ms per "slice" (one game per matchup = one full
  // round-robin pass). Project the cost of the current Games-each setting.
  function updateEstimate() {
    const el = $('#sims-estimate');
    const n = Math.max(1, Math.min(50, Math.round(Number($('#sims-games').value) || 6)));
    if (!simsData || !simsData.games) {
      el.textContent = 'Run once to estimate how long a run takes.';
      return;
    }
    const perSlice = simsData.computeMs / simsData.games; // ms for one pass
    const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
    el.textContent =
      `≈ ${fmt(perSlice)} per slice (one game per matchup). Running ${n} → ≈ ${fmt(perSlice * n)}.`;
  }

  async function runSims() {
    if (simsRunning) return;
    simsRunning = true;
    $('#btn-sims-run').disabled = true;
    $('#sims-note').textContent = '';
    $('#sims-body').innerHTML =
      `<div class="sim-progress"><span class="sim-progress-bar"></span></div>` +
      `<p class="hint" id="sims-count">Playing…</p>`;
    const bar = $('#sims-body .sim-progress-bar');
    const count = $('#sims-count');
    // Games per matchup and the turn cap — user-set, clamped to sane ranges. It
    // all runs in this tab, so keep the ceilings modest.
    const games = Math.max(1, Math.min(50, Math.round(Number($('#sims-games').value) || 6)));
    const turnCap = Math.max(10, Math.min(200, Math.round(Number($('#sims-turncap').value) || 50)));
    $('#sims-games').value = games;     // reflect any clamping/rounding
    $('#sims-turncap').value = turnCap;
    const data = await runSimulations({
      games,
      turnCap,
      onProgress: (done, t) => {
        bar.style.width = `${(done / t) * 100}%`;
        count.textContent = `Playing… ${done} / ${t}`;
      },
    });
    data.ranAt = Date.now();
    simsData = data;
    saveSims(data);
    renderSims();
    updateEstimate();
    simsRunning = false;
    $('#btn-sims-run').disabled = false;
  }

  function setSimsTab(tab) {
    simsTab = tab;
    document.querySelectorAll('.sims-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    // The View (contender) dropdown only applies to the By-player tab.
    $('#sims-view-wrap').classList.toggle('hidden', tab !== 'players');
    renderSims();
  }

  function openSims() {
    simsTab = 'leaderboards';
    leaderSort = 'total';
    playerView = contenderKey(CONTENDERS[0]);
    const sel = $('#sims-filter');
    sel.innerHTML = CONTENDERS.map((c) => `<option value="${contenderKey(c)}">${describeContender(c)}</option>`).join('');
    sel.value = playerView;
    document.querySelectorAll('.sims-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'leaderboards'));
    $('#sims-view-wrap').classList.add('hidden');
    show('screen-sims');
    simsData = loadSims();
    $('#sims-games').value = simsData?.games || 6;      // reflect the last run
    $('#sims-turncap').value = simsData?.turnCap || 50;
    updateEstimate();
    if (simsData) renderSims(); // cached — instant
    else runSims();             // first-ever visit: compute once, then cache
  }

  // Prime audio from these gestures so the move chime can play later (autoplay).
  $('#btn-online').addEventListener('click', () => startJoin(pendingInvite || ''));
  $('#btn-create-new').addEventListener('click', () => { primeAudio(); startHosting(); });
  $('#btn-local').addEventListener('click', startLocalSetup);
  $('#btn-local-start').addEventListener('click', startLocal);
  $('#btn-ai').addEventListener('click', startAI);
  $('#btn-game').addEventListener('click', () => gameDialog.open());
  $('#btn-prefs').addEventListener('click', () => prefsDialog.open());
  $('#btn-sims').addEventListener('click', openSims);
  $('#btn-sims-run').addEventListener('click', runSims);
  $('#sims-filter').addEventListener('change', (e) => { playerView = e.target.value; renderSims(); });
  document.querySelectorAll('.sims-tab').forEach((b) => b.addEventListener('click', () => setSimsTab(b.dataset.tab)));
  // Delegated: tapping a leaderboard column header re-sorts by that category.
  $('#sims-body').addEventListener('click', (e) => {
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    leaderSort = th.dataset.sort;
    renderSims();
  });
  $('#sims-games').addEventListener('input', updateEstimate);
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
  $('#btn-voice').addEventListener('click', startVoice);
  $('#btn-voice-send').addEventListener('click', sendVoice);
  $('#btn-voice-review').addEventListener('click', reviewVoice);
  $('#btn-voice-cancel').addEventListener('click', cancelVoice);
  const micOpts = loadMicOpts();
  $('#voice-ns').checked = micOpts.ns;
  $('#voice-agc').checked = micOpts.agc;
  $('#voice-ns').addEventListener('change', onMicOptChange);
  $('#voice-agc').addEventListener('change', onMicOptChange);
  $('#btn-leave').addEventListener('click', confirmLeave);
  $('#btn-over-leave').addEventListener('click', confirmLeave);
  $('#btn-leave-confirm').addEventListener('click', () => { $('#dlg-leave').close(); goHome(); });
  $('#btn-leave-cancel').addEventListener('click', () => $('#dlg-leave').close());
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
