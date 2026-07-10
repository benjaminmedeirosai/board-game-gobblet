// WebRTC peer connection with manual (out-of-band) signaling.
// The full offer/answer — SDP plus all ICE candidates — is packed into a single
// compressed, base64url payload that players share via link, email, or text.

const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ],
};

const PREFIX_DEFLATE = 'GBLT1.';
const PREFIX_RAW = 'GBLT1R.';

export function createPeer() {
  return new RTCPeerConnection(RTC_CONFIG);
}

// Non-trickle ICE: wait until gathering completes (or times out) so the local
// description contains every candidate and fits in one shareable payload.
function waitForIce(pc, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(finish, timeoutMs);
    function onChange() {
      if (pc.iceGatheringState === 'complete') finish();
    }
    function finish() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export async function createOffer(pc) {
  const channel = pc.createDataChannel('game');
  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce(pc);
  return { channel, sdp: pc.localDescription.sdp };
}

export async function createAnswer(pc, offerSdp) {
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForIce(pc);
  return { sdp: pc.localDescription.sdp };
}

export async function acceptAnswer(pc, answerSdp) {
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
}

// --- payload encoding -------------------------------------------------------

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  let s = str.replaceAll('-', '+').replaceAll('_', '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

async function pipeThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePayload(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === 'function') {
    const packed = await pipeThrough(raw, new CompressionStream('deflate-raw'));
    return PREFIX_DEFLATE + b64urlEncode(packed);
  }
  return PREFIX_RAW + b64urlEncode(raw);
}

export async function decodePayload(payload) {
  let bytes;
  if (payload.startsWith(PREFIX_DEFLATE)) {
    const packed = b64urlDecode(payload.slice(PREFIX_DEFLATE.length));
    bytes = await pipeThrough(packed, new DecompressionStream('deflate-raw'));
  } else if (payload.startsWith(PREFIX_RAW)) {
    bytes = b64urlDecode(payload.slice(PREFIX_RAW.length));
  } else {
    throw new Error('Not a Gobblet code');
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Finds a Gobblet code inside arbitrary pasted text (an email, a link, etc.).
export function extractPayload(text) {
  const m = String(text || '').match(/GBLT1R?\.[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}
