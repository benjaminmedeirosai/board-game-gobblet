// Room-code signaling via PeerJS and its free public cloud broker (no account
// or key). The broker only relays the WebRTC handshake — gameplay itself stays
// peer-to-peer. Uses the vendored UMD bundle (window.Peer) loaded in index.html.

const ID_PREFIX = 'gobblet-x7q-'; // namespace our room codes within the shared public broker
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I lookalikes
export const CODE_LENGTH = 4;

const PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    ],
  },
};

export function makeCode() {
  const chars = crypto.getRandomValues(new Uint32Array(CODE_LENGTH));
  return [...chars].map((n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

export function normalizeCode(text) {
  const cleaned = String(text || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
  return cleaned.length === CODE_LENGTH ? cleaned : null;
}

// Registers a room code with the broker. Resolves with the open Peer; rejects
// on 'unavailable-id' (code collision — retry with a fresh code) and other
// broker errors. The caller listens for peer.on('connection').
export function hostRoom(code) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(ID_PREFIX + code, PEER_OPTIONS);
    peer.once('open', () => resolve(peer));
    peer.once('error', (err) => {
      peer.destroy();
      reject(err);
    });
  });
}

// Connects to a host's room code. Resolves with the OPEN DataConnection.
export function joinRoom(code, name) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(PEER_OPTIONS);
    peer.once('error', (err) => {
      peer.destroy();
      reject(err);
    });
    peer.once('open', () => {
      const conn = peer.connect(ID_PREFIX + code, {
        reliable: true,
        metadata: { name },
      });
      conn.once('open', () => resolve(conn));
    });
  });
}

// PeerJS error types worth a human message.
export function describePeerError(err) {
  switch (err?.type) {
    case 'peer-unavailable':
      return 'No game found with that code — check it with the host (codes expire when they leave).';
    case 'unavailable-id':
      return 'Room code collision — try again.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Couldn’t reach the matchmaking service — check your connection and try again.';
    case 'browser-incompatible':
      return 'This browser doesn’t support peer-to-peer connections.';
    default:
      return 'Connection failed — please try again.';
  }
}
