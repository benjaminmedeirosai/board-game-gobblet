// Message protocol spoken over the PeerJS data connection.
//
//  start   host -> guest   { t, state, names:[hostName, guestName] }  (also used for rematch)
//  move    guest -> host   { t, move }   proposed move; host validates
//  state   host -> guest   { t, state }  authoritative state after any move
//  rematch either way      { t }         request/agree to a rematch
//  timeout guest -> host   { t }         "I ran out on the tug-of-war clock"
//  ack     guest -> host   { t }         "I've seen the settings — start the clock"
//  voice   either way      { t, id, from, seq, total, mime, chunk }
//                                        one base64 slice of a recorded clip;
//                                        the host relays guests' chunks to the
//                                        rest of the room (star topology)
//
// A start may carry gate:'join'|'settings', meaning the guest must acknowledge
// the game settings before play begins; the host holds the clock until the ack.
//
// Messages travel as JSON strings; the guest's name arrives out-of-band in
// conn.metadata when they connect.

export const MSG = {
  START: 'start',
  MOVE: 'move',
  STATE: 'state',
  REMATCH: 'rematch',
  TIMEOUT: 'timeout',
  ROSTER: 'roster', // host -> all: who's in the room (players + spectators)
  ACK: 'ack', // guest -> host: settings acknowledged, begin the game/clock
  VOICE: 'voice', // either way: a base64 chunk of a recorded voice clip
};

export function sendMsg(conn, msg) {
  if (conn && conn.open) {
    conn.send(JSON.stringify(msg));
  }
}

export function onMessages(conn, handlers) {
  conn.on('data', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    handlers[msg?.t]?.(msg);
  });
}
