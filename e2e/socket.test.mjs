/**
 * Socket-level e2e test for the BoomBoom server (no browser involved).
 *
 * Prerequisite: the game server must be listening on :3001
 * (`npm run dev` or `npm start`), or point SERVER_URL elsewhere.
 *
 * Run: npm run e2e:socket
 * Exits 0 when all assertions pass, 1 otherwise.
 *
 * The combat sections run fastest when the server AND this test share
 * shortened match timers (see the BOOM_* knobs below), e.g.:
 *   BOOM_MATCH_TIME_MS=2000 BOOM_RESET_DELAY_MS=600 npm start -w server
 *   BOOM_MATCH_TIME_MS=2000 BOOM_RESET_DELAY_MS=600 npm run e2e:socket
 *
 * The Doodle Royale (party mode) section additionally needs these knobs on
 * BOTH the server and this test, otherwise it prints SKIP:
 *   BOOM_PARTY_ROUNDS=2 BOOM_PARTY_INTERMISSION_MS=1500 BOOM_PARTY_ROUND_MS=6000 \
 *   BOOM_PARTY_PODIUM_MS=2000 BOOM_PARTY_FORCE_KIND=rising-ink,draw-duel
 * Knobs: BOOM_PARTY_ROUNDS (total rounds), BOOM_PARTY_INTERMISSION_MS,
 * BOOM_PARTY_ROUND_MS (overrides EVERY round duration; the lava grace becomes
 * 15% of it and pulse/sudden-death/gun-unlock offsets scale proportionally),
 * BOOM_PARTY_PODIUM_MS (podium length == party reset delay), and
 * BOOM_PARTY_FORCE_KIND — a comma list of round kinds
 * ('rising-ink'|'draw-duel'|'floor-check'); round i uses entry min(i, len)-1
 * (the last entry repeats), replacing the random schedule for determinism.
 */
import { io } from 'socket.io-client';

const URL = process.env.SERVER_URL ?? 'http://localhost:3001';
const results = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(name, cond, detail = '') {
  record(name, !!cond, cond ? '' : detail);
}

function connect() {
  return io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
}

function waitFor(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for '${event}'`)),
      timeoutMs,
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Resolves true if the event fires within windowMs, false otherwise. */
function firesWithin(socket, event, windowMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve(false);
    }, windowMs);
    function onEvent() {
      clearTimeout(timer);
      resolve(true);
    }
    socket.once(event, onEvent);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Combat-suite knobs: mirror the server's env overrides so timing assertions
// line up. Boot the server AND this test with the same values, e.g.
//   BOOM_MATCH_TIME_MS=2000 BOOM_RESET_DELAY_MS=600
// The timed-mode section is skipped unless BOOM_MATCH_TIME_MS <= 15000.
const MATCH_TIME_MS = Number(process.env.BOOM_MATCH_TIME_MS ?? 300000);
const RESET_DELAY_MS = Number(process.env.BOOM_RESET_DELAY_MS ?? 7000);
// Comfortably above the server's effective cooldown, FIRE_COOLDOWN_MS(250) - slack(50).
const SHOT_GAP_MS = 260;

// Party-mode knobs (mirror the server's, see header). The party section only
// runs with the exact deterministic config below.
const PARTY_ROUNDS = Number(process.env.BOOM_PARTY_ROUNDS ?? 5);
const PARTY_INTERMISSION_MS = Number(process.env.BOOM_PARTY_INTERMISSION_MS ?? 8000);
const PARTY_ROUND_MS = Number(process.env.BOOM_PARTY_ROUND_MS ?? 0);
const PARTY_PODIUM_MS = Number(process.env.BOOM_PARTY_PODIUM_MS ?? 14000);
const PARTY_KINDS = (process.env.BOOM_PARTY_FORCE_KIND ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PARTY_READY =
  PARTY_ROUNDS === 2 &&
  PARTY_KINDS.join(',') === 'rising-ink,draw-duel' &&
  PARTY_ROUND_MS > 0 &&
  PARTY_ROUND_MS <= 8000 &&
  PARTY_INTERMISSION_MS <= 2500 &&
  PARTY_PODIUM_MS <= 5000;

async function main() {
  // ---------------------------------------------------------------- setup
  const A = connect();
  const B = connect();
  const C = connect();
  await Promise.all([waitFor(A, 'connect'), waitFor(B, 'connect'), waitFor(C, 'connect')]);

  // ------------------------------------------------------------ 1. create
  A.emit('room:create', { name: 'Alice' });
  const created = await waitFor(A, 'room:created');
  const code = created.room.code;
  assert('create: 4-char code from safe alphabet', /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code), `code=${code}`);
  assert('create: selfId matches socket id', created.selfId === A.id);
  assert('create: creator is host', created.room.hostId === A.id);
  assert('create: roster is just the creator', created.room.players.length === 1 && created.room.players[0].name === 'Alice');
  assert('create: room not started', created.room.started === false);

  // ----------------------------------------------------------- 2. join x2
  const aSeesB = waitFor(A, 'room:player-joined');
  B.emit('room:join', { code, name: 'Bob' });
  const joinedB = await waitFor(B, 'room:joined');
  const bAnnounce = await aSeesB;
  assert('join B: snapshot has 2 players', joinedB.room.players.length === 2);
  assert('join B: selfId matches', joinedB.selfId === B.id);
  assert('join B: A got player-joined for B', bAnnounce.player.id === B.id && bAnnounce.player.name === 'Bob');

  const aSeesC = waitFor(A, 'room:player-joined');
  const bSeesC = waitFor(B, 'room:player-joined');
  C.emit('room:join', { code, name: 'Cara' });
  const joinedC = await waitFor(C, 'room:joined');
  await Promise.all([aSeesC, bSeesC]);
  assert('join C: snapshot has 3 players', joinedC.room.players.length === 3);
  assert('join C: hostId still A', joinedC.room.hostId === A.id);

  const colors = joinedC.room.players.map((p) => p.color);
  assert('colors: 3 distinct palette colors', new Set(colors).size === 3, colors.join(','));
  const names = joinedC.room.players.map((p) => p.name).sort();
  assert('names: server-sanitized names preserved', names.join(',') === 'Alice,Bob,Cara', names.join(','));

  // -------------------------------------- 3. duplicate join is idempotent
  const cSeesDup = firesWithin(C, 'room:player-joined', 400);
  B.emit('room:join', { code, name: 'BobRenamed' });
  const rejoin = await waitFor(B, 'room:joined');
  assert('dup join: snapshot re-sent, still 3 players', rejoin.room.players.length === 3);
  assert('dup join: original name kept', rejoin.room.players.find((p) => p.id === B.id)?.name === 'Bob');
  assert('dup join: no announcement to others', (await cSeesDup) === false);

  // ------------------------------------------- 4. non-host start rejected
  const startLeak = Promise.all([
    firesWithin(A, 'room:started', 400),
    firesWithin(C, 'room:started', 400),
  ]);
  B.emit('room:start');
  const startErr = await waitFor(B, 'room:error');
  assert('non-host start: error mentions host', /host/i.test(startErr.message), startErr.message);
  const [leakA, leakC] = await startLeak;
  assert('non-host start: nobody got room:started', !leakA && !leakC);

  // --------------------------------------------------- 5. host starts game
  const gotStarted = [waitFor(A, 'room:started'), waitFor(B, 'room:started'), waitFor(C, 'room:started')];
  A.emit('room:start');
  await Promise.all(gotStarted);
  record('host start: all 3 received room:started', true);

  // --------------------------- 6. player:state exchange, ~15Hz both ways
  // Deterministic trajectories: player k sends pos(x=100k+n, y=k, z=-n) tick n.
  const senders = [A, B, C];
  const lastSent = new Map(); // socket.id -> last sent state
  const ticks = new Map(senders.map((s) => [s.id, 0]));
  const sendTimers = senders.map((s, k) =>
    setInterval(() => {
      const n = ticks.get(s.id) + 1;
      ticks.set(s.id, n);
      const state = { pos: { x: 100 * k + n, y: k, z: -n }, yaw: (k + n * 0.01) % Math.PI };
      lastSent.set(s.id, state);
      s.emit('player:state', state);
    }, 1000 / 15),
  );

  const bBroadcasts = [];
  const onState = (payload) => bBroadcasts.push({ t: Date.now(), states: payload.states });
  B.on('players:state', onState);

  await sleep(3000);
  sendTimers.forEach(clearInterval);
  await sleep(300); // let the last states flush through a few more broadcast ticks
  B.off('players:state', onState);

  assert('state relay: broadcasts received', bBroadcasts.length > 0, `${bBroadcasts.length}`);
  if (bBroadcasts.length > 1) {
    const windowSec = (bBroadcasts[bBroadcasts.length - 1].t - bBroadcasts[0].t) / 1000;
    const hz = (bBroadcasts.length - 1) / windowSec;
    assert('state relay: ~15Hz broadcast rate (12-18)', hz >= 12 && hz <= 18, `${hz.toFixed(1)}Hz over ${windowSec.toFixed(1)}s`);
  }
  const knownIds = new Set(senders.map((s) => s.id));
  assert(
    'state relay: every broadcast id belongs to the room',
    bBroadcasts.every((b) => b.states.every((st) => knownIds.has(st.id))),
  );
  assert(
    "state relay: B's broadcasts include B's own id",
    bBroadcasts.some((b) => b.states.some((st) => st.id === B.id)),
  );
  const final = bBroadcasts[bBroadcasts.length - 1];
  assert('state relay: final broadcast carries all 3 players', final && final.states.length === 3, `${final?.states.length}`);
  for (const s of senders) {
    const sent = lastSent.get(s.id);
    const got = final?.states.find((st) => st.id === s.id);
    const match =
      got && got.pos.x === sent.pos.x && got.pos.y === sent.pos.y && got.pos.z === sent.pos.z && got.yaw === sent.yaw;
    assert(`state relay: verbatim final pos/yaw for ${s.id.slice(0, 5)}…`, match, JSON.stringify({ sent, got }));
  }

  // --------------------------- 7. host disconnects mid-game -> migration
  const bLeft = waitFor(B, 'room:player-left');
  const cLeft = waitFor(C, 'room:player-left');
  const aId = A.id;
  A.disconnect();
  const [bl, cl] = await Promise.all([bLeft, cLeft]);
  assert('migration: playerId is the leaver', bl.playerId === aId && cl.playerId === aId);
  assert('migration: new host is earliest joiner (B)', bl.newHostId === B.id && cl.newHostId === B.id, `got ${bl.newHostId}`);

  // ------------------------------------------------------- 8. late join
  const D = connect();
  await waitFor(D, 'connect');
  const bSeesD = waitFor(B, 'room:player-joined');
  D.emit('room:join', { code, name: '  Dave-With-A-Very-Long-Name  ' });
  const joinedD = await waitFor(D, 'room:joined');
  await bSeesD;
  assert('late join: snapshot says started', joinedD.room.started === true);
  assert('late join: roster is B,C,D', joinedD.room.players.length === 3 && joinedD.room.players.some((p) => p.id === D.id));
  assert('late join: hostId is B after migration', joinedD.room.hostId === B.id);
  const dName = joinedD.room.players.find((p) => p.id === D.id)?.name;
  assert('late join: long name trimmed+capped to 16', dName === 'Dave-With-A-Very', JSON.stringify(dName));

  // ------------------------------------------- 9. lobby host-leave (UI seam)
  {
    const H = connect();
    const G = connect();
    await Promise.all([waitFor(H, 'connect'), waitFor(G, 'connect')]);
    H.emit('room:create', { name: 'Host2' });
    const r2 = await waitFor(H, 'room:created');
    G.emit('room:join', { code: r2.room.code, name: 'Guest2' });
    await waitFor(G, 'room:joined');
    const gLeft = waitFor(G, 'room:player-left');
    H.emit('room:leave');
    const gl = await gLeft;
    assert('lobby migration: room:leave promotes remaining player', gl.newHostId === G.id);
    // Promoted player can now start.
    const gStarted = waitFor(G, 'room:started');
    G.emit('room:start');
    await gStarted;
    record('lobby migration: promoted player can start', true);
    G.disconnect();
    H.disconnect();
  }

  // ------------------------------------------------- 10. fill to 8, 9th out
  // Room currently holds B, C, D (3). Add 5 -> 8 (cap).
  const extras = [];
  for (let i = 0; i < 5; i++) {
    const S = connect();
    extras.push(S);
    await waitFor(S, 'connect');
    S.emit('room:join', { code, name: `Extra${i + 1}` });
    const j = await waitFor(S, 'room:joined');
    if (i === 4) assert('capacity: 8th player joins fine', j.room.players.length === 8, `${j.room.players.length}`);
  }
  const ninth = connect();
  await waitFor(ninth, 'connect');
  const ninthJoined = firesWithin(ninth, 'room:joined', 400);
  ninth.emit('room:join', { code, name: 'Ninth' });
  const fullErr = await waitFor(ninth, 'room:error');
  assert('capacity: 9th rejected with "full" error', /full/i.test(fullErr.message), fullErr.message);
  assert('capacity: 9th never got room:joined', (await ninthJoined) === false);

  // ----------------------------------------------------- 11. bad-code joins
  const stray = connect();
  await waitFor(stray, 'connect');
  const wrongCode = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
  stray.emit('room:join', { code: wrongCode, name: 'Lost' });
  const nf = await waitFor(stray, 'room:error');
  assert('bad code: not-found error names the code', nf.message.includes(wrongCode) && /not found/i.test(nf.message), nf.message);

  stray.emit('room:join', { code: '', name: 'Lost' });
  const nf2 = await waitFor(stray, 'room:error');
  assert('bad code: empty code errors gracefully', /not found/i.test(nf2.message), nf2.message);

  stray.emit('room:join', { code: 12345, name: 'Lost' });
  const nf3 = await waitFor(stray, 'room:error');
  assert('bad code: non-string code errors gracefully', /not found/i.test(nf3.message), nf3.message);

  // ------------------------------------- teardown (lobby/movement suite)
  for (const s of [B, C, D, ninth, stray, ...extras]) s.disconnect();

  // ======================================================================
  // Combat suite (Pencil Shooter update)
  // ======================================================================

  // ---------------------------------------------------- 12. net:ping echo
  {
    const P = connect();
    await waitFor(P, 'connect');
    P.emit('net:ping', 1234.5678);
    const pong1 = await waitFor(P, 'net:pong');
    assert('ping: pong echoes the exact number, no room needed', pong1 === 1234.5678, `got ${pong1}`);
    P.emit('net:ping', 0);
    const pong2 = await waitFor(P, 'net:pong');
    assert('ping: zero echoes fine', pong2 === 0, `got ${pong2}`);
    const junkPong = firesWithin(P, 'net:pong', 300);
    P.emit('net:ping', 'not-a-number');
    assert('ping: non-number ping ignored', (await junkPong) === false);
    P.disconnect();
  }

  // ------------------------------------------------ 13. match mode starts
  {
    const H = connect();
    await waitFor(H, 'connect');

    // Payload-less start (pre-update client behavior) -> endless defaults.
    H.emit('room:create', { name: 'ModeHost' });
    const c1 = await waitFor(H, 'room:created');
    assert(
      'modes: lobby snapshot has null mode/endsAt/targetKills',
      c1.room.mode === null && c1.room.endsAt === null && c1.room.targetKills === null,
    );
    const firstScore = waitFor(H, 'match:score');
    H.emit('room:start'); // deliberately no payload
    const s1 = await waitFor(H, 'room:started');
    assert("modes: payload-less start defaults to 'endless'", s1.mode === 'endless', JSON.stringify(s1));
    assert('modes: endless start has null endsAt+targetKills', s1.endsAt === null && s1.targetKills === null);
    const sc1 = await firstScore;
    assert(
      'modes: start emits an initial zeroed match:score',
      sc1.scores.length === 1 && sc1.scores[0].id === H.id && sc1.scores[0].kills === 0 && sc1.scores[0].deaths === 0,
      JSON.stringify(sc1.scores),
    );
    const dupStart = firesWithin(H, 'room:started', 400);
    H.emit('room:start', { mode: 'kills' });
    assert('modes: starting an already-started room is ignored', (await dupStart) === false);
    H.emit('room:leave');

    H.emit('room:create', { name: 'ModeHost' });
    await waitFor(H, 'room:created');
    H.emit('room:start', { mode: 'kills' });
    const s2 = await waitFor(H, 'room:started');
    assert("modes: 'kills' start carries targetKills=10", s2.mode === 'kills' && s2.targetKills === 10, JSON.stringify(s2));
    assert("modes: 'kills' start has null endsAt", s2.endsAt === null);
    H.emit('room:leave');

    H.emit('room:create', { name: 'ModeHost' });
    await waitFor(H, 'room:created');
    const modeT0 = Date.now();
    H.emit('room:start', { mode: 'timed' });
    const s3 = await waitFor(H, 'room:started');
    assert("modes: 'timed' start has null targetKills", s3.mode === 'timed' && s3.targetKills === null, JSON.stringify(s3));
    const untilEnd = s3.endsAt - modeT0;
    assert(
      "modes: 'timed' endsAt ~ now + match time",
      untilEnd > MATCH_TIME_MS - 1500 && untilEnd < MATCH_TIME_MS + 1500,
      `endsAt-now=${untilEnd}, expected ~${MATCH_TIME_MS}`,
    );
    // Leaving empties the room; the server must cancel its match-end timer.
    H.emit('room:leave');
    H.disconnect();
  }

  // ----------------------------------- 14. combat in an endless-mode room
  {
    const K = connect();
    const V1 = connect();
    const V2 = connect();
    await Promise.all([waitFor(K, 'connect'), waitFor(V1, 'connect'), waitFor(V2, 'connect')]);
    K.emit('room:create', { name: 'Kay' });
    const combatRoom = await waitFor(K, 'room:created');
    const combatCode = combatRoom.room.code;
    V1.emit('room:join', { code: combatCode, name: 'VicOne' });
    await waitFor(V1, 'room:joined');
    V2.emit('room:join', { code: combatCode, name: 'VicTwo' });
    await waitFor(V2, 'room:joined');

    const combatStarted = [waitFor(K, 'room:started'), waitFor(V1, 'room:started'), waitFor(V2, 'room:started')];
    K.emit('room:start');
    await Promise.all(combatStarted);

    // Positions the server will validate hit claims against.
    const V1_POS = { x: 5, y: 1, z: 0 };
    K.emit('player:state', { pos: { x: 0, y: 1, z: 0 }, yaw: 0 });
    V1.emit('player:state', { pos: V1_POS, yaw: 0 });
    V2.emit('player:state', { pos: { x: 0, y: 1, z: 5 }, yaw: 0 });
    await sleep(250); // let states land server-side

    const UNIT_X = { x: 1, y: 0, z: 0 };
    const hitV1 = () => ({
      origin: { x: 0, y: 1.6, z: 0 },
      dir: UNIT_X,
      hitId: V1.id,
      hitPoint: { x: 5, y: 1.2, z: 0 },
    });

    // -- single valid shot: tracer to others, damage to everyone
    const v2Shot = waitFor(V2, 'player:shot');
    const v1Shot = waitFor(V1, 'player:shot');
    const shooterShot = firesWithin(K, 'player:shot', 500);
    const v1Damaged = waitFor(V1, 'player:damaged');
    const kDamaged = waitFor(K, 'player:damaged');
    K.emit('player:shoot', hitV1());
    const tracer = await v2Shot;
    assert(
      'shoot: player:shot relays shooter/origin/dir/hitPoint',
      tracer.shooterId === K.id && tracer.origin.y === 1.6 && tracer.dir.x === 1 && tracer.hitPoint?.x === 5,
      JSON.stringify(tracer),
    );
    await v1Shot;
    record('shoot: the target also receives the tracer', true);
    const dmg = await v1Damaged;
    assert(
      'shoot: player:damaged 100->80 credited to shooter',
      dmg.targetId === V1.id && dmg.health === 80 && dmg.shooterId === K.id,
      JSON.stringify(dmg),
    );
    assert('shoot: shooter also gets player:damaged (hitmarker)', (await kDamaged).health === 80);
    assert('shoot: shooter is excluded from player:shot', (await shooterShot) === false);

    // -- cooldown: a double-tap lands exactly one shot
    await sleep(300);
    const rapidShots = [];
    const rapidDamage = [];
    const onRapidShot = (p) => rapidShots.push(p);
    const onRapidDamage = (p) => rapidDamage.push(p);
    V2.on('player:shot', onRapidShot);
    V2.on('player:damaged', onRapidDamage);
    K.emit('player:shoot', hitV1());
    K.emit('player:shoot', hitV1()); // immediate second shot violates the cooldown
    await sleep(600);
    V2.off('player:shot', onRapidShot);
    V2.off('player:damaged', onRapidDamage);
    assert('cooldown: only one tracer relayed for a double-tap', rapidShots.length === 1, `${rapidShots.length}`);
    assert(
      'cooldown: only one damage applied (80->60)',
      rapidDamage.length === 1 && rapidDamage[0].health === 60,
      JSON.stringify(rapidDamage),
    );

    // -- far-off hit claim: tracer passes, damage rejected
    const farTracer = waitFor(V2, 'player:shot');
    const farDamage = firesWithin(V2, 'player:damaged', 500);
    K.emit('player:shoot', { origin: { x: 0, y: 1.6, z: 0 }, dir: UNIT_X, hitId: V1.id, hitPoint: { x: 55, y: 1, z: 0 } });
    await farTracer;
    record('anticheat: far-off hit claim still relays the tracer', true);
    assert('anticheat: far-off hit claim deals no damage', (await farDamage) === false);

    // -- malformed direction: rejected outright (no tracer)
    await sleep(300);
    const badDirTracer = firesWithin(V2, 'player:shot', 400);
    K.emit('player:shoot', { origin: { x: 0, y: 1.6, z: 0 }, dir: { x: 5, y: 0, z: 0 }, hitId: null, hitPoint: null });
    assert('anticheat: non-unit direction rejected entirely', (await badDirTracer) === false);

    // -- 3 more hits (60->40->20->0): death, score, respawn
    const diedP = waitFor(V2, 'player:died', 3000);
    const scoreP = waitFor(V2, 'match:score', 3000);
    for (let i = 0; i < 3; i++) {
      await sleep(SHOT_GAP_MS);
      K.emit('player:shoot', hitV1());
    }
    const died = await diedP;
    const killTime = Date.now();
    assert('kill: player:died after the 5th hit', died.targetId === V1.id && died.killerId === K.id, JSON.stringify(died));
    assert(
      'kill: respawnAt ~3s in the future',
      died.respawnAt - killTime > 2000 && died.respawnAt - killTime < 4000,
      `${died.respawnAt - killTime}ms`,
    );
    const killScore = await scoreP;
    const rows = new Map(killScore.scores.map((s) => [s.id, s]));
    assert(
      'kill: match:score K=1/0 V1=0/1 V2=0/0',
      rows.get(K.id)?.kills === 1 &&
        rows.get(K.id)?.deaths === 0 &&
        rows.get(V1.id)?.kills === 0 &&
        rows.get(V1.id)?.deaths === 1 &&
        rows.get(V2.id)?.kills === 0 &&
        rows.get(V2.id)?.deaths === 0,
      JSON.stringify(killScore.scores),
    );

    // -- while dead: excluded from broadcasts, cannot shoot
    V1.emit('player:state', { pos: V1_POS, yaw: 1 }); // dead player still reporting state
    const deadShot = firesWithin(V2, 'player:shot', 700);
    V1.emit('player:shoot', {
      origin: { x: 5, y: 1.6, z: 0 },
      dir: { x: -1, y: 0, z: 0 },
      hitId: K.id,
      hitPoint: { x: 0, y: 1, z: 0 },
    });
    const deadCasts = [];
    const onDeadCast = (p) => deadCasts.push(p.states);
    V2.on('players:state', onDeadCast);
    await sleep(700);
    V2.off('players:state', onDeadCast);
    assert('dead: shooting while dead is rejected', (await deadShot) === false);
    assert('dead: broadcasts keep flowing', deadCasts.length > 3, `${deadCasts.length}`);
    assert('dead: dead player excluded from players:state', deadCasts.every((sts) => !sts.some((st) => st.id === V1.id)));
    assert('dead: living players still included', deadCasts.some((sts) => sts.some((st) => st.id === K.id)));

    // -- respawn after ~3s, back in broadcasts
    const resp = await waitFor(V2, 'player:respawned', 4500);
    const respawnElapsed = Date.now() - killTime;
    assert('respawn: player:respawned for the dead player', resp.id === V1.id);
    assert('respawn: ~3s after death', respawnElapsed > 2400 && respawnElapsed < 4600, `${respawnElapsed}ms`);
    const aliveCasts = [];
    const onAliveCast = (p) => aliveCasts.push(p.states);
    V2.on('players:state', onAliveCast);
    await sleep(400);
    V2.off('players:state', onAliveCast);
    assert('respawn: player reappears in players:state', aliveCasts.some((sts) => sts.some((st) => st.id === V1.id)));

    // -- kill V1 again to open a death window for the late joiner
    const died2P = waitFor(V2, 'player:died', 8000);
    for (let i = 0; i < 5; i++) {
      await sleep(SHOT_GAP_MS);
      K.emit('player:shoot', hitV1());
    }
    const died2 = await died2P;
    assert('kill 2: second kill lands (fresh 100hp after respawn)', died2.targetId === V1.id);

    const L = connect();
    await waitFor(L, 'connect');
    const lJoined = waitFor(L, 'room:joined');
    const lScore = waitFor(L, 'match:score');
    const lDied = waitFor(L, 'player:died');
    L.emit('room:join', { code: combatCode, name: 'Late' });
    const lj = await lJoined;
    assert(
      'late join: snapshot carries started+mode/endsAt/targetKills',
      lj.room.started === true && lj.room.mode === 'endless' && lj.room.endsAt === null && lj.room.targetKills === null,
      JSON.stringify({ started: lj.room.started, mode: lj.room.mode }),
    );
    const ls = await lScore;
    const lRows = new Map(ls.scores.map((s) => [s.id, s]));
    assert(
      'late join: current scores delivered (K 2/0, V1 0/2, +L row)',
      ls.scores.length === 4 && lRows.get(K.id)?.kills === 2 && lRows.get(V1.id)?.deaths === 2 && lRows.get(L.id)?.kills === 0,
      JSON.stringify(ls.scores),
    );
    const ld = await lDied;
    assert(
      'late join: player:died replay for the currently-dead player',
      ld.targetId === V1.id && ld.killerId === K.id && typeof ld.respawnAt === 'number',
      JSON.stringify(ld),
    );

    // -- leaving mid-match drops the leaver from the scoreboard
    const scoreAfterLeave = waitFor(K, 'match:score', 2000);
    V2.emit('room:leave');
    const sal = await scoreAfterLeave;
    assert(
      'leave: mid-match leave re-broadcasts scores without the leaver',
      sal.scores.length === 3 && !sal.scores.some((s) => s.id === V2.id),
      JSON.stringify(sal.scores),
    );

    for (const s of [K, V1, V2, L]) s.disconnect();
  }

  // ------------------------------------ 15. kills mode: full match to 10
  {
    const K2 = connect();
    const W1 = connect();
    const W2 = connect();
    const W3 = connect();
    await Promise.all([K2, W1, W2, W3].map((s) => waitFor(s, 'connect')));
    K2.emit('room:create', { name: 'Reaper' });
    const killsRoom = await waitFor(K2, 'room:created');
    const killsCode = killsRoom.room.code;
    for (const [s, n] of [
      [W1, 'WickOne'],
      [W2, 'WickTwo'],
      [W3, 'WickThree'],
    ]) {
      s.emit('room:join', { code: killsCode, name: n });
      await waitFor(s, 'room:joined');
    }
    const killsStarted = waitFor(K2, 'room:started');
    K2.emit('room:start', { mode: 'kills' });
    await killsStarted;

    const posOf = new Map([
      [W1.id, { x: 5, y: 1, z: 0 }],
      [W2.id, { x: 0, y: 1, z: 5 }],
      [W3.id, { x: -5, y: 1, z: 0 }],
    ]);
    const dirOf = new Map([
      [W1.id, { x: 1, y: 0, z: 0 }],
      [W2.id, { x: 0, y: 0, z: 1 }],
      [W3.id, { x: -1, y: 0, z: 0 }],
    ]);
    K2.emit('player:state', { pos: { x: 0, y: 1, z: 0 }, yaw: 0 });
    for (const w of [W1, W2, W3]) w.emit('player:state', { pos: posOf.get(w.id), yaw: 0 });
    await sleep(250);

    // Track aliveness through server events so we only shoot live targets.
    const alive = new Map([
      [W1.id, true],
      [W2.id, true],
      [W3.id, true],
    ]);
    K2.on('player:died', (p) => alive.set(p.targetId, false));
    K2.on('player:respawned', (p) => alive.set(p.id, true));
    async function waitUntilAlive(id) {
      const t0 = Date.now();
      while (!alive.get(id)) {
        if (Date.now() - t0 > 4500) throw new Error('timed out waiting for a respawn');
        await sleep(50);
      }
    }

    const endedP = waitFor(K2, 'match:ended', 60000);
    const victims = [W1, W2, W3];
    for (let kill = 0; kill < 10; kill++) {
      const target = victims[kill % victims.length];
      await waitUntilAlive(target.id);
      const killDied = waitFor(K2, 'player:died', 6000);
      for (let i = 0; i < 5; i++) {
        await sleep(SHOT_GAP_MS);
        K2.emit('player:shoot', {
          origin: { x: 0, y: 1.6, z: 0 },
          dir: dirOf.get(target.id),
          hitId: target.id,
          hitPoint: posOf.get(target.id),
        });
      }
      await killDied;
    }
    const endMsg = await endedP;
    const endedAt = Date.now();
    assert("kills mode: match:ended with reason 'kills'", endMsg.reason === 'kills', JSON.stringify(endMsg.reason));
    const endRows = new Map(endMsg.scores.map((s) => [s.id, s]));
    assert(
      'kills mode: winner has 10 kills, 0 deaths',
      endRows.get(K2.id)?.kills === 10 && endRows.get(K2.id)?.deaths === 0,
      JSON.stringify(endMsg.scores),
    );
    const victimDeaths = victims
      .map((w) => endRows.get(w.id)?.deaths)
      .sort()
      .join(',');
    assert('kills mode: victim deaths land 3,3,4', victimDeaths === '3,3,4', victimDeaths);
    assert('kills mode: final scoreboard covers all 4 players', endMsg.scores.length === 4);

    const resetMsg = await waitFor(K2, 'room:reset', RESET_DELAY_MS + 3000);
    const resetElapsed = Date.now() - endedAt;
    assert(
      'kills mode: room:reset ~reset-delay after the end',
      resetElapsed > RESET_DELAY_MS - 500 && resetElapsed < RESET_DELAY_MS + 2500,
      `${resetElapsed}ms (delay=${RESET_DELAY_MS})`,
    );
    assert(
      'kills mode: reset snapshot is back to lobby state',
      resetMsg.room.started === false &&
        resetMsg.room.mode === null &&
        resetMsg.room.endsAt === null &&
        resetMsg.room.targetKills === null,
      JSON.stringify(resetMsg.room),
    );
    assert('kills mode: roster preserved through the reset', resetMsg.room.players.length === 4);
    assert('kills mode: no respawns after the match ended', (await firesWithin(K2, 'player:respawned', 3200)) === false);

    const restarted = waitFor(K2, 'room:started', 2000);
    K2.emit('room:start');
    const rs = await restarted;
    assert('kills mode: room is reusable after reset (fresh endless start)', rs.mode === 'endless' && rs.endsAt === null);
    for (const s of [K2, W1, W2, W3]) s.disconnect();
  }

  // ---------------------------------------- 16. timed mode: time ends it
  if (MATCH_TIME_MS <= 15000) {
    const T = connect();
    await waitFor(T, 'connect');
    T.emit('room:create', { name: 'Timer' });
    await waitFor(T, 'room:created');
    const startAt = Date.now();
    const timedEnded = waitFor(T, 'match:ended', MATCH_TIME_MS + 4000);
    T.emit('room:start', { mode: 'timed' });
    await waitFor(T, 'room:started');
    const tEnd = await timedEnded;
    const elapsed = Date.now() - startAt;
    assert("timed: match:ended with reason 'time'", tEnd.reason === 'time', JSON.stringify(tEnd.reason));
    assert(
      'timed: ends ~match-time after start',
      elapsed > MATCH_TIME_MS - 800 && elapsed < MATCH_TIME_MS + 2500,
      `${elapsed}ms (match=${MATCH_TIME_MS})`,
    );
    assert(
      'timed: final scores are the zeroed roster',
      tEnd.scores.length === 1 && tEnd.scores[0].id === T.id && tEnd.scores[0].kills === 0 && tEnd.scores[0].deaths === 0,
      JSON.stringify(tEnd.scores),
    );
    const tReset = await waitFor(T, 'room:reset', RESET_DELAY_MS + 3000);
    assert('timed: room resets to lobby after the scoreboard', tReset.room.started === false && tReset.room.mode === null);
    T.disconnect();
  } else {
    console.log('SKIP  timed-mode end-to-end (boot server+test with BOOM_MATCH_TIME_MS<=15000)');
  }

  // ------------------------------------------------- 17. magic ink (combat)
  {
    const I = connect();
    const J = connect();
    await Promise.all([waitFor(I, 'connect'), waitFor(J, 'connect')]);
    I.emit('room:create', { name: 'Inker' });
    const inkRoom = (await waitFor(I, 'room:created')).room.code;
    J.emit('room:join', { code: inkRoom, name: 'Judge' });
    await waitFor(J, 'room:joined');

    const inkBudgetP = waitFor(I, 'ink:budget');
    I.emit('room:start'); // endless
    await waitFor(I, 'room:started');
    const startBudget = await inkBudgetP;
    assert('ink: combat budget starts at 12m', Math.abs(startBudget.ink - 12) < 0.01, `${startBudget.ink}`);

    const plane = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };
    const draw = (strokes, origin = { x: 0, y: 1.5, z: 0 }) =>
      I.emit('ink:draw', { origin, ...plane, strokes });

    // Valid 2m line: broadcast to BOTH players, budget drops to ~10.
    const iObj = waitFor(I, 'ink:object');
    const jObj = waitFor(J, 'ink:object');
    const afterDraw = waitFor(I, 'ink:budget');
    draw([[{ x: -1, y: 0 }, { x: 1, y: 0 }]]);
    const [objI, objJ] = await Promise.all([iObj, jObj]);
    assert('ink: object broadcast to owner and others', objI.object.id === objJ.object.id);
    assert('ink: owner recorded', objI.object.ownerId === I.id);
    assert(
      'ink: stroke data relayed verbatim',
      objI.object.strokes.length === 1 && objI.object.strokes[0].length === 2 && objI.object.strokes[0][0].x === -1,
      JSON.stringify(objI.object.strokes),
    );
    assert(
      'ink: combat drawings expire (~30s TTL)',
      typeof objI.object.expiresAt === 'number' && objI.object.expiresAt - Date.now() > 25000 && objI.object.expiresAt - Date.now() < 32000,
      `${objI.object.expiresAt}`,
    );
    const budgetAfterDraw = await afterDraw;
    assert('ink: cost deducted (12 - 2m)', Math.abs(budgetAfterDraw.ink - 10) < 0.15, `${budgetAfterDraw.ink}`);

    // Malformed payloads are silently rejected (no broadcast).
    const rejects = [
      ['non-unit right basis', { origin: { x: 0, y: 1.5, z: 0 }, right: { x: 2, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, strokes: [[{ x: 0, y: 0 }, { x: 1, y: 0 }]] }],
      ['tilted up basis', { origin: { x: 0, y: 1.5, z: 0 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0.6, y: 0.8, z: 0 }, strokes: [[{ x: 0, y: 0 }, { x: 1, y: 0 }]] }],
      ['out-of-bounds point', { origin: { x: 0, y: 1.5, z: 0 }, ...plane, strokes: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]] }],
      ['single-point stroke', { origin: { x: 0, y: 1.5, z: 0 }, ...plane, strokes: [[{ x: 0, y: 0 }]] }],
      ['origin outside arena', { origin: { x: 500, y: 1.5, z: 0 }, ...plane, strokes: [[{ x: 0, y: 0 }, { x: 1, y: 0 }]] }],
      ['too many strokes', { origin: { x: 0, y: 1.5, z: 0 }, ...plane, strokes: Array.from({ length: 7 }, () => [{ x: 0, y: 0 }, { x: 1, y: 0 }]) }],
    ];
    for (const [label, payload] of rejects) {
      const got = firesWithin(J, 'ink:object', 350);
      I.emit('ink:draw', payload);
      assert(`ink reject: ${label}`, (await got) === false);
    }

    // Over budget: friendly error + corrected budget, no object.
    const overObj = firesWithin(J, 'ink:object', 400);
    const overErr = waitFor(I, 'room:error');
    draw([[{ x: -3, y: -2 }, { x: 3, y: -2 }, { x: -3, y: -1 }, { x: 3, y: -1 }]]); // ~18m > ~10m left
    const errMsg = await overErr;
    assert('ink: over-budget draw errors with an ink message', /ink/i.test(errMsg.message), errMsg.message);
    assert('ink: over-budget draw not broadcast', (await overObj) === false);

    // Owner-only erase: Judge cannot erase Inker's drawing…
    const stolenErase = firesWithin(J, 'ink:removed', 350);
    J.emit('ink:erase', { id: objI.object.id });
    assert('ink: erase is owner-only', (await stolenErase) === false);

    // …but the owner can, gets the refund, and everyone sees the removal.
    const removedJ = waitFor(J, 'ink:removed');
    const refund = waitFor(I, 'ink:budget');
    I.emit('ink:erase', { id: objI.object.id });
    const removedMsg = await removedJ;
    assert('ink: erase broadcasts ink:removed', removedMsg.id === objI.object.id);
    const refunded = await refund;
    assert('ink: erase refunds the cost (capped)', refunded.ink > 10.5 && refunded.ink <= 12.01, `${refunded.ink}`);

    // Late joiner receives all live drawings + their own budget.
    const drawnAgain = waitFor(J, 'ink:object');
    draw([[{ x: 0, y: -1 }, { x: 0, y: 1 }]]);
    await drawnAgain;
    const L = connect();
    await waitFor(L, 'connect');
    const lateInk = waitFor(L, 'ink:object', 2500);
    const lateBudget = waitFor(L, 'ink:budget', 2500);
    L.emit('room:join', { code: inkRoom, name: 'Late' });
    await waitFor(L, 'room:joined');
    const lateObj = await lateInk;
    assert('ink: late joiner receives live drawings', lateObj.object.ownerId === I.id);
    assert('ink: late joiner receives a budget', Math.abs((await lateBudget).ink - 12) < 0.01);

    for (const s of [I, J, L]) s.disconnect();
  }

  // ------------------------------------------------------- 18. escape mode
  {
    const E1 = connect();
    const E2 = connect();
    await Promise.all([waitFor(E1, 'connect'), waitFor(E2, 'connect')]);
    E1.emit('room:create', { name: 'Esc1' });
    const escCode = (await waitFor(E1, 'room:created')).room.code;
    E2.emit('room:join', { code: escCode, name: 'Esc2' });
    await waitFor(E2, 'room:joined');

    const escStartAt = Date.now();
    const escStartP = waitFor(E1, 'room:started');
    const escBudgetP = waitFor(E1, 'ink:budget');
    E1.emit('room:start', { mode: 'escape' });
    const escStart = await escStartP;
    assert(
      'escape: room:started carries escape mode with startedAt',
      escStart.mode === 'escape' && escStart.endsAt === null && escStart.targetKills === null && typeof escStart.startedAt === 'number',
      JSON.stringify(escStart),
    );
    assert('escape: budget is the 30m escape pool', Math.abs((await escBudgetP).ink - 30) < 0.01);

    // No shooting in co-op: valid-looking claims must do nothing.
    E1.emit('player:state', { pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    E2.emit('player:state', { pos: { x: 2, y: 0, z: 0 }, yaw: 0 });
    await sleep(220);
    const damaged = firesWithin(E2, 'player:damaged', 600);
    E1.emit('player:shoot', { origin: { x: 0, y: 1.6, z: 0 }, dir: { x: 1, y: 0, z: 0 }, hitId: E2.id, hitPoint: { x: 2, y: 0, z: 0 } });
    assert('escape: shooting is ignored entirely', (await damaged) === false);

    // Escape drawings are permanent.
    const escObj = waitFor(E2, 'ink:object');
    E1.emit('ink:draw', {
      origin: { x: -12, y: 1.5, z: 0 },
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      strokes: [[{ x: -3, y: 0 }, { x: 3, y: 0 }]],
    });
    assert('escape: drawings never expire', (await escObj).object.expiresAt === null);

    // Stage triggers: cumulative, idempotent, invalid ones ignored.
    const stage1 = waitFor(E2, 'escape:state');
    E1.emit('escape:trigger', { stage: 'chasm' });
    assert('escape: chasm stage broadcast', (await stage1).stages.includes('chasm'));
    const dupStage = firesWithin(E2, 'escape:state', 350);
    E1.emit('escape:trigger', { stage: 'chasm' });
    assert('escape: duplicate stage is idempotent', (await dupStage) === false);
    const badStage = firesWithin(E2, 'escape:state', 350);
    E1.emit('escape:trigger', { stage: 'teleport-hack' });
    assert('escape: invalid stage ignored', (await badStage) === false);

    const stage2 = waitFor(E2, 'escape:state');
    E2.emit('escape:trigger', { stage: 'plate' });
    const s2 = await stage2;
    assert('escape: any player can trigger; stages accumulate', s2.stages.includes('chasm') && s2.stages.includes('plate'));

    // Late joiner catches up on stages.
    const E3 = connect();
    await waitFor(E3, 'connect');
    const lateStages = waitFor(E3, 'escape:state', 2500);
    E3.emit('room:join', { code: escCode, name: 'Esc3' });
    await waitFor(E3, 'room:joined');
    assert('escape: late joiner receives completed stages', (await lateStages).stages.length === 2);

    const stage3 = waitFor(E2, 'escape:state');
    E1.emit('escape:trigger', { stage: 'key' });
    await stage3;

    // 'exit' finishes: match:ended with reason 'escape' + the completion time.
    const escEndP = waitFor(E2, 'match:ended', 4000);
    E2.emit('escape:trigger', { stage: 'exit' });
    const escEnd = await escEndP;
    const escElapsed = Date.now() - escStartAt;
    assert("escape: match:ended reason 'escape'", escEnd.reason === 'escape', JSON.stringify(escEnd.reason));
    assert(
      'escape: escapeTimeMs ~ elapsed match time',
      typeof escEnd.escapeTimeMs === 'number' && Math.abs(escEnd.escapeTimeMs - escElapsed) < 1500,
      `${escEnd.escapeTimeMs} vs ${escElapsed}`,
    );
    assert('escape: scores stay zeroed (co-op)', escEnd.scores.every((s) => s.kills === 0 && s.deaths === 0));

    const escReset = await waitFor(E1, 'room:reset', RESET_DELAY_MS + 3000);
    assert(
      'escape: room resets to lobby afterwards',
      escReset.room.started === false && escReset.room.mode === null && escReset.room.startedAt === null,
      JSON.stringify(escReset.room),
    );
    for (const s of [E1, E2, E3]) s.disconnect();
  }

  // ======================================================================
  // 19. Doodle Royale (party mode)
  // ======================================================================
  if (PARTY_READY) {
    const GRACE_MS = Math.round(PARTY_ROUND_MS * 0.15);
    const P1 = connect(); // Pia — host, wins everything
    const P2 = connect(); // Quinn
    const P3 = connect(); // Rey — dies a lot, earns the pity ink
    await Promise.all([P1, P2, P3].map((s) => waitFor(s, 'connect')));
    P1.emit('room:create', { name: 'Pia' });
    const partyCode = (await waitFor(P1, 'room:created')).room.code;
    P2.emit('room:join', { code: partyCode, name: 'Quinn' });
    await waitFor(P2, 'room:joined');
    P3.emit('room:join', { code: partyCode, name: 'Rey' });
    await waitFor(P3, 'room:joined');

    // Live state senders (10Hz) with mutable positions per player.
    const pos = {
      p1: { x: 0, y: 9, z: 0 }, // high scaffold — survives the tide, wins altitude
      p2: { x: 5, y: 6, z: 0 }, // lower scaffold — survives
      p3: { x: 0, y: 0, z: 5 }, // floor — drowns as soon as the ink rises
    };
    const senders = [
      setInterval(() => P1.emit('player:state', { pos: pos.p1, yaw: 0 }), 100),
      setInterval(() => P2.emit('player:state', { pos: pos.p2, yaw: 0 }), 100),
      setInterval(() => P3.emit('player:state', { pos: pos.p3, yaw: 0 }), 100),
    ];

    const quips = [];
    P2.on('party:quip', (q) => quips.push(q.text));
    const scoreLog = [];
    P1.on('match:score', (p) => scoreLog.push(p.scores));
    const latestScores = () => new Map((scoreLog[scoreLog.length - 1] ?? []).map((s) => [s.id, s]));

    // ---- match start -> round 1 intermission card
    const pStartedP = waitFor(P1, 'room:started', 3000);
    const r1P = waitFor(P1, 'party:round', 3000);
    const r1OtherP = waitFor(P2, 'party:round', 3000);
    const p1BudgetP = waitFor(P1, 'ink:budget', 3000);
    const partyT0 = Date.now();
    P1.emit('room:start', { mode: 'party' });
    const pStarted = await pStartedP;
    assert(
      'party: room:started carries party mode with null endsAt/targetKills',
      pStarted.mode === 'party' && pStarted.endsAt === null && pStarted.targetKills === null,
      JSON.stringify(pStarted),
    );
    const r1 = await r1P;
    assert('party: first party:round is round 1/2 intermission', r1.round === 1 && r1.totalRounds === 2 && r1.phase === 'intermission', JSON.stringify({ round: r1.round, phase: r1.phase }));
    assert('party: round 1 kind honors BOOM_PARTY_FORCE_KIND', r1.kind === 'rising-ink', r1.kind);
    assert(
      'party: intermission endsAt ~ now + intermission',
      r1.endsAt - partyT0 > PARTY_INTERMISSION_MS - 1000 && r1.endsAt - partyT0 < PARTY_INTERMISSION_MS + 1500,
      `${r1.endsAt - partyT0}ms`,
    );
    assert(
      'party: announcer line present and <=70 chars',
      typeof r1.announcer === 'string' && r1.announcer.length > 0 && r1.announcer.length <= 70,
      JSON.stringify(r1.announcer),
    );
    assert(
      'party: rising-ink params sane (no guns, 22/0.9 ink, no pity/pulse)',
      r1.params.shootingEnabled === false &&
        r1.params.gunsUnlockAt === null &&
        r1.params.inkCap === 22 &&
        Math.abs(r1.params.inkRegen - 0.9) < 1e-9 &&
        r1.params.pityId === null &&
        r1.params.pulse === null &&
        r1.params.pointsMult === 1,
      JSON.stringify(r1.params),
    );
    assert(
      'party: lava rises from y=0 after a 15% grace',
      r1.params.lava !== null &&
        r1.params.lava.startY === 0 &&
        Math.abs(r1.params.lava.riseRate - 0.12) < 1e-9 &&
        Math.abs(r1.params.lava.accel - 0.002) < 1e-9 &&
        r1.params.lava.startAt === r1.endsAt + GRACE_MS,
      JSON.stringify(r1.params.lava),
    );
    const r1Other = await r1OtherP;
    assert('party: party:round broadcast to the whole room', r1Other.round === 1 && r1Other.phase === 'intermission');
    assert('party: round budget seeded at the round cap (22m)', Math.abs((await p1BudgetP).ink - 22) < 0.01);
    await sleep(400);
    assert('party: The Critic quips on match start', quips.length >= 1, `${quips.length}`);

    // ---- intermission -> playing flip
    const playing1 = await waitFor(P1, 'party:round', PARTY_INTERMISSION_MS + 2500);
    assert('party: phase flips to playing', playing1.round === 1 && playing1.phase === 'playing', JSON.stringify({ round: playing1.round, phase: playing1.phase }));
    assert('party: playing endsAt is in the future', playing1.endsAt > Date.now(), `${playing1.endsAt - Date.now()}ms`);
    assert('party: playing endsAt = intermission end + round length', playing1.endsAt === r1.endsAt + PARTY_ROUND_MS, `${playing1.endsAt - r1.endsAt}`);
    assert('party: playing payload reuses the intermission params', playing1.params.lava !== null && playing1.params.lava.startAt === r1.params.lava.startAt);

    // ---- rising ink: floor player drowns, scaffolded players survive
    const diedByP1 = [];
    P1.on('player:died', (p) => diedByP1.push(p));
    const p3DiedP = waitFor(P3, 'player:died', GRACE_MS + 4000);
    const p3Died = await p3DiedP;
    assert('party: rising ink eliminates the floor player', p3Died.targetId === P3.id, JSON.stringify(p3Died));
    assert('party: environmental kill reports killerId == targetId', p3Died.killerId === P3.id, p3Died.killerId);
    assert('party: eliminated respawnAt == round end (death overlay counts to it)', p3Died.respawnAt === playing1.endsAt, `${p3Died.respawnAt} vs ${playing1.endsAt}`);

    const p3RespP = waitFor(P3, 'player:respawned', PARTY_ROUND_MS + 4000);
    const inter2P = waitFor(P1, 'party:round', PARTY_ROUND_MS + 4000);
    const p3Round2BudgetP = waitFor(P3, 'ink:budget', PARTY_ROUND_MS + 4000);
    const p1Round2BudgetP = waitFor(P1, 'ink:budget', PARTY_ROUND_MS + 4000);
    const noRespawnWindow = Math.max(300, playing1.endsAt - Date.now() - 700);
    assert(
      'party: no respawn while the round is still running',
      (await firesWithin(P3, 'player:respawned', noRespawnWindow)) === false,
    );
    const p3Resp = await p3RespP;
    assert('party: dead players revived in bulk at round end', p3Resp.id === P3.id);
    const inter2 = await inter2P;
    assert('party: next intermission card is round 2/2 draw-duel', inter2.round === 2 && inter2.phase === 'intermission' && inter2.kind === 'draw-duel', JSON.stringify({ round: inter2.round, kind: inter2.kind }));
    assert('party: scaffolded players survived the round', !diedByP1.some((d) => d.targetId === P1.id || d.targetId === P2.id), JSON.stringify(diedByP1));

    // Round 1 scoring: survivors +2 (3 starters - 1), altitude winner (Pia) +2.
    {
      const rows = latestScores();
      assert(
        'party: match:score points reflect survival order (4/2/0)',
        rows.get(P1.id)?.kills === 4 && rows.get(P2.id)?.kills === 2 && rows.get(P3.id)?.kills === 0,
        JSON.stringify(scoreLog[scoreLog.length - 1]),
      );
      assert('party: deaths column counts eliminations', rows.get(P3.id)?.deaths === 1 && rows.get(P1.id)?.deaths === 0);
    }

    // ---- round 2 (finale draw-duel): pity, one-hit kills, erasure warfare
    assert('party: last place (Rey) gets the pity boost', inter2.params.pityId === P3.id, `pityId=${inter2.params.pityId}`);
    assert(
      'party: draw-duel finale params (guns on, 8/0.4 ink, x2 points)',
      inter2.params.shootingEnabled === true && inter2.params.inkCap === 8 && Math.abs(inter2.params.inkRegen - 0.4) < 1e-9 && inter2.params.pointsMult === 2 && inter2.params.lava === null,
      JSON.stringify(inter2.params),
    );
    assert('party: pity player budget is cap x1.3 (10.4m)', Math.abs((await p3Round2BudgetP).ink - 10.4) < 0.05);
    assert('party: everyone else resets to the plain cap (8m)', Math.abs((await p1Round2BudgetP).ink - 8) < 0.01);
    assert('party: The Critic mentions the pity/first-elim victim by name', quips.some((t) => t.includes('Rey')), JSON.stringify(quips));

    pos.p1 = { x: 0, y: 1, z: 0 };
    pos.p2 = { x: 5, y: 1, z: 0 };
    pos.p3 = { x: 0, y: 1, z: 5 };
    const playing2 = await waitFor(P1, 'party:round', PARTY_INTERMISSION_MS + 2500);
    assert('party: round 2 starts playing', playing2.round === 2 && playing2.phase === 'playing');
    await sleep(300); // fresh states at the new combat positions

    const plane = { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };
    const lineAP = waitFor(P2, 'ink:object', 2000);
    P1.emit('ink:draw', { origin: { x: 2, y: 1.5, z: 0 }, ...plane, strokes: [[{ x: -1, y: 0 }, { x: 1, y: 0 }]] });
    const lineA = (await lineAP).object;
    const lineBP = waitFor(P1, 'ink:object', 2000);
    const p2DrawBudgetP = waitFor(P2, 'ink:budget', 2000);
    P2.emit('ink:draw', { origin: { x: -2, y: 1.5, z: 0 }, ...plane, strokes: [[{ x: -1, y: 0 }, { x: 1, y: 0 }]] });
    const lineB = (await lineBP).object;
    assert('party: draw-duel spend leaves 6m of 8m', Math.abs((await p2DrawBudgetP).ink - 6) < 0.05);

    // Shoot Pia's drawing: removal broadcast + 50% refund to the shooter.
    const removedP1 = waitFor(P1, 'ink:removed', 2000);
    const removedP3 = waitFor(P3, 'ink:removed', 2000);
    const refundP = waitFor(P2, 'ink:budget', 2000);
    P2.emit('player:shoot', {
      origin: { x: 5, y: 1.6, z: 0 },
      dir: { x: -1, y: 0, z: 0 },
      hitId: null,
      hitPoint: { x: 2, y: 1.5, z: 0 },
      inkId: lineA.id,
    });
    assert('party: erasure removes the ink object for everyone', (await removedP1).id === lineA.id && (await removedP3).id === lineA.id);
    const refunded = await refundP;
    assert('party: erasure refunds half the cost to the shooter (~7m)', refunded.ink > 6.8 && refunded.ink < 7.6, `${refunded.ink}`);

    // Far-off inkId claim is rejected (hitPoint must touch the strokes).
    await sleep(SHOT_GAP_MS);
    const bogusErase = firesWithin(P1, 'ink:removed', 450);
    P3.emit('player:shoot', {
      origin: { x: 0, y: 1.6, z: 5 },
      dir: { x: 1, y: 0, z: 0 },
      hitId: null,
      hitPoint: { x: 20, y: 1, z: 0 },
      inkId: lineB.id,
    });
    assert('party: far-off inkId claim removes nothing', (await bogusErase) === false);

    // One-hit kill (shotDamage override 100).
    const oneHitDmgP = waitFor(P3, 'player:damaged', 2000);
    const oneHitDiedP = waitFor(P1, 'player:died', 2000);
    P1.emit('player:shoot', {
      origin: { x: 0, y: 1.6, z: 0 },
      dir: { x: 0, y: 0, z: 1 },
      hitId: P3.id,
      hitPoint: { x: 0, y: 1, z: 5 },
    });
    const oneHitDmg = await oneHitDmgP;
    assert('party: draw-duel is one-hit (100 -> 0 health)', oneHitDmg.health === 0, JSON.stringify(oneHitDmg));
    const oneHitDied = await oneHitDiedP;
    assert('party: shot elimination credited to the shooter', oneHitDied.targetId === P3.id && oneHitDied.killerId === P1.id && oneHitDied.respawnAt === playing2.endsAt, JSON.stringify(oneHitDied));

    // Final kill: 1 alive ends the round early -> podium -> match:ended('party').
    let tPodium = 0;
    let tEnded = 0;
    const podiumP = waitFor(P1, 'party:round', 4000).then((p) => ((tPodium = Date.now()), p));
    const endedP = waitFor(P1, 'match:ended', 5000).then((p) => ((tEnded = Date.now()), p));
    await sleep(SHOT_GAP_MS);
    P1.emit('player:shoot', {
      origin: { x: 0, y: 1.6, z: 0 },
      dir: { x: 1, y: 0, z: 0 },
      hitId: P2.id,
      hitPoint: { x: 5, y: 1, z: 0 },
    });
    const podium = await podiumP;
    assert('party: podium card after the final round', podium.phase === 'podium' && podium.round === 2, JSON.stringify({ phase: podium.phase, round: podium.round }));
    assert(
      'party: podium endsAt ~ now + podium delay',
      podium.endsAt - tPodium > PARTY_PODIUM_MS - 800 && podium.endsAt - tPodium < PARTY_PODIUM_MS + 1500,
      `${podium.endsAt - tPodium}ms`,
    );
    assert('party: podium announcer crowns the champion by name', podium.announcer.includes('Pia') && podium.announcer.length <= 70, JSON.stringify(podium.announcer));
    const pEnded = await endedP;
    assert('party: podium card precedes match:ended', tPodium <= tEnded);
    assert("party: match:ended reason is 'party'", pEnded.reason === 'party', JSON.stringify(pEnded.reason));
    {
      const rows = new Map(pEnded.scores.map((s) => [s.id, s]));
      assert(
        'party: final scores carry points-as-kills (16/4/0)',
        rows.get(P1.id)?.kills === 16 && rows.get(P2.id)?.kills === 4 && rows.get(P3.id)?.kills === 0,
        JSON.stringify(pEnded.scores),
      );
      assert(
        'party: final deaths are eliminations (0/1/2)',
        rows.get(P1.id)?.deaths === 0 && rows.get(P2.id)?.deaths === 1 && rows.get(P3.id)?.deaths === 2,
        JSON.stringify(pEnded.scores),
      );
    }
    assert('party: quips stay in voice (non-empty, <=70 chars)', quips.length >= 3 && quips.every((t) => t.length > 0 && t.length <= 70), JSON.stringify(quips));
    assert('party: The Critic reviews the champion', quips.some((t) => t.includes('Pia')), JSON.stringify(quips));

    const pReset = await waitFor(P1, 'room:reset', PARTY_PODIUM_MS + 3000);
    const resetGap = Date.now() - tEnded;
    assert('party: room resets ~podium delay after the end', resetGap > PARTY_PODIUM_MS - 700 && resetGap < PARTY_PODIUM_MS + 2500, `${resetGap}ms`);
    assert('party: reset returns to a clean lobby', pReset.room.started === false && pReset.room.mode === null);

    // ---- match 2: late join mid-round + leaver mid-round
    pos.p1 = { x: 0, y: 5, z: 0 };
    pos.p2 = { x: 5, y: 5, z: 0 };
    pos.p3 = { x: 0, y: 5, z: 5 };
    const started2P = waitFor(P1, 'room:started', 3000);
    const inter1bP = waitFor(P1, 'party:round', 3000);
    P1.emit('room:start', { mode: 'party' });
    await started2P;
    const inter1b = await inter1bP;
    assert('party rematch: fresh round 1 intermission', inter1b.round === 1 && inter1b.phase === 'intermission' && inter1b.kind === 'rising-ink');
    const playing1bP = waitFor(P1, 'party:round', PARTY_INTERMISSION_MS + 2500);
    const playing1b = await playing1bP;
    assert('party rematch: round 1 playing', playing1b.phase === 'playing');
    await sleep(600); // join mid-round

    const L = connect();
    await waitFor(L, 'connect');
    let lPos = { x: -5, y: 1, z: 0 };
    const lJoinedP = waitFor(L, 'room:joined', 2000);
    const lPartyP = waitFor(L, 'party:round', 2000);
    const lBudgetP = waitFor(L, 'ink:budget', 2000);
    const lDiedP = waitFor(L, 'player:died', 2000);
    const p1SeesLDieP = waitFor(P1, 'player:died', 2000);
    L.emit('room:join', { code: partyCode, name: 'Zed' });
    await lJoinedP;
    const lSender = setInterval(() => L.emit('player:state', { pos: lPos, yaw: 0 }), 100);
    const lParty = await lPartyP;
    assert(
      'party late join: current party:round replayed to the joiner',
      lParty.round === 1 && lParty.phase === 'playing' && lParty.kind === 'rising-ink' && lParty.endsAt === playing1b.endsAt && lParty.params.inkCap === 22,
      JSON.stringify({ round: lParty.round, phase: lParty.phase }),
    );
    assert('party late join: joiner budget seeded at the round cap', Math.abs((await lBudgetP).ink - 22) < 0.01);
    const lDied = await lDiedP;
    assert(
      'party late join: joiner arrives eliminated until round end',
      lDied.targetId === L.id && lDied.killerId === L.id && lDied.respawnAt === playing1b.endsAt,
      JSON.stringify(lDied),
    );
    const p1SawL = await p1SeesLDieP;
    assert('party late join: the room sees the bench broadcast too', p1SawL.targetId === L.id);

    const lRespP = waitFor(L, 'player:respawned', PARTY_ROUND_MS + 4000);
    const inter2bP = waitFor(P1, 'party:round', PARTY_ROUND_MS + 4000);
    const lResp = await lRespP;
    assert('party late join: joiner revived for the next round', lResp.id === L.id);
    const inter2b = await inter2bP;
    assert('party late join: joiner (0 pts) becomes the pity pick', inter2b.round === 2 && inter2b.params.pityId === L.id, `pityId=${inter2b.params.pityId}`);

    pos.p1 = { x: 0, y: 1, z: 0 };
    pos.p2 = { x: 5, y: 1, z: 0 };
    pos.p3 = { x: 0, y: 1, z: 5 };
    lPos = { x: -5, y: 1, z: 0 };
    const playing2b = await waitFor(P1, 'party:round', PARTY_INTERMISSION_MS + 2500);
    assert('party rematch: round 2 playing', playing2b.phase === 'playing' && playing2b.kind === 'draw-duel');
    await sleep(300);

    const kill1P = waitFor(P2, 'player:died', 2000);
    P1.emit('player:shoot', { origin: { x: 0, y: 1.6, z: 0 }, dir: { x: -1, y: 0, z: 0 }, hitId: L.id, hitPoint: { x: -5, y: 1, z: 0 } });
    assert('party rematch: first duel kill lands', (await kill1P).targetId === L.id);
    await sleep(SHOT_GAP_MS);
    const kill2P = waitFor(P2, 'player:died', 2000);
    P1.emit('player:shoot', { origin: { x: 0, y: 1.6, z: 0 }, dir: { x: 0, y: 0, z: 1 }, hitId: P3.id, hitPoint: { x: 0, y: 1, z: 5 } });
    assert('party rematch: second duel kill lands', (await kill2P).targetId === P3.id);

    // Two alive (Pia, Quinn). Quinn leaves -> winner condition met by a leaver.
    let tPodium2 = 0;
    const podium2P = waitFor(P1, 'party:round', 3500).then((p) => ((tPodium2 = Date.now()), p));
    const ended2P = waitFor(P1, 'match:ended', 4500);
    const tLeave = Date.now();
    P2.disconnect();
    const podium2 = await podium2P;
    assert('party leaver: mid-round leave ends the round without stalling', podium2.phase === 'podium' && tPodium2 - tLeave < 2200, `${tPodium2 - tLeave}ms`);
    const ended2 = await ended2P;
    {
      const rows = new Map(ended2.scores.map((s) => [s.id, s]));
      assert('party leaver: leaver dropped from the final scores', ended2.scores.length === 3 && !rows.has(P2.id), JSON.stringify(ended2.scores));
      assert(
        'party rematch: points settle 18/4/0 (host sweeps)',
        rows.get(P1.id)?.kills === 18 && rows.get(P3.id)?.kills === 4 && rows.get(L.id)?.kills === 0,
        JSON.stringify(ended2.scores),
      );
      assert('party rematch: benched joiner charged no phantom deaths', rows.get(L.id)?.deaths === 1);
    }
    assert('party rematch: champion named on the podium again', podium2.announcer.includes('Pia'), JSON.stringify(podium2.announcer));
    await waitFor(P1, 'room:reset', PARTY_PODIUM_MS + 3000);
    record('party rematch: room resets to lobby after the podium', true);

    senders.forEach(clearInterval);
    clearInterval(lSender);
    for (const s of [P1, P2, P3, L]) s.disconnect();
  } else {
    console.log(
      'SKIP  party-mode e2e (boot server+test with BOOM_PARTY_ROUNDS=2 BOOM_PARTY_INTERMISSION_MS=1500 BOOM_PARTY_ROUND_MS=6000 BOOM_PARTY_PODIUM_MS=2000 BOOM_PARTY_FORCE_KIND=rising-ink,draw-duel)',
    );
  }

  console.log(`\n${results.length} checks, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
