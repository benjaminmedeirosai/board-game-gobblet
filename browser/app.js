// App orchestrator: screen flow, session lifecycle (host / join / local),
// and the glue between the rules engine, board view, and data channel.

import { newGame } from './game/state.js';
import { applyMove, legalTargetsFor } from './game/rules.js';
import {
  createPeer, createOffer, createAnswer, acceptAnswer,
  encodePayload, decodePayload, extractPayload,
} from './net/webrtc.js';
import { MSG, sendMsg, onMessages } from './net/protocol.js';
import { getProfile, saveProfile, recordGame } from './storage/history.js';
import { createBoardView } from './ui/board.js';
import { initShareButtons, renderHistory } from './ui/lobby.js';
import { initSettings } from './ui/settings.js';
import { initNotifications, requestNotifyPermission, notifyIfHidden } from './ui/notify.js';
import theme from '../assets/classic/theme.js';

// Same-origin channel used to relay a reply code from a freshly opened
// #a=<code> link into the already-open host tab (see relayAnswer).
const SIGNAL_CHANNEL = 'gobblet-signal';

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
  if (session?.pc) {
    try { session.pc.close(); } catch { /* already closed */ }
  }
  session?.signal?.close();
  session = null;
  boardView = null;
}

let toastTimer = null;
function showToast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

// Ask for notification permission when entering a net game. If the user
// declines, sync the setting off so the Settings toggle reflects reality,
// and let them know where to turn it back on.
async function promptForNotifications() {
  if (!getProfile().settings.notifyTurns) return;
  const res = await requestNotifyPermission();
  if (res === 'granted' || res === 'unsupported') return;
  saveProfile({ settings: { notifyTurns: false } });
  if (res === 'denied' || res === 'default') {
    showToast('No problem — turn notifications stay off. You can enable them any time in Settings.');
  }
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

function watchConnection(pc) {
  pc.addEventListener('connectionstatechange', () => {
    if (!session) return;
    if (pc.connectionState === 'failed') {
      const msg = 'Connection failed — you may be on networks that block peer-to-peer.';
      setStatus(session.isHost ? '#host-status' : '#join-status', msg, true);
      if (!$('#screen-game').classList.contains('hidden')) showBanner(msg);
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      if (!$('#screen-game').classList.contains('hidden')) showBanner('Opponent disconnected');
    }
  });
}

function bindChannel(channel) {
  session.channel = channel;
  channel.onopen = () => {
    if (session.isHost) hostStartGame();
  };
  channel.onclose = () => {
    if (session && !$('#screen-game').classList.contains('hidden')) {
      showBanner('Opponent disconnected');
    }
  };
  onMessages(channel, {
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
  promptForNotifications();
  teardown();
  session = {
    mode: 'net', isHost: true, myPlayer: 0, names: [name, ''],
    rematch: { me: false, them: false }, recorded: false,
  };
  // Reply codes opened as #a= links land in a new tab; listen for the relay.
  if ('BroadcastChannel' in window) {
    session.signal = new BroadcastChannel(SIGNAL_CHANNEL);
    session.signal.onmessage = (e) => {
      if (e.data?.type !== 'answer' || !session?.isHost || session.channel?.readyState === 'open') return;
      session.signal.postMessage({ type: 'answer-ack' });
      $('#host-answer').value = e.data.payload;
      hostConnect();
    };
  }
  show('screen-host');
  setStatus('#host-status', 'Creating invite…');
  $('#host-answer').value = '';

  session.pc = createPeer();
  watchConnection(session.pc);
  const { channel, sdp } = await createOffer(session.pc);
  bindChannel(channel);

  const payload = await encodePayload({ k: 'o', sdp, n: name });
  const url = `${location.origin}${location.pathname}#j=${payload}`;
  $('#host-offer').value = url;
  initShareButtons($('#host-share'), {
    text: `${name} is inviting you to a game of Gobblet! Open the link, then send back your reply code.`,
    url,
    subject: 'Gobblet game invite',
  });
  setStatus('#host-status', 'Send the invite, then paste your friend’s reply code above.');
}

async function hostConnect() {
  const code = extractPayload($('#host-answer').value);
  if (!code) return setStatus('#host-status', 'That doesn’t look like a reply code.', true);
  try {
    const msg = await decodePayload(code);
    if (msg.k !== 'a') throw new Error('wrong kind');
    session.names[1] = String(msg.n || 'Guest').slice(0, 20);
    setStatus('#host-status', `Connecting to ${session.names[1]}…`);
    await acceptAnswer(session.pc, msg.sdp);
  } catch {
    setStatus('#host-status', 'Could not read that reply code — make sure the whole code was pasted.', true);
  }
}

function hostStartGame() {
  session.state = newGame(Math.random() < 0.5 ? 0 : 1);
  sendMsg(session.channel, { t: MSG.START, state: session.state, names: session.names });
  enterGame();
}

// --- joining ------------------------------------------------------------------

async function startJoin(prefill = '') {
  show('screen-join');
  $('#join-reply').classList.add('hidden');
  setStatus('#join-status', '');
  if (prefill) $('#join-offer').value = prefill;
}

async function joinCreateReply() {
  const name = myName();
  if (!name) { show('screen-home'); return; }
  saveProfile({ name });
  promptForNotifications();
  const code = extractPayload($('#join-offer').value);
  if (!code) return setStatus('#join-status', 'Paste the invite link or code from the host first.', true);

  let offer;
  try {
    offer = await decodePayload(code);
    if (offer.k !== 'o') throw new Error('wrong kind');
  } catch {
    return setStatus('#join-status', 'Could not read that invite — make sure the whole code was pasted.', true);
  }

  teardown();
  session = {
    mode: 'net', isHost: false, myPlayer: 1,
    names: [String(offer.n || 'Host').slice(0, 20), name],
    rematch: { me: false, them: false }, recorded: false,
  };
  session.pc = createPeer();
  watchConnection(session.pc);
  session.pc.addEventListener('datachannel', (e) => bindChannel(e.channel));

  setStatus('#join-status', 'Creating reply code…');
  const { sdp } = await createAnswer(session.pc, offer.sdp);
  const payload = await encodePayload({ k: 'a', sdp, n: name });
  const replyUrl = `${location.origin}${location.pathname}#a=${payload}`;
  $('#join-answer').value = replyUrl;
  initShareButtons($('#join-share'), {
    text: `Here’s my Gobblet reply — open this link on the device where you created the game and it connects automatically:`,
    url: replyUrl,
    subject: 'Gobblet reply code',
  });
  $('#join-reply').classList.remove('hidden');
  setStatus('#join-status', `Send the reply code back to ${session.names[0]}, then keep this page open — the game starts automatically.`);
}

// Opened via a reply link (#a=<code>) — this is a NEW tab on the host's device.
// The live RTCPeerConnection is in the original tab, so hand the code over via
// BroadcastChannel; the host tab auto-connects and acks back.
function relayAnswer(payload) {
  show('screen-home');
  if (!('BroadcastChannel' in window)) {
    setStatus('#home-status', 'Reply received — copy it into the tab where you created the game.', true);
    return;
  }
  setStatus('#home-status', 'Delivering reply to your open game…');
  const ch = new BroadcastChannel(SIGNAL_CHANNEL);
  let acked = false;
  ch.onmessage = (e) => {
    if (e.data?.type !== 'answer-ack') return;
    acked = true;
    ch.close();
    setStatus('#home-status', 'Reply delivered! Switch back to your game tab — the match is starting.');
  };
  ch.postMessage({ type: 'answer', payload });
  setTimeout(() => {
    if (acked) return;
    ch.close();
    setStatus('#home-status',
      'Couldn’t find your open game. Keep the tab where you created the invite open, then tap the reply link again.', true);
  }, 2500);
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
  $('#btn-host-connect').addEventListener('click', hostConnect);
  $('#btn-join-create').addEventListener('click', joinCreateReply);
  $('#btn-rematch').addEventListener('click', requestRematch);
  $('#btn-leave').addEventListener('click', goHome);
  document.querySelectorAll('.btn-back').forEach((b) => b.addEventListener('click', goHome));

  // Arriving via an invite link (#j=<code>) or a reply link (#a=<code>) —
  // either on a fresh page load or via a hash-only navigation while open.
  let pendingInvite = null;
  function checkInviteHash() {
    const m = location.hash.match(/^#([ja])=(.+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (m[1] === 'a') {
      relayAnswer(m[2]);
      return;
    }
    pendingInvite = m[2];
    if ($('#screen-home').classList.contains('hidden')) goHome();
    setStatus('#home-status', 'Game invite detected — enter your name and tap Join Game.');
  }
  window.addEventListener('hashchange', checkInviteHash);
  initNotifications();
  show('screen-home');
  checkInviteHash();
}

boot();
