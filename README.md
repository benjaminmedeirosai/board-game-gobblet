# Gobblet

A mobile-first, serverless implementation of the board game **Gobblet** for the web browser.
Two players connect directly over WebRTC — no game server, no accounts. Invites travel by
link, email, or text message.

**Play:** open `index.html` from any static host (built for GitHub Pages, served from the repo root).

## How multiplayer works

1. The **host** enters a name and taps *Create Game*, which registers a 4-character
   room code with the free public [PeerJS](https://peerjs.com) broker (no account —
   the broker only relays the WebRTC handshake; gameplay itself is peer-to-peer).
2. The host shares the code — spoken aloud, or as a link via the share sheet,
   email, or SMS — and keeps the screen open.
3. The **joiner** enters the code (or taps the link) and the game starts
   automatically. Codes exist only while the host waits, so there's nothing to
   clean up.

The PeerJS library is vendored under `browser/vendor/` so the app stays fully
self-contained on GitHub Pages. If the public broker ever becomes unreliable,
[peerjs-server](https://github.com/peers/peerjs-server) is self-hostable and the
switch is one options object in `browser/net/peer.js`.

No TURN server is configured, so a small share of restrictive networks (symmetric NATs,
some cellular carriers) won't connect — an accepted trade-off for a fully static app.

## Features

- Full Gobblet rules: 4×4 board, 3 nested reserve stacks per player, gobbling,
  the rule of three, reveal-loss, and win detection.
- Pass & Play mode on one device.
- Drag-and-drop or tap-to-select input (setting).
- Optional highlighting of legal moves (setting).
- Local per-opponent game history (localStorage) tracking who hosted and who won.
- Turn notifications while the tab is hidden (opt-in: enabling the toggle in Settings is
  what triggers the browser permission prompt — the app never prompts on its own; and the
  connection dies with the page, so there are no notifications once the site is closed).
- Swappable piece themes under `assets/<theme>/` (v1 ships `classic` SVG goblets).

## Project layout

```
index.html            entry point (GitHub Pages serves this from the root)
assets/classic/       default piece theme (SVG)
browser/
  game/               pure rules engine — no DOM, no network
  net/                WebRTC + manual signaling payloads, data-channel protocol
  ui/                 board rendering, input modes, lobby/share UI, settings
  storage/            profile + game history persistence
  app.js              orchestrator (screens, sessions, message handling)
```

No build step — plain ES modules. Run locally with any static server, e.g.
`python3 -m http.server 8642`, then open `http://localhost:8642`.

## Deploying to GitHub Pages

Push this repo to GitHub, then in **Settings → Pages** choose *Deploy from a branch*,
branch `main`, folder `/ (root)`.
