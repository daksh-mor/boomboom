# BoomBoom e2e tests

Two self-contained end-to-end suites (plain Node scripts, no test framework).
Both expect a running server and exit non-zero on any failed check.

## Socket suite — `socket.test.mjs`

Exercises the whole room protocol against the real server on :3001: create/join,
color assignment, duplicate-join idempotency, non-host start rejection, the
15Hz `players:state` relay (rate + verbatim payloads + sender's own id),
host migration (mid-game disconnect and lobby `room:leave`), late join into a
started room, name sanitization, the 8-player cap, bad-code errors, the
`net:ping` echo, the full combat loop (shoot → damage → kill → score →
respawn, cooldown/dead/far-claim rejections, kills-mode and timed-mode match
end + room reset), and the Doodle Royale director (rounds, lava/pulse
eliminations, erasure warfare, pity ink, quips, podium, late-join benching).
The party section needs the `BOOM_PARTY_*` knobs on both sides (see the file
header) or it prints SKIP.

```bash
npm run dev          # or: npm run build && npm start
npm run e2e:socket   # SERVER_URL=... to override http://localhost:3001
```

For all 185 checks, boot the server and the test with the same shortened
combat and party timers:

```bash
PORT=3104 BOOM_MATCH_TIME_MS=2000 BOOM_RESET_DELAY_MS=600 \
  BOOM_PARTY_ROUNDS=2 BOOM_PARTY_INTERMISSION_MS=1500 \
  BOOM_PARTY_ROUND_MS=6000 BOOM_PARTY_PODIUM_MS=2000 \
  BOOM_PARTY_FORCE_KIND=rising-ink,draw-duel npm start -w server

SERVER_URL=http://localhost:3104 BOOM_MATCH_TIME_MS=2000 BOOM_RESET_DELAY_MS=600 \
  BOOM_PARTY_ROUNDS=2 BOOM_PARTY_INTERMISSION_MS=1500 \
  BOOM_PARTY_ROUND_MS=6000 BOOM_PARTY_PODIUM_MS=2000 \
  BOOM_PARTY_FORCE_KIND=rising-ink,draw-duel npm run e2e:socket
```

## Browser suite — `browser.test.mjs`

Drives two headless chromium pages (Playwright) through the real UI:
create → bad-code toast → join → lobby roster/host gating + mode selector
(all 5 modes, wrap check at phone width) → start → combat HUD (health bar,
ammo, FPS+ping chip, hold-Tab scoreboard, endless has no timer) + WebGL
rendering → WASD movement propagating over websocket at ~15Hz → leave →
re-create into a timed match (renderer dispose/re-init path + countdown
chip) → escape mode → a full DOODLE ROYALE match (a third headless-socket
"survivor bot" keeps rounds alive while both pages get flooded: round cards,
announcer + quips, PTS relabel, ELIMINATED overlays, an intermission drawing
swallowed by the finale tide, podium + SAVE THE ART, auto-reset to lobby).
Fails on any console error or page error. Saves screenshots to
`/tmp/boomboom-shooter.png`, `/tmp/boomboom-lobby.png`,
`/tmp/boomboom-escape.png` and `/tmp/boomboom-party-{lobby,card,flood,podium}.png`;
override with `*_SCREENSHOT_PATH` env vars. Run it against a server booted
without the match-timer overrides (the timed-mode check expects the real 5:00
clock) but WITH the party knobs from the file header, mirrored on the test —
the party section prints SKIP otherwise.

One-time setup (downloads chromium into Playwright's cache):

```bash
npx playwright install chromium
```

Run against the dev server (default `http://localhost:5173/`):

```bash
npm run dev
npm run e2e:browser
```

Run against the production server:

```bash
npm run build
PORT=3105 BOOM_PARTY_ROUNDS=2 BOOM_PARTY_INTERMISSION_MS=8000 \
  BOOM_PARTY_ROUND_MS=9000 BOOM_PARTY_PODIUM_MS=14000 \
  BOOM_PARTY_FORCE_KIND=rising-ink npm start -w server

APP_URL=http://localhost:3105/ BOOM_PARTY_ROUNDS=2 \
  BOOM_PARTY_INTERMISSION_MS=8000 BOOM_PARTY_ROUND_MS=9000 \
  BOOM_PARTY_PODIUM_MS=14000 BOOM_PARTY_FORCE_KIND=rising-ink \
  npm run e2e:browser
```

Notes:

- Headless chromium renders WebGL through SwiftShader (software GL) — slow
  (~5–10fps) but correct; the suite's thresholds account for that.
- Pointer lock and touch input cannot be meaningfully verified headless;
  check those by hand on a desktop browser and a phone.
