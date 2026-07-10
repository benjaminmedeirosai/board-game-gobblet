# Gobblet — Browser Board Game: Requirements

Mobile-first, peer-to-peer Gobblet playable in a web browser, hosted on GitHub Pages.

## 1. Hosting & Project Structure

- Static site on **GitHub Pages**, served from the **repo root** (not `/docs`).
- `index.html` lives at the root and is the single entry point.
- All application code lives in a `browser/` folder, organized into modules.
- No build step required (plain ES modules), so the repo deploys to Pages as-is.

Proposed layout:

```
/
├── index.html
├── REQUIREMENTS.md
├── assets/
│   └── classic/            # default SVG goblet theme (more themes later)
├── browser/
│   ├── game/               # pure game logic — no DOM, fully testable
│   │   ├── state.js        # board, stacks, turn, serialization
│   │   ├── rules.js        # legal moves, captures, rule-of-three, win detection
│   │   └── moves.js        # apply/validate move objects
│   ├── net/
│   │   ├── webrtc.js       # peer connection, data channel, offer/answer payloads
│   │   └── protocol.js     # message types exchanged over the data channel
│   ├── ui/
│   │   ├── board.js        # 4×4 grid rendering, piece rendering
│   │   ├── input.js        # drag-and-drop + tap-tap input modes
│   │   ├── lobby.js        # create/join game screens
│   │   └── settings.js     # settings dialog
│   ├── storage/
│   │   └── history.js      # player profile + game history (localStorage/IndexedDB)
│   └── app.js              # bootstraps screens, routes between lobby and game
```

## 2. Game Rules (Gobblet, 4×4)

- **Board:** 4×4 grid.
- **Pieces:** each player has **3 stacks of 4 nested pieces** (sizes S < M < L < XL), 12 pieces total per player.
- Only the **top (largest exposed) piece of each stack** may be played — so players necessarily start by placing XLs.
- **Placing from a stack (reserve):** a new piece may only be placed on an **empty square**…
- **…except the "rule of three":** if your opponent has **three visible pieces in a row** (row, column, or diagonal), you may play a piece from your reserve stack **directly on top of one of those three pieces** (gobbling it). This is the rule you half-remembered.
- **Moving on the board:** a piece already on the board may move to any square and may gobble **any smaller piece — yours or your opponent's**.
- **Gobbled pieces stay on the board**, hidden underneath. Moving a piece off a square reveals whatever was underneath.
- **Reveal hazard:** lifting your piece may reveal an opponent piece that completes their four-in-a-row. In the physical game, if you've lifted a piece and the reveal gives the opponent four in a row, you lose unless your lifted piece can be placed to break that line. Digital adaptation: we resolve win checks **after** the full move completes; if the mover's own move reveals an opponent four-in-a-row that still stands after their piece lands, the opponent wins immediately.
- **Win condition:** four **visible** pieces of your color in a row (row, column, or diagonal).
- **Simultaneous lines:** if a move creates four-in-a-row for both players (via a reveal), the player whose line was revealed (the non-mover) wins per standard rules.

## 3. Architecture: Game State

- Game logic is a **pure module** (no DOM, no network): state in → move → new state out.
- State includes: board (each cell is a stack), both reserves, whose turn, move history.
- Serializable to JSON so it can travel over the data channel and be persisted.
- The **host is authoritative**: both sides run the same rules engine, but the host's state resolves any disagreement. Guests send proposed moves; host validates, applies, and broadcasts.

## 4. Connectivity: WebRTC (manual signaling)

No signaling server — connection info travels out-of-band ("copy/share the code"):

1. **Host** enters their name, taps "Create Game." App creates an `RTCPeerConnection` + data channel, waits for **ICE gathering to complete**, then packs the full offer (SDP + ICE candidates) into a **single compact payload** (compressed + base64/base64url).
2. Host shares the payload with the other player via:
   - **Share button** → native share sheet (Web Share API — covers Messages, Mail, etc. on mobile),
   - explicit **Email** (`mailto:`) and **Text** (`sms:`) buttons as fallbacks,
   - **Copy to clipboard**.
3. **Joiner** enters their name, pastes the payload (or opens a link that carries it, e.g. `index.html#j=<payload>`), and the app generates an **answer payload** the same way.
4. ⚠️ **The answer must travel back to the host** — WebRTC requires the round trip. Same share UI on the joiner's side; host pastes the answer to complete the connection.
5. Once the data channel opens, both players land in the game room.

Notes / accepted limitations:
- **STUN only, no TURN server** — keeps it serverless/free, but peers behind symmetric NATs (~10–15% of network pairs, some cellular carriers) won't connect. Acceptable for v1.
- SDP payloads are a few KB; we'll **compress and minify** them so they fit reasonably in a text message, and prefer link-format payloads so the joiner just taps the link.
- **Lobby/room abstraction:** the UI and code are structured around a "game room" concept (room ID, players list, host flag) even though v1 only supports one host + one guest, so later extensions (signaling server, matchmaking, spectators, rematch) slot in.

## 5. Player Identity & History

- Host and joiner each enter a **display name** before connecting.
- Local persistence (start with `localStorage`, move to IndexedDB if it grows):
  - **My profile:** my name, preferred settings.
  - **Opponents object:** keyed per opponent, each holding an **array of games** played against them — date, who hosted, winner, move count (and optionally the full move list for replay later).
- All history is local to the device; no server, no accounts.

## 6. UI / UX

- **Mobile-first, portrait.** Desktop just gets a centered mobile-ish layout; no separate desktop design.
- Screens: **Home → Create/Join flow → Game room → Game board**, plus Settings dialog and History view.
- **Board:** 4×4 grid sized to the viewport; player's reserve stacks docked below (opponent's above).
- **Pieces:** SVG "inverted cup" goblets in each player's color; nesting shown by size. Stacked cells show only the top piece (maybe a subtle indicator that pieces are hidden underneath).
- **Input:**
  - Default: **drag and drop** (touch-friendly, with the piece lifting/enlarging under the finger).
  - Alternate: **tap-tap mode** — tap a piece to select (it lifts/highlights with a shadow), tap the destination cell to move.
- Turn indicator, opponent name/connection status, and a win/lose/draw end screen with rematch option.

## 7. Assets & Theming

- `assets/<theme-name>/` folders; each theme provides art for the 4 sizes × 2 players.
- v1 ships one theme: **classic** — simple SVG goblets, player-selectable colors.
- Theme system is a thin lookup (theme name → image/SVG per size/player) so future themes drop in without code changes. Ideas parked for later: Russian nesting dolls, seed→flower→bush→tree, penny→nickel→quarter→dollar.

## 8. Settings

- Settings button → dialog with flags, persisted locally:
  - **Highlight available moves** — when a piece is selected/dragged, legal destination cells are highlighted.
  - **Input mode** — drag-and-drop vs. tap-tap.
  - (Room to grow: sound, theme picker, color picker.)

## 9. Out of Scope for v1

- Signaling/TURN servers, accounts, matchmaking.
- AI opponent / local pass-and-play (worth considering later — pass-and-play is nearly free once the engine exists and makes testing much easier).
- Spectators, chat, replays (though we store enough history to add replays later).
