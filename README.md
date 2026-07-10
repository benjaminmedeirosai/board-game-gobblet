# Gobblet

A mobile-first, serverless implementation of the board game **Gobblet** for the web browser.
Two players connect directly over WebRTC — no game server, no accounts. Invites travel by
link, email, or text message.

**Play:** open `index.html` from any static host (built for GitHub Pages, served from the repo root).

## How multiplayer works

1. The **host** enters a name and taps *Create Game*. The app packs the full WebRTC offer
   (SDP + ICE candidates, compressed) into a single invite link.
2. The host shares the link via the share sheet, email, or SMS.
3. The **joiner** opens the link, enters a name, and generates a *reply link*, which they
   send back to the host the same way.
4. The host opens the reply link on the device where the game tab is open — a relay
   (BroadcastChannel) hands the code to the game tab, which connects automatically.
   Pasting the code manually into the game tab works too.

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
