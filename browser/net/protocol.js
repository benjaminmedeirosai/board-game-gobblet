// Message protocol spoken over the PeerJS data connection.
//
//  start   host -> guest   { t, state, names:[hostName, guestName] }  (also used for rematch)
//  move    guest -> host   { t, move }   proposed move; host validates
//  state   host -> guest   { t, state }  authoritative state after any move
//  rematch either way      { t }         request/agree to a rematch
//  timeout guest -> host   { t }         "I ran out on the tug-of-war clock"
//
// Messages travel as JSON strings; the guest's name arrives out-of-band in
// conn.metadata when they connect.

export const MSG = {
  START: 'start',
  MOVE: 'move',
  STATE: 'state',
  REMATCH: 'rematch',
  TIMEOUT: 'timeout',
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
