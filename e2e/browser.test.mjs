/**
 * Real-browser e2e for BoomBoom: drives two headless chromium pages through
 * create -> bad-code error -> join -> mode selector -> start -> combat HUD ->
 * scoreboard -> move -> leave -> re-create (timed mode) -> escape mode ->
 * Doodle Royale (party mode), asserting UI state, WebGL rendering, websocket
 * traffic, and zero console/page errors.
 *
 * Live firing is deliberately not driven here (pointer lock is unreliable
 * headless); the full combat loop is covered by e2e/socket.test.mjs.
 *
 * Prerequisites:
 *   - dev server up (`npm run dev`), or `npm start` with APP_URL=http://localhost:3001/
 *     (booted WITHOUT the BOOM_MATCH_TIME_MS/BOOM_RESET_DELAY_MS overrides —
 *     the timed-mode check expects the real 5:00 clock)
 *   - chromium once via `npx playwright install chromium`
 *
 * The party flow additionally needs these knobs on BOTH the server and this
 * test (they do not affect the other modes' flows), otherwise it prints SKIP:
 *   BOOM_PARTY_ROUNDS=2 BOOM_PARTY_INTERMISSION_MS=8000 BOOM_PARTY_ROUND_MS=9000 \
 *   BOOM_PARTY_PODIUM_MS=14000 BOOM_PARTY_FORCE_KIND=rising-ink
 *
 * Run: npm run e2e:browser
 * Exits 0 when everything passes.
 */
import { chromium } from 'playwright';
import { io as ioSocket } from 'socket.io-client';

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/';
const SCREENSHOT = process.env.SCREENSHOT_PATH ?? '/tmp/boomboom-shooter.png';
const LOBBY_SCREENSHOT = process.env.LOBBY_SCREENSHOT_PATH ?? '/tmp/boomboom-lobby.png';
const ESCAPE_SCREENSHOT = process.env.ESCAPE_SCREENSHOT_PATH ?? '/tmp/boomboom-escape.png';
const PARTY_LOBBY_SHOT = process.env.PARTY_LOBBY_SCREENSHOT_PATH ?? '/tmp/boomboom-party-lobby.png';
const PARTY_CARD_SHOT = process.env.PARTY_CARD_SCREENSHOT_PATH ?? '/tmp/boomboom-party-card.png';
const PARTY_FLOOD_SHOT = process.env.PARTY_FLOOD_SCREENSHOT_PATH ?? '/tmp/boomboom-party-flood.png';
const PARTY_PODIUM_SHOT = process.env.PARTY_PODIUM_SCREENSHOT_PATH ?? '/tmp/boomboom-party-podium.png';

// Party knobs, mirroring the server's (see the header). The party flow only
// runs with a short deterministic config on both sides.
const PARTY_ROUNDS = Number(process.env.BOOM_PARTY_ROUNDS ?? 5);
const PARTY_INTERMISSION_MS = Number(process.env.BOOM_PARTY_INTERMISSION_MS ?? 8000);
const PARTY_ROUND_MS = Number(process.env.BOOM_PARTY_ROUND_MS ?? 0);
const PARTY_PODIUM_MS = Number(process.env.BOOM_PARTY_PODIUM_MS ?? 14000);
const PARTY_KIND = (process.env.BOOM_PARTY_FORCE_KIND ?? '').trim();
const PARTY_READY =
  PARTY_ROUNDS === 2 &&
  PARTY_KIND === 'rising-ink' &&
  PARTY_ROUND_MS >= 6000 &&
  PARTY_ROUND_MS <= 15000 &&
  PARTY_INTERMISSION_MS >= 2500 &&
  PARTY_INTERMISSION_MS <= 8000 &&
  PARTY_PODIUM_MS >= 4000 &&
  PARTY_PODIUM_MS <= 20000;

const results = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const assert = (name, cond, detail = '') => record(name, !!cond, cond ? '' : detail);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** waitForFunction that reports false on timeout instead of throwing. */
async function eventually(page, fn, timeout) {
  try {
    await page.waitForFunction(fn, undefined, { timeout });
    return true;
  } catch {
    return false;
  }
}

/** Wires console-error/pageerror collection into a page. */
function collectErrors(page, label, sink) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') sink.push(`[${label}] console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => sink.push(`[${label}] pageerror: ${err.message}`));
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    // Software WebGL (SwiftShader) for three.js in headless mode.
    args: ['--enable-unsafe-swiftshader'],
  });

  const errors = [];

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // Tee interesting websocket text frames (state broadcasts + ink objects)
  // into the page, so we can assert what each client receives over the wire.
  for (const ctx of [ctxA, ctxB]) {
    await ctx.addInitScript(() => {
      window.__wsFrames = [];
      window.__inkFrames = [];
      const Orig = window.WebSocket;
      window.WebSocket = class extends Orig {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', (e) => {
            if (typeof e.data !== 'string') return;
            if (e.data.includes('players:state')) {
              window.__wsFrames.push({ t: Date.now(), data: e.data });
            }
            if (e.data.includes('ink:object')) {
              window.__inkFrames.push({ t: Date.now(), data: e.data });
            }
          });
        }
      };
    });
  }

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  collectErrors(pageA, 'A', errors);
  collectErrors(pageB, 'B', errors);

  // ------------------------------------------------------------ landing / create
  await pageA.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await pageA.waitForSelector('.screen-landing');
  assert('A: landing renders', true);

  await pageA.fill('#landing-name', 'Anna');
  await pageA.click('[data-action="create"]');
  await pageA.waitForSelector('.room-code');
  await pageA.waitForFunction(() => (document.querySelector('.room-code')?.textContent ?? '').trim().length === 4);
  const code = (await pageA.textContent('.room-code')).trim();
  assert('A: lobby shows a 4-char room code', /^[A-Z2-9]{4}$/.test(code), code);

  // ------------------------------------------------- bad code -> toast, retry ok
  await pageB.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await pageB.fill('#landing-name', 'Ben');
  const bogus = (code[0] === 'Z' ? 'Y' : 'Z') + code.slice(1);
  await pageB.fill('.code-input', bogus);
  await pageB.click('[data-action="join"]');
  await pageB.waitForSelector('.toast');
  const toastText = await pageB.textContent('.toast');
  assert('B: bad code shows not-found toast', /not found/i.test(toastText), toastText);
  await pageB.waitForFunction(() => !document.querySelector('[data-action="join"]')?.disabled);
  assert('B: join form re-enabled after error', true);

  // ------------------------------------------------------------------- join
  await pageB.fill('.code-input', code);
  await pageB.click('[data-action="join"]');
  await pageB.waitForSelector('.screen-lobby');

  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await page.waitForFunction(() => document.querySelectorAll('.player-list li').length === 2);
    assert(`${label}: lobby lists 2 players`, true);
  }

  const rosterA = await pageA.$$eval('.player-list li', (rows) =>
    rows.map((r) => ({
      name: r.querySelector('.player-name')?.textContent,
      color: r.querySelector('.player-dot')?.style.background,
      tags: [...r.querySelectorAll('.player-tag')].map((t) => t.textContent),
    })),
  );
  assert('A: roster names are Anna, Ben', rosterA.map((r) => r.name).join(',') === 'Anna,Ben', JSON.stringify(rosterA));
  assert('A: colors distinct', new Set(rosterA.map((r) => r.color)).size === 2, JSON.stringify(rosterA.map((r) => r.color)));
  assert('A: Anna tagged host+you', rosterA[0].tags.join('') === 'HOSTYOU', JSON.stringify(rosterA[0].tags));

  assert('A: host sees Start button', (await pageA.$('.lobby-actions .btn-primary')) !== null);
  assert('B: guest sees waiting note, no Start', (await pageB.$('.lobby-actions .btn-primary')) === null && (await pageB.$('.waiting-note')) !== null);

  // ------------------------------------------------- mode selector (host only)
  const modesA = await pageA.$$eval('[data-mode]', (btns) => btns.map((b) => b.dataset.mode));
  assert('A: host sees mode selector with 5 options', modesA.join(',') === 'endless,kills,timed,escape,party', modesA.join(','));
  const activeMode = await pageA.$$eval('.mode-btn.mode-active', (btns) => btns.map((b) => b.dataset.mode));
  assert('A: ENDLESS is the default mode', activeMode.join(',') === 'endless', activeMode.join(','));
  assert('B: guest sees no mode selector', (await pageB.$$('[data-mode]')).length === 0);

  // Five modes must wrap, not overflow, on a phone-sized viewport.
  await pageA.setViewportSize({ width: 390, height: 844 });
  await sleep(150); // reflow
  const modeRow = await pageA.$eval('.mode-row', (el) => ({
    count: el.children.length,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  assert(
    'A: mode row wraps without overflow at 390px',
    modeRow.count === 5 && modeRow.scrollWidth <= modeRow.clientWidth + 1,
    JSON.stringify(modeRow),
  );
  await pageA.setViewportSize({ width: 1280, height: 800 });

  await pageA.screenshot({ path: LOBBY_SCREENSHOT });
  record(`lobby screenshot saved to ${LOBBY_SCREENSHOT}`, true);

  // ------------------------------------------------ mobile overlay tests
  const mobilePortrait = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const portraitPage = await mobilePortrait.newPage();
  await portraitPage.addInitScript(() => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (query === '(pointer: coarse)') {
        return { matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} };
      }
      if (query === '(orientation: portrait)') {
        return { matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} };
      }
      return orig(query);
    };
  });
  await portraitPage.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await portraitPage.waitForSelector('.rotate-overlay');
  assert('portrait mobile shows rotate overlay', true);
  await portraitPage.click('[data-action="dismiss"]');
  await portraitPage.waitForSelector('.screen-landing');
  assert('play anyway dismisses rotate overlay', (await portraitPage.$('.rotate-overlay')) === null);
  await mobilePortrait.close();

  const mobileLandscape = await browser.newContext({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
  });
  const landscapePage = await mobileLandscape.newPage();
  await landscapePage.addInitScript(() => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (query === '(pointer: coarse)') {
        return { matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} };
      }
      if (query === '(orientation: portrait)') {
        return { matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} };
      }
      return orig(query);
    };
  });
  await landscapePage.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await landscapePage.waitForSelector('.screen-landing');
  assert('landscape mobile hides rotate overlay', (await landscapePage.$('.rotate-overlay')) === null);
  await mobileLandscape.close();

  // ------------------------------------------------------------------ start
  await pageA.click('.lobby-actions .btn-primary');
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await page.waitForSelector('.screen-hud');
    await page.waitForFunction(() => document.body.classList.contains('in-game'));
    assert(`${label}: entered game (HUD + in-game canvas)`, true);
  }

  const fsBtn = await pageA.$('[data-action="fullscreen"]');
  assert('fullscreen button visible when supported', fsBtn !== null);
  if (fsBtn) {
    await pageA.evaluate(() => {
      document.documentElement.requestFullscreen = async () => {
        document.dispatchEvent(new Event('fullscreenchange'));
      };
    });
    await pageA.click('[data-action="fullscreen"]');
    await sleep(200);
    assert('fullscreen button responds to click', true);
  }

  // ------------------------------------------------------------ combat HUD
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    assert(`${label}: health bar present`, (await page.$('[data-health-fill]')) !== null);
    const mag = (await page.textContent('[data-ammo-mag]')).trim();
    assert(`${label}: ammo counter reads a full mag (8)`, mag === '8', mag);
  }
  assert('A: timer chip absent in endless mode', await pageA.$eval('[data-timer]', (el) => el.hidden));

  const perfOk = await eventually(
    pageA,
    () => /^\d+ FPS · \d+ MS$/.test(document.querySelector('[data-perf]')?.textContent ?? ''),
    4500,
  );
  const perfText = (await pageA.textContent('[data-perf]')).trim();
  assert('A: perf chip shows FPS + ping within ~4s', perfOk, perfText);
  const perfMatch = perfText.match(/^(\d+) FPS · (\d+) MS$/);
  if (perfMatch) {
    const fps = Number(perfMatch[1]);
    const ping = Number(perfMatch[2]);
    assert('A: FPS plausible (1-1000)', fps >= 1 && fps <= 1000, `${fps} fps`);
    assert('A: ping plausible (0-2000ms)', ping >= 0 && ping <= 2000, `${ping} ms`);
  }

  // ------------------------------------------------- scoreboard on hold-Tab
  assert('A: scoreboard hidden before Tab', await pageA.$eval('[data-scoreboard]', (el) => el.hidden));
  await pageA.keyboard.down('Tab');
  const sbShown = await eventually(pageA, () => document.querySelector('[data-scoreboard]')?.hidden === false, 2000);
  assert('A: holding Tab shows the scoreboard', sbShown);
  const sbNames = await pageA.$$eval('[data-scoreboard] .sb-row .sb-name', (els) => els.map((e) => e.textContent));
  assert(
    'A: scoreboard has a row per player',
    sbNames.length === 2 && sbNames.includes('Anna') && sbNames.includes('Ben'),
    JSON.stringify(sbNames),
  );
  await pageA.keyboard.up('Tab');
  const sbHidden = await eventually(pageA, () => document.querySelector('[data-scoreboard]')?.hidden === true, 2000);
  assert('A: releasing Tab hides the scoreboard', sbHidden);

  // WebGL is actually rendering: rAF ticking and canvas has a GL context.
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    const frames = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let n = 0;
          const t0 = performance.now();
          const tick = () => {
            n++;
            if (performance.now() - t0 < 600) requestAnimationFrame(tick);
            else resolve(n);
          };
          requestAnimationFrame(tick);
        }),
    );
    // SwiftShader renders ~5-10fps with two pages sharing the CPU; any steady
    // ticking proves the loop is alive (real GPUs run this at 60fps).
    assert(`${label}: rendering loop alive (${frames} rAF ticks in 600ms)`, frames >= 3, `${frames}`);
  }
  const hudCounts = [await pageA.textContent('.hud-count'), await pageB.textContent('.hud-count')];
  assert('HUD shows 2 players on both pages', hudCounts.every((t) => t.includes('2P')), JSON.stringify(hudCounts));

  // ------------------------------------------------- movement + ws traffic
  await pageB.evaluate(() => (window.__wsFrames.length = 0));
  await pageA.bringToFront().catch(() => {});
  await pageA.keyboard.down('KeyW');
  await sleep(1200);
  await pageA.keyboard.up('KeyW');
  await pageA.keyboard.press('Space');
  await sleep(1800); // keep exchanging state
  const wsReport = await pageB.evaluate(() => {
    const frames = window.__wsFrames;
    const perId = new Map();
    for (const f of frames) {
      let payload;
      try {
        payload = JSON.parse(f.data.slice(f.data.indexOf('[')));
      } catch {
        continue;
      }
      if (payload[0] !== 'players:state') continue;
      for (const st of payload[1].states) {
        const e = perId.get(st.id) ?? { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, n: 0 };
        e.minX = Math.min(e.minX, st.pos.x);
        e.maxX = Math.max(e.maxX, st.pos.x);
        e.minZ = Math.min(e.minZ, st.pos.z);
        e.maxZ = Math.max(e.maxZ, st.pos.z);
        e.n++;
        perId.set(st.id, e);
      }
    }
    const windowMs = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
    return {
      frameCount: frames.length,
      windowMs,
      ids: [...perId.entries()].map(([id, e]) => ({ id, n: e.n, dx: e.maxX - e.minX, dz: e.maxZ - e.minZ })),
    };
  });
  assert('B: received players:state ws frames', wsReport.frameCount > 10, `${wsReport.frameCount}`);
  const hz = wsReport.windowMs > 0 ? ((wsReport.frameCount - 1) / wsReport.windowMs) * 1000 : 0;
  assert('B: ws broadcast rate ~15Hz (11-19)', hz >= 11 && hz <= 19, `${hz.toFixed(1)}Hz`);
  assert('B: frames carry both player ids', wsReport.ids.length === 2, JSON.stringify(wsReport.ids));
  assert(
    'B: sees A actually move (>1m displacement)',
    wsReport.ids.some((e) => Math.hypot(e.dx, e.dz) > 1),
    JSON.stringify(wsReport.ids),
  );

  // ---------------------------------------------------- magic ink: draw + cast
  assert('A: ink meter present in HUD', (await pageA.$('[data-ink-fill]')) !== null);
  const inkStart = (await pageA.textContent('[data-ink-value]')).trim();
  assert('A: ink meter reads the full combat pool', inkStart === '12.0m', inkStart);

  await pageA.keyboard.press('KeyQ');
  const sketchOpen = await eventually(pageA, () => document.querySelector('[data-sketch]')?.hidden === false, 2000);
  assert('A: Q opens sketch mode', sketchOpen);
  assert(
    'A: sketch mode announces itself',
    (await pageA.textContent('[data-sketch-title]')).includes('SKETCH'),
  );

  // Draw one stroke with absolute pointer input (unlocked-desktop path).
  const vp = pageA.viewportSize();
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  await pageA.mouse.move(cx - 160, cy);
  await pageA.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await pageA.mouse.move(cx - 160 + i * 40, cy + Math.sin(i * 0.9) * 30);
    await sleep(30);
  }
  await pageA.mouse.up();
  const costText = (await pageA.textContent('[data-sketch-cost]')).trim();
  assert('A: sketch cost preview shows a non-zero cost', /COST\s+[1-9]/.test(costText), costText);

  await pageA.evaluate(() => (window.__inkFrames.length = 0));
  await pageB.evaluate(() => (window.__inkFrames.length = 0));
  await pageA.click('[data-sketch-cast]');
  const inkOnA = await eventually(pageA, () => window.__inkFrames.length > 0, 3000);
  const inkOnB = await eventually(pageB, () => window.__inkFrames.length > 0, 3000);
  assert('A: cast drawing comes back as ink:object', inkOnA);
  assert('B: other player receives the same ink:object', inkOnB);
  const sketchClosed = await eventually(pageA, () => document.querySelector('[data-sketch]')?.hidden === true, 2000);
  assert('A: sketch closes after casting', sketchClosed);
  const inkAfter = await eventually(
    pageA,
    () => {
      const v = parseFloat(document.querySelector('[data-ink-value]')?.textContent ?? '12');
      return v < 11.8; // cost deducted (regen may claw a little back)
    },
    2500,
  );
  assert('A: ink meter dropped after casting', inkAfter, (await pageA.textContent('[data-ink-value]')).trim());

  // --------------------------------------------------------------- screenshot
  await sleep(400); // let the materialize glow settle into view
  await pageB.screenshot({ path: SCREENSHOT });
  record(`in-game screenshot saved to ${SCREENSHOT}`, true);

  // ------------------------------------------------- leave -> landing -> re-create
  await pageA.click('.hud-leave');
  await pageA.waitForSelector('.screen-landing');
  assert('A: leave returns to landing', !(await pageA.evaluate(() => document.body.classList.contains('in-game'))));

  await pageB.waitForFunction(() => document.querySelector('.hud-count')?.textContent?.includes('1P'));
  assert('B: HUD count drops to 1 player after A leaves', true);

  assert('A: name persisted on landing', (await pageA.inputValue('#landing-name')) === 'Anna');
  await pageA.click('[data-action="create"]');
  await pageA.waitForSelector('.room-code');
  await pageA.waitForFunction(() => (document.querySelector('.room-code')?.textContent ?? '').trim().length === 4);
  const code2 = (await pageA.textContent('.room-code')).trim();
  assert('A: re-create after leave gets a fresh room', /^[A-Z2-9]{4}$/.test(code2) && code2 !== code, `${code} -> ${code2}`);

  // Full re-entry: start a solo TIMED game on the new room (dispose/recreate
  // renderer path + mode travels with room:start end to end).
  await pageA.click('[data-mode="timed"]');
  assert(
    'A: timed mode selectable',
    await pageA.$eval('[data-mode="timed"]', (b) => b.classList.contains('mode-active') && b.getAttribute('aria-pressed') === 'true'),
  );
  await pageA.click('.lobby-actions .btn-primary');
  await pageA.waitForSelector('.screen-hud');
  await sleep(1000);
  assert('A: re-entered game after dispose (renderer recreated)', await pageA.evaluate(() => document.body.classList.contains('in-game')));
  const timer = await pageA.$eval('[data-timer]', (el) => ({ hidden: el.hidden, text: (el.textContent ?? '').trim() }));
  assert('A: timed mode shows the countdown chip (M:SS)', !timer.hidden && /^\d:[0-5]\d$/.test(timer.text), JSON.stringify(timer));

  // ------------------------------------------------- escape mode: the dungeon
  await pageA.click('.hud-leave');
  await pageA.waitForSelector('.screen-landing');
  await pageA.click('[data-action="create"]');
  await pageA.waitForSelector('.room-code');
  await pageA.click('[data-mode="escape"]');
  assert(
    'A: escape mode selectable',
    await pageA.$eval('[data-mode="escape"]', (b) => b.classList.contains('mode-active')),
  );
  await pageA.click('.lobby-actions .btn-primary');
  await pageA.waitForSelector('.screen-hud.hud-escape');
  assert('A: escape HUD engaged', true);

  const objective = await pageA.$eval('[data-objective]', (el) => ({
    hidden: el.hidden,
    text: (el.textContent ?? '').trim(),
  }));
  assert('A: escape objective shows the chasm goal', !objective.hidden && /CHASM/.test(objective.text), JSON.stringify(objective));
  const escTimer = await pageA.$eval('[data-timer]', (el) => ({ hidden: el.hidden, text: (el.textContent ?? '').trim() }));
  assert('A: escape timer counts up (M:SS)', !escTimer.hidden && /^\d:[0-5]\d$/.test(escTimer.text), JSON.stringify(escTimer));
  assert(
    'A: ammo hidden in escape mode',
    await pageA.$eval('[data-ammo]', (el) => getComputedStyle(el).display === 'none'),
  );
  assert(
    'A: K/D chip hidden in escape mode',
    await pageA.$eval('[data-kd]', (el) => getComputedStyle(el).display === 'none'),
  );
  await sleep(900); // a few rendered frames of the dungeon
  await pageA.screenshot({ path: ESCAPE_SCREENSHOT });
  record(`escape dungeon screenshot saved to ${ESCAPE_SCREENSHOT}`, true);

  // ---------------------------------------------- party mode: DOODLE ROYALE
  if (!PARTY_READY) {
    record('party: SKIP — boot the server and this test with the BOOM_PARTY_* knobs (see header)', true);
  } else {
    // Fresh lobby: A leaves the dungeon, B leaves the original endless match.
    await pageA.click('.hud-leave');
    await pageA.waitForSelector('.screen-landing');
    await pageB.click('.hud-leave');
    await pageB.waitForSelector('.screen-landing');

    await pageA.click('[data-action="create"]');
    await pageA.waitForSelector('.room-code');
    await pageA.waitForFunction(() => (document.querySelector('.room-code')?.textContent ?? '').trim().length === 4);
    const partyCode = (await pageA.textContent('.room-code')).trim();
    await pageB.fill('.code-input', partyCode);
    await pageB.click('[data-action="join"]');
    await pageB.waitForSelector('.screen-lobby');

    // Survivor bot: a third, headless-socket player that reports a safe height
    // all match. Rounds then run their full length while both idle pages get
    // flooded — which makes the ELIMINATED spectator path deterministic.
    const cass = ioSocket(APP_URL, { transports: ['websocket'], forceNew: true, reconnection: false });
    const cassOnce = (event) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`cass: timeout waiting for ${event}`)), 5000);
        cass.once(event, (payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });
    await cassOnce('connect');
    cass.emit('room:join', { code: partyCode, name: 'Cass' });
    await cassOnce('room:joined');
    const cassLoop = setInterval(
      () => cass.emit('player:state', { pos: { x: 6, y: 6, z: 6 }, yaw: 0 }),
      250,
    );

    await pageA.waitForFunction(() => document.querySelectorAll('.player-list li').length === 3);
    assert('party: lobby lists all 3 artists', true);

    const partyLabel = (await pageA.textContent('[data-mode="party"]')).trim();
    assert('party: mode button is labelled DOODLE ROYALE', partyLabel.startsWith('DOODLE ROYALE'), partyLabel);
    await pageA.click('[data-mode="party"]');
    assert(
      'party: mode selectable',
      await pageA.$eval('[data-mode="party"]', (b) => b.classList.contains('mode-active') && b.getAttribute('aria-pressed') === 'true'),
    );
    await pageA.screenshot({ path: PARTY_LOBBY_SHOT });
    record(`party lobby screenshot saved to ${PARTY_LOBBY_SHOT}`, true);

    // Start: both pages enter the party HUD.
    await pageA.click('.lobby-actions .btn-primary');
    for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
      await page.waitForSelector('.screen-hud.hud-party');
      assert(`${label}: party HUD engaged (hud-party)`, true);
    }

    // Round 1 intermission: pinned card + announcer + PTS relabel + a quip.
    const card1 = await eventually(
      pageA,
      () => {
        const t = document.querySelector('[data-sb-title]')?.textContent ?? '';
        return t.startsWith('ROUND 1/2') && t.includes('RISING INK');
      },
      5000,
    );
    assert('A: round card reads ROUND 1/2 — RISING INK', card1, (await pageA.textContent('[data-sb-title]')).trim());
    const announcer = await pageA.$eval('[data-sb-announcer]', (el) => ({ hidden: el.hidden, text: (el.textContent ?? '').trim() }));
    assert('A: announcer line on the round card', !announcer.hidden && announcer.text.length > 2, JSON.stringify(announcer));
    // Shoot the card right away — the intermission is only a few seconds long.
    await pageA.screenshot({ path: PARTY_CARD_SHOT });
    record(`party round-card screenshot saved to ${PARTY_CARD_SHOT}`, true);
    const cols = [
      await pageA.textContent('[data-sb-col-k]'),
      await pageA.textContent('[data-sb-col-d]'),
    ];
    assert('A: scoreboard columns relabelled PTS/OUT', cols.join(',') === 'PTS,OUT', cols.join(','));
    const quipSeen = await eventually(pageA, () => document.querySelector('.quip-entry') !== null, 3000);
    assert('A: The Critic quips into the feed', quipSeen);

    // Round 1 playing: countdown chip + objective, then the tide takes both
    // idle pages (feet at y=0) once the grace runs out.
    const graceMs = Math.round(PARTY_ROUND_MS * 0.15);
    const playing1 = await eventually(pageA, () => document.querySelector('[data-timer]')?.hidden === false, PARTY_INTERMISSION_MS + 5000);
    const timerText = (await pageA.textContent('[data-timer]')).trim();
    assert('A: round countdown ticking in the timer chip', playing1 && /^\d:[0-5]\d$/.test(timerText), timerText);
    const objective1 = (await pageA.textContent('[data-objective]')).trim();
    assert('A: objective mentions the ink', objective1.includes('INK'), objective1);

    for (const [page, label] of [[pageB, 'B'], [pageA, 'A']]) {
      const eliminated = await eventually(
        page,
        () =>
          document.querySelector('[data-death]')?.hidden === false &&
          (document.querySelector('.death-killer')?.textContent ?? '') === 'ELIMINATED',
        graceMs + 8000,
      );
      assert(`${label}: idle player eliminated by the tide (ELIMINATED overlay)`, eliminated);
    }
    assert(
      'A: environmental deaths kept out of the kill feed',
      (await pageA.$$eval('.kill-entry:not(.quip-entry)', (els) => els.length)) === 0,
    );

    // Round 2 intermission: spectators revived, fresh card; draw a beam so the
    // finale flood has some art to swallow.
    const card2 = await eventually(
      pageA,
      () => (document.querySelector('[data-sb-title]')?.textContent ?? '').startsWith('ROUND 2/2'),
      PARTY_ROUND_MS + 6000,
    );
    assert('A: round 2 card shows up', card2, (await pageA.textContent('[data-sb-title]')).trim());
    assert('A: ELIMINATED overlay cleared by the round card', await pageA.$eval('[data-death]', (el) => el.hidden));

    await pageA.keyboard.press('KeyQ');
    const sketchOpen2 = await eventually(pageA, () => document.querySelector('[data-sketch]')?.hidden === false, 2500);
    assert('A: sketch opens during the intermission', sketchOpen2);
    // CDP input roundtrips run ~250ms each on SwiftShader pages, so keep the
    // stroke to a few points and cast with Enter (no actionability checks) —
    // the whole draw has to beat the next round's tide.
    await pageA.evaluate(() => (window.__inkFrames.length = 0));
    const vp2 = pageA.viewportSize();
    const px = vp2.width / 2;
    const py = vp2.height / 2;
    await pageA.mouse.move(px - 140, py + 20);
    await pageA.mouse.down();
    await pageA.mouse.move(px - 40, py - 20);
    await pageA.mouse.move(px + 60, py + 10);
    await pageA.mouse.move(px + 150, py - 30);
    await pageA.mouse.up();
    await pageA.keyboard.press('Enter');
    const inkCast2 = await eventually(pageA, () => window.__inkFrames.length > 0, 4000);
    assert('A: intermission drawing materializes for the finale', inkCast2);

    // Round 2 playing: let the finale tide come up over the drawing.
    await eventually(pageA, () => document.querySelector('[data-timer]')?.hidden === false, PARTY_INTERMISSION_MS + 5000);
    await sleep(Math.min(PARTY_ROUND_MS - 1500, graceMs + 3500));
    await pageA.screenshot({ path: PARTY_FLOOD_SHOT });
    record(`party flood screenshot saved to ${PARTY_FLOOD_SHOT}`, true);

    // Podium: champion title + SAVE THE ART, cinematic chrome hidden.
    const podium = await eventually(
      pageA,
      () => (document.querySelector('[data-sb-title]')?.textContent ?? '').startsWith('CHAMPION:'),
      PARTY_ROUND_MS + 8000,
    );
    const podiumTitle = (await pageA.textContent('[data-sb-title]')).trim();
    assert('A: podium crowns a champion', podium, podiumTitle);
    assert('A: the survivor bot takes the title', podiumTitle === 'CHAMPION: Cass', podiumTitle);
    assert('A: hud-podium cinematic engaged', await pageA.$eval('.screen-hud', (el) => el.classList.contains('hud-podium')));
    const saveArtVisible = await pageA.$eval('[data-save-art]', (el) => !el.hidden);
    assert('A: SAVE THE ART button on the podium', saveArtVisible);
    if (saveArtVisible) {
      await pageA.click('[data-save-art]', { timeout: 5000 });
      record('A: SAVE THE ART click handled (download smoke)', true);
    }
    assert(
      'B: podium visible for the flooded artist too',
      await eventually(pageB, () => (document.querySelector('[data-sb-title]')?.textContent ?? '').startsWith('CHAMPION:'), 5000),
    );
    await pageA.screenshot({ path: PARTY_PODIUM_SHOT });
    record(`party podium screenshot saved to ${PARTY_PODIUM_SHOT}`, true);

    // The podium delay doubles as the party reset delay — back to the lobby.
    for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
      await page.waitForSelector('.screen-lobby', { timeout: PARTY_PODIUM_MS + 8000 });
      assert(`${label}: room resets to the lobby after the podium`, true);
    }

    clearInterval(cassLoop);
    cass.disconnect();
  }

  // -------------------------------------------------------------- error audit
  await sleep(500);
  assert('zero console/page errors across both pages', errors.length === 0, `\n${errors.join('\n')}`);

  await browser.close();
  console.log(`\n${results.length} checks, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
