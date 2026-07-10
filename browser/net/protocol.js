// Message protocol spoken over the WebRTC data channel.
//
//  start   host -> guest   { t, state, names:[hostName, guestName] }  (also used for rematch)
//  move    guest -> host   { t, move }   proposed move; host validates
//  state   host -> guest   { t, state }  authoritative state after any move
//  rematch either way      { t }         request/agree to a rematch

export const MSG = {
  START: 'start',
  MOVE: 'move',
  STATE: 'state',
  REMATCH: 'rematch',
};

export function sendMsg(channel, msg) {
  if (channel && channel.readyState === 'open') {
    channel.send(JSON.stringify(msg));
  }
}

export function onMessages(channel, handlers) {
  channel.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handlers[msg?.t]?.(msg);
  };
}
