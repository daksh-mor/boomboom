import type { Server, Socket } from 'socket.io';

import {
  FIRE_COOLDOWN_MS,
  HIT_POS_TOLERANCE,
  INK_BUDGET_COMBAT,
  INK_BUDGET_ESCAPE,
  INK_MAX_POINTS_PER_STROKE,
  INK_MAX_STROKES,
  INK_MAX_TOTAL_LENGTH,
  INK_MIN_TOTAL_LENGTH,
  INK_REGEN_COMBAT,
  INK_REGEN_ESCAPE,
  INK_SKETCH_HALF_H,
  INK_SKETCH_HALF_W,
  INK_TTL_COMBAT_MS,
  MATCH_TIME_MS,
  MAX_HEALTH,
  MAX_INK_OBJECTS_PER_ROOM,
  MAX_NAME_LENGTH,
  MAX_PLAYERS_PER_ROOM,
  PARTY_DRAW_DUEL_CAP,
  PARTY_DRAW_DUEL_DAMAGE,
  PARTY_DRAW_DUEL_MS,
  PARTY_DRAW_DUEL_REGEN,
  PARTY_ERASE_REFUND,
  PARTY_ERASE_REFUND_CAP,
  PARTY_FINALE_CAP,
  PARTY_FINALE_POINTS_MULT,
  PARTY_FINALE_REGEN,
  PARTY_FINALE_RISE_MULT,
  PARTY_FINALE_TTL_MS,
  PARTY_FLOOR_CHECK_CAP,
  PARTY_FLOOR_CHECK_MS,
  PARTY_FLOOR_CHECK_REGEN,
  PARTY_FLOOR_SAFE_Y,
  PARTY_GUNS_UNLOCK_MS,
  PARTY_INTERMISSION_MS,
  PARTY_LAVA_ACCEL,
  PARTY_LAVA_GRACE_MS,
  PARTY_LAVA_RISE_RATE,
  PARTY_LAVA_START_Y,
  PARTY_PITY_CAP_MULT,
  PARTY_PITY_REGEN_MULT,
  PARTY_PODIUM_MS,
  PARTY_PULSE_OFFSETS_S,
  PARTY_PULSE_WARN_MS,
  PARTY_RISING_INK_CAP,
  PARTY_RISING_INK_MS,
  PARTY_RISING_INK_REGEN,
  PARTY_ROUNDS,
  PARTY_SUDDEN_DEATH_MS,
  PARTY_WINNER_BONUS,
  PLAYER_COLORS,
  RESPAWN_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SERVER_BROADCAST_HZ,
  SHOT_DAMAGE,
  TARGET_KILLS,
} from '../../shared/constants.js';
import type {
  ClientToServerEvents,
  EscapeStage,
  InkObjectMsg,
  InkPoint,
  MatchEndReason,
  MatchMode,
  PartyRoundKind,
  PartyRoundParams,
  PlayerInfo,
  PlayerStateBroadcast,
  PlayerStateMsg,
  RoomSnapshot,
  ScoreEntry,
  ServerToClientEvents,
  Vec3,
} from '../../shared/types.js';

type GameServer = Server<ClientToServerEvents, ServerToClientEvents>;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type Timer = ReturnType<typeof setTimeout>;

/** How long the final scoreboard stays up before the room returns to the lobby. */
const ROOM_RESET_DELAY_MS = 7000;
/** Grace subtracted from the fire cooldown so honest clients aren't rejected on timing jitter. */
const COOLDOWN_SLACK_MS = 50;

function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Testability overrides; production falls back to the shared constants.
const MATCH_TIME = envMs('BOOM_MATCH_TIME_MS', MATCH_TIME_MS);
const RESET_DELAY = envMs('BOOM_RESET_DELAY_MS', ROOM_RESET_DELAY_MS);

// --- Doodle Royale (party mode) director tuning -------------------------
/** Director tick while a round is playing (~4.5Hz). */
const PARTY_TICK_MS = 220;
/** States older than this are eliminable by lava / floor pulses (anti-AFK). */
const PARTY_STALE_STATE_MS = 1500;
/** Sudden death removes one live ink object roughly this often. */
const PARTY_SUDDEN_DEATH_INK_GAP_MS = 250;
/** Erasure warfare: max distance between hitPoint and an ink stroke polyline. */
const PARTY_INK_HIT_TOLERANCE = 1.5;
/** Comedy beat before roasting a round's first elimination. */
const PARTY_FIRST_ELIM_QUIP_DELAY_MS = 1700;
/** Elimination quips are sampled: at most one per this window. */
const PARTY_ELIM_QUIP_GAP_MS = 4000;
const PARTY_ELIM_QUIP_CHANCE = 0.6;

// Party testability knobs (see e2e/socket.test.mjs):
// BOOM_PARTY_ROUNDS          total rounds (default 5)
// BOOM_PARTY_INTERMISSION_MS intermission length
// BOOM_PARTY_ROUND_MS        overrides EVERY round duration; lava grace becomes
//                            15% of it and pulse/sudden-death/guns offsets scale
//                            proportionally so short test rounds still pulse
// BOOM_PARTY_PODIUM_MS       podium length (also the party reset delay)
// BOOM_PARTY_FORCE_KIND      comma list of kinds; round i uses entry
//                            min(i, len)-1 (last entry repeats), replacing the
//                            random schedule — for deterministic tests
const PARTY_ROUND_COUNT = Math.max(1, Math.floor(envMs('BOOM_PARTY_ROUNDS', PARTY_ROUNDS)));
const PARTY_INTERMISSION = envMs('BOOM_PARTY_INTERMISSION_MS', PARTY_INTERMISSION_MS);
const PARTY_PODIUM = envMs('BOOM_PARTY_PODIUM_MS', PARTY_PODIUM_MS);
const PARTY_ROUND_OVERRIDE: number | null = (() => {
  const value = Number(process.env.BOOM_PARTY_ROUND_MS);
  return Number.isFinite(value) && value > 0 ? value : null;
})();
const PARTY_KIND_VALUES: readonly PartyRoundKind[] = ['rising-ink', 'draw-duel', 'floor-check'];
const PARTY_FORCED_KINDS: PartyRoundKind[] = (process.env.BOOM_PARTY_FORCE_KIND ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is PartyRoundKind => (PARTY_KIND_VALUES as readonly string[]).includes(s));

// --- The Critic (party announcer) ---------------------------------------
// Voice: deadpan gallery curator reviewing violence. Lowercase, <=70 chars.
const QUIP_MATCH_START = [
  '{count} artists. {rounds} rounds. the rest of you become lore.',
  "welcome to the gallery. tonight's medium: violence.",
  'the exhibit opens. please do not feed the artists.',
  'everything you draw will be used against you.',
  'ink is temporary. embarrassment is forever.',
  'no refunds. the gift shop burned down.',
];
const ANNOUNCE_INTRO: Record<PartyRoundKind, string[]> = {
  'rising-ink': [
    'rising ink. the floor is having a flood sale. climb.',
    'the tide comes in. altitude is the only honest critic.',
    'build tall or learn to swim in copyright-free black.',
    'the ink rises. your standards, hopefully, with it.',
    'gravity versus ink. place your bets. then place a ladder.',
  ],
  'draw-duel': [
    'draw-duel. one bullet, one obituary. make it tasteful.',
    'duels tonight. the pen is mightier. the gun is faster.',
    'one hit each. consider it minimalist criticism.',
    'shoot the art. shoot the artist. curate aggressively.',
    'budget cuts: eight meters of ink and no second chances.',
  ],
  'floor-check': [
    'floor-check. periodically, the floor stops believing in you.',
    'when the klaxon sounds, be somewhere the floor is not.',
    'the ground takes attendance. absences are permanent.',
    'pop quiz, every few seconds: are you standing on something.',
    'the floor is lava-adjacent. crates and doodles count as art.',
  ],
};
const ANNOUNCE_GO = [
  'begin.',
  'curtains up. try to die interestingly.',
  'the canvas is live. so are you. for now.',
  'start. the critics are watching. the critic is me.',
  "go on then. impress me. statistically you won't.",
];
const QUIP_FIRST_ELIM = [
  '{name} died first. someone had to set the bar underground.',
  '{name} opens the exhibit of failure. bold choice.',
  'first out: {name}. the gallery mourns. briefly.',
  '{name} has been reviewed. zero stars.',
  "a moment of silence for {name}. moment's over.",
];
const QUIP_ELIM = [
  '{name} has left the composition.',
  '{name}: removed for taste reasons.',
  'the jury dismisses {name}.',
  '{name} is now negative space.',
  '{name} exits, pursued by physics.',
  'less is more. {name} is less.',
];
const QUIP_PITY = [
  '{name} gets extra ink. the museum pities loudly.',
  'a stipend for {name}. starving-artist outreach program.',
  '{name}, your grant application is approved. condolences.',
  'extra ink for {name}. sympathy, curated.',
  'the foundation sponsors {name}. results not guaranteed.',
];
const QUIP_SUDDEN_DEATH = [
  "sudden death. the ink dries. the knives don't.",
  'no more ink. express yourselves with consequences.',
  'the well is dry. the argument continues.',
  'supplies ended. survive on technique alone.',
  'sudden death: the gallery repossesses your medium.',
];
const ANNOUNCE_PODIUM = [
  '{name} takes the gallery. everyone else took notes.',
  "tonight's masterpiece: {name}. the rest were studies.",
  "{name} wins. i've seen worse. that's the review.",
  'the critics agree, because i am all of them: {name}.',
  'gold star for {name}. participation grief for the rest.',
  'the retrospective belongs to {name}. the rest, to the bin.',
];

function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

function fillQuip(line: string, vars: Record<string, string>): string {
  let out = line;
  for (const [key, value] of Object.entries(vars)) out = out.replaceAll(`{${key}}`, value);
  return out;
}

function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/**
 * Rounds 1..N-1: every kind appears at least once (extras random), shuffled.
 * The final round is always the rising-ink finale remix — unless
 * BOOM_PARTY_FORCE_KIND pins the whole schedule (tests).
 */
function buildPartySchedule(total: number): PartyRoundKind[] {
  if (PARTY_FORCED_KINDS.length > 0) {
    return Array.from(
      { length: total },
      (_, i) => PARTY_FORCED_KINDS[Math.min(i, PARTY_FORCED_KINDS.length - 1)]!,
    );
  }
  const coverage = shuffleInPlace([...PARTY_KIND_VALUES]);
  const openers: PartyRoundKind[] = [];
  for (let i = 0; i < total - 1; i++) {
    openers.push(i < coverage.length ? coverage[i]! : pick(PARTY_KIND_VALUES));
  }
  shuffleInPlace(openers);
  openers.push('rising-ink');
  return openers;
}

function partyRoundDuration(kind: PartyRoundKind): number {
  if (PARTY_ROUND_OVERRIDE !== null) return PARTY_ROUND_OVERRIDE;
  switch (kind) {
    case 'rising-ink':
      return PARTY_RISING_INK_MS;
    case 'draw-duel':
      return PARTY_DRAW_DUEL_MS;
    case 'floor-check':
      return PARTY_FLOOR_CHECK_MS;
  }
}

interface PlayerRecord {
  info: PlayerInfo;
  /** Latest self-reported movement state; null until the first valid player:state. */
  state: PlayerStateMsg | null;
  /** Server-clock time the state was last accepted (0 = never) — party anti-AFK. */
  stateAt: number;
  health: number;
  alive: boolean;
  kills: number;
  deaths: number;
  /** Party-mode points; shown as `kills` in the scoreboard pipeline. */
  points: number;
  /** Server-clock time of the last accepted shot (0 = never). */
  lastShotAt: number;
  /** Set while dead so late joiners can be sent an accurate player:died replay. */
  respawnAt: number | null;
  lastKillerId: string | null;
  respawnTimer: Timer | null;
  /** Remaining ink (meters of stroke); regenerates lazily via inkUpdatedAt. */
  ink: number;
  inkUpdatedAt: number;
}

interface InkRecord {
  object: InkObjectMsg;
  /** Stroke length spent, refunded on erase. */
  cost: number;
  expiryTimer: Timer | null;
}

type PartyPhase = 'intermission' | 'playing' | 'podium';

/** Server-side state of a running Doodle Royale match (null outside party mode). */
interface PartyState {
  round: number; // 1-based
  totalRounds: number;
  schedule: PartyRoundKind[];
  kind: PartyRoundKind;
  phase: PartyPhase;
  /** Epoch ms when the current phase ends. */
  phaseEndsAt: number;
  /** Epoch ms when the playing phase ends (baked at intermission start). */
  roundEndsAt: number;
  phaseTimer: Timer | null;
  /** Gameplay director interval; only set while phase === 'playing'. */
  tick: ReturnType<typeof setInterval> | null;
  /** Pending delayed quip (first-elimination roast). */
  quipTimer: Timer | null;
  /** Exact params broadcast in party:round (shared with clients). */
  params: PartyRoundParams;
  /** Last announcer line, replayed to late joiners. */
  announcer: string;
  shotDamage: number;
  ttlMs: number;
  suddenDeathAt: number | null;
  suddenDeathOn: boolean;
  lastSuddenInkAt: number;
  nextPulse: number;
  roundKills: Map<string, number>;
  eliminatedOrder: string[];
  playersAtRoundStart: number;
  lastQuipAt: number;
  firstElimQuipped: boolean;
}

interface Room {
  code: string;
  hostId: string;
  started: boolean;
  /** Keyed by socket id. Insertion order == join order, which drives host migration. */
  players: Map<string, PlayerRecord>;
  mode: MatchMode | null;
  endsAt: number | null;
  targetKills: number | null;
  startedAt: number | null;
  matchEndTimer: Timer | null;
  /** Non-null between match:ended and room:reset — the room counts as "match over". */
  resetTimer: Timer | null;
  /** Live drawings, keyed by id. Insertion order == draw order (drives eviction). */
  inkObjects: Map<number, InkRecord>;
  nextInkId: number;
  escapeStages: Set<EscapeStage>;
  /** Doodle Royale director state; null outside party mode. */
  party: PartyState | null;
}

interface ShotMsg {
  origin: Vec3;
  dir: Vec3;
  hitId: string | null;
  hitPoint: Vec3 | null;
  /** Party erasure warfare target; null when absent (ignored outside party). */
  inkId: number | null;
}

/** Reads a property off an untrusted payload without ever throwing. */
function field(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return 'Player';
  // Slice before trim so multi-megabyte strings are never processed in full.
  const name = value.slice(0, 256).trim().slice(0, MAX_NAME_LENGTH).trim();
  return name.length > 0 ? name : 'Player';
}

function normalizeCode(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, 64).trim().toUpperCase();
}

function notFoundMessage(code: string): string {
  const label = code.length >= 1 && code.length <= 8 ? `Room ${code} not found.` : 'Room not found.';
  return `${label} Double-check the code and try again.`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeVec3(value: unknown): Vec3 | null {
  const x = finiteNumber(field(value, 'x'));
  const y = finiteNumber(field(value, 'y'));
  const z = finiteNumber(field(value, 'z'));
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

/**
 * Validates an untrusted player:state payload. Returns a fresh, minimal copy
 * (so oversized/extra fields are never retained) or null if malformed.
 */
function sanitizeState(payload: unknown): PlayerStateMsg | null {
  const pos = sanitizeVec3(field(payload, 'pos'));
  const yaw = finiteNumber(field(payload, 'yaw'));
  if (pos === null || yaw === null) return null;
  return { pos, yaw };
}

/** Validates an untrusted player:shoot payload; null if malformed. */
function sanitizeShot(payload: unknown): ShotMsg | null {
  const origin = sanitizeVec3(field(payload, 'origin'));
  const dir = sanitizeVec3(field(payload, 'dir'));
  if (origin === null || dir === null) return null;
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (Math.abs(len - 1) > 0.15) return null; // direction must be roughly unit-length
  const rawHitId = field(payload, 'hitId');
  const hitId = typeof rawHitId === 'string' && rawHitId.length > 0 && rawHitId.length <= 128 ? rawHitId : null;
  return {
    origin,
    dir,
    hitId,
    hitPoint: sanitizeVec3(field(payload, 'hitPoint')),
    inkId: finiteNumber(field(payload, 'inkId')),
  };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function pointSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  const dot = (p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot / len2));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t), p.z - (a.z + abz * t));
}

/** True if `hit` lies within the erasure tolerance of any of the object's stroke polylines (world space). */
function inkHitNear(object: InkObjectMsg, hit: Vec3): boolean {
  const { origin, right, up } = object;
  const world = (p: InkPoint): Vec3 => ({
    x: origin.x + right.x * p.x + up.x * p.y,
    y: origin.y + right.y * p.x + up.y * p.y,
    z: origin.z + right.z * p.x + up.z * p.y,
  });
  for (const stroke of object.strokes) {
    let prev = world(stroke[0]!);
    for (let i = 1; i < stroke.length; i++) {
      const next = world(stroke[i]!);
      if (pointSegmentDistance(hit, prev, next) <= PARTY_INK_HIT_TOLERANCE) return true;
      prev = next;
    }
  }
  return false;
}

function sanitizeMode(value: unknown): MatchMode {
  return value === 'kills' || value === 'timed' || value === 'escape' || value === 'party'
    ? value
    : 'endless';
}

const ESCAPE_STAGES: readonly EscapeStage[] = ['chasm', 'plate', 'key', 'exit'];

function sanitizeStage(value: unknown): EscapeStage | null {
  return ESCAPE_STAGES.includes(value as EscapeStage) ? (value as EscapeStage) : null;
}

function inkCap(mode: MatchMode | null): number {
  return mode === 'escape' ? INK_BUDGET_ESCAPE : INK_BUDGET_COMBAT;
}

function inkRegen(mode: MatchMode | null): number {
  return mode === 'escape' ? INK_REGEN_ESCAPE : INK_REGEN_COMBAT;
}

interface InkDrawMsg {
  origin: Vec3;
  right: Vec3;
  up: Vec3;
  strokes: InkPoint[][];
  cost: number;
}

/**
 * Validates an untrusted ink:draw payload: orthonormal-ish upright plane basis,
 * bounded anchor, capped stroke/point counts, in-bounds plane-local points and
 * a total polyline length within limits. Returns a fresh minimal copy or null.
 */
function sanitizeInkDraw(payload: unknown): InkDrawMsg | null {
  const origin = sanitizeVec3(field(payload, 'origin'));
  const right = sanitizeVec3(field(payload, 'right'));
  const up = sanitizeVec3(field(payload, 'up'));
  if (!origin || !right || !up) return null;

  if (Math.abs(origin.x) > 60 || Math.abs(origin.z) > 60 || origin.y < -1 || origin.y > 30) return null;
  if (Math.abs(Math.hypot(right.x, right.y, right.z) - 1) > 0.15) return null;
  if (Math.abs(right.y) > 0.2) return null; // plane basis X must be horizontal
  if (Math.abs(Math.hypot(up.x, up.y, up.z) - 1) > 0.15) return null;
  if (up.y < 0.9) return null; // plane basis Y must be world-up

  const rawStrokes = field(payload, 'strokes');
  if (!Array.isArray(rawStrokes) || rawStrokes.length === 0 || rawStrokes.length > INK_MAX_STROKES) {
    return null;
  }

  const maxX = INK_SKETCH_HALF_W + 0.3;
  const maxY = INK_SKETCH_HALF_H + 0.3;
  const strokes: InkPoint[][] = [];
  let cost = 0;
  for (const rawStroke of rawStrokes) {
    if (!Array.isArray(rawStroke) || rawStroke.length < 2 || rawStroke.length > INK_MAX_POINTS_PER_STROKE) {
      return null;
    }
    const stroke: InkPoint[] = [];
    for (const rawPoint of rawStroke) {
      const x = finiteNumber(field(rawPoint, 'x'));
      const y = finiteNumber(field(rawPoint, 'y'));
      if (x === null || y === null || Math.abs(x) > maxX || Math.abs(y) > maxY) return null;
      stroke.push({ x, y });
    }
    for (let i = 1; i < stroke.length; i++) {
      cost += Math.hypot(stroke[i]!.x - stroke[i - 1]!.x, stroke[i]!.y - stroke[i - 1]!.y);
    }
    strokes.push(stroke);
  }
  if (cost < INK_MIN_TOTAL_LENGTH || cost > INK_MAX_TOTAL_LENGTH) return null;

  return { origin, right, up, strokes, cost };
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly roomCodeBySocket = new Map<string, string>();

  constructor(private readonly io: GameServer) {
    setInterval(() => {
      try {
        this.broadcastStates();
      } catch (err) {
        console.error('[room] broadcast error:', err);
      }
    }, 1000 / SERVER_BROADCAST_HZ);
  }

  /** Wires all room/game events for a newly connected socket. */
  handleConnection(socket: GameSocket): void {
    console.log(`[socket] connected: ${socket.id}`);
    socket.on(
      'room:create',
      this.safe(socket, (payload: unknown) => this.handleCreate(socket, payload)),
    );
    socket.on(
      'room:join',
      this.safe(socket, (payload: unknown) => this.handleJoin(socket, payload)),
    );
    socket.on(
      'room:start',
      this.safe(socket, (payload: unknown) => this.handleStart(socket, payload)),
    );
    socket.on(
      'room:leave',
      this.safe(socket, () => this.removePlayer(socket)),
    );
    socket.on(
      'player:state',
      this.safe(socket, (payload: unknown) => this.handleState(socket, payload)),
    );
    socket.on(
      'player:shoot',
      this.safe(socket, (payload: unknown) => this.handleShoot(socket, payload)),
    );
    socket.on(
      'ink:draw',
      this.safe(socket, (payload: unknown) => this.handleInkDraw(socket, payload)),
    );
    socket.on(
      'ink:erase',
      this.safe(socket, (payload: unknown) => this.handleInkErase(socket, payload)),
    );
    socket.on(
      'escape:trigger',
      this.safe(socket, (payload: unknown) => this.handleEscapeTrigger(socket, payload)),
    );
    socket.on('disconnect', (reason) => {
      console.log(`[socket] disconnected: ${socket.id} (${reason})`);
      try {
        this.removePlayer(socket);
      } catch (err) {
        console.error(`[room] cleanup error for ${socket.id}:`, err);
      }
    });
  }

  private handleCreate(socket: GameSocket, payload: unknown): void {
    // Creating while already in a room = transparently leave the old room first.
    this.removePlayer(socket);

    const name = sanitizeName(field(payload, 'name'));
    const code = this.generateCode();
    const room: Room = {
      code,
      hostId: socket.id,
      started: false,
      players: new Map(),
      mode: null,
      endsAt: null,
      targetKills: null,
      startedAt: null,
      matchEndTimer: null,
      resetTimer: null,
      inkObjects: new Map(),
      nextInkId: 1,
      escapeStages: new Set(),
      party: null,
    };
    this.rooms.set(code, room);
    this.addPlayer(room, socket, name);

    socket.emit('room:created', { room: this.snapshot(room), selfId: socket.id });
    console.log(`[room] ${code} created by "${name}" (${socket.id})`);
  }

  private handleJoin(socket: GameSocket, payload: unknown): void {
    const name = sanitizeName(field(payload, 'name'));
    const code = normalizeCode(field(payload, 'code'));

    const room = this.rooms.get(code);
    if (!room) {
      socket.emit('room:error', { message: notFoundMessage(code) });
      return;
    }
    if (this.roomCodeBySocket.get(socket.id) === code) {
      // Duplicate join to the room we're already in — just resend the snapshot.
      socket.emit('room:joined', { room: this.snapshot(room), selfId: socket.id });
      return;
    }
    // Capacity is checked before leaving any current room, so a failed join
    // never kicks the player out of where they already are.
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('room:error', { message: `Room ${code} is full (${MAX_PLAYERS_PER_ROOM} players max).` });
      return;
    }
    // Joining while in another room = transparently leave the old room first.
    this.removePlayer(socket);

    const info = this.addPlayer(room, socket, name);
    socket.emit('room:joined', { room: this.snapshot(room), selfId: socket.id });
    socket.to(code).emit('room:player-joined', { player: info });
    if (room.started) {
      // Catch the late joiner up on match state: current scores, then a
      // player:died replay for everyone currently dead (so they get hidden),
      // every live drawing, their fresh ink budget, and any escape progress.
      socket.emit('match:score', { scores: this.scores(room) });
      for (const player of room.players.values()) {
        if (player.alive) continue;
        socket.emit('player:died', {
          targetId: player.info.id,
          killerId: player.lastKillerId ?? player.info.id,
          respawnAt: player.respawnAt ?? Date.now(),
        });
      }
      for (const record of room.inkObjects.values()) {
        socket.emit('ink:object', { object: record.object });
      }
      socket.emit('ink:budget', { ink: this.accrueInk(room, info.id) });
      if (room.party !== null) {
        // Replay the current round card, then bench the joiner for the rest of
        // the round: they arrive eliminated (0 points, no deaths charged) and
        // the stock death overlay counts down to the round end.
        socket.emit('party:round', this.partyRoundPayload(room.party));
        const joiner = room.players.get(info.id);
        if (room.party.phase === 'playing' && joiner !== undefined && joiner.alive) {
          joiner.alive = false;
          joiner.respawnAt = room.party.phaseEndsAt;
          joiner.lastKillerId = info.id;
          this.io.to(room.code).emit('player:died', {
            targetId: info.id,
            killerId: info.id,
            respawnAt: room.party.phaseEndsAt,
          });
        }
      }
      if (room.mode === 'escape' && room.escapeStages.size > 0) {
        socket.emit('escape:state', { stages: [...room.escapeStages] });
      }
    }
    console.log(
      `[room] ${code}: "${name}" joined (${room.players.size}/${MAX_PLAYERS_PER_ROOM}${room.started ? ', late join' : ''})`,
    );
  }

  private handleStart(socket: GameSocket, payload: unknown): void {
    const room = this.roomOf(socket);
    if (!room) {
      socket.emit('room:error', { message: "You're not in a room." });
      return;
    }
    if (room.hostId !== socket.id) {
      socket.emit('room:error', { message: 'Only the host can start the game.' });
      return;
    }
    if (room.started) return; // duplicate start — ignore

    const mode = sanitizeMode(field(payload, 'mode'));
    const now = Date.now();
    room.started = true;
    room.mode = mode;
    room.endsAt = mode === 'timed' ? now + MATCH_TIME : null;
    room.targetKills = mode === 'kills' ? TARGET_KILLS : null;
    room.startedAt = now;
    room.escapeStages.clear();
    this.clearInk(room);
    for (const player of room.players.values()) {
      this.resetCombat(player);
      player.ink = inkCap(mode);
      player.inkUpdatedAt = now;
    }

    if (room.endsAt !== null) {
      room.matchEndTimer = setTimeout(() => {
        try {
          this.endMatch(room, 'time');
        } catch (err) {
          console.error(`[room] ${room.code} match-end timer error:`, err);
        }
      }, MATCH_TIME);
    }

    this.io.to(room.code).emit('room:started', {
      mode,
      endsAt: room.endsAt,
      targetKills: room.targetKills,
      startedAt: now,
    });
    this.emitScores(room);
    if (mode === 'party') {
      // Round-1 budgets (at the round's cap) are emitted by the intermission
      // setup, which follows room:started + the initial match:score.
      this.initPartyState(room);
      this.beginPartyIntermission(room, 1);
    } else {
      for (const player of room.players.values()) {
        this.io.to(player.info.id).emit('ink:budget', { ink: player.ink });
      }
    }
    console.log(`[room] ${room.code} started (${room.players.size} players, mode=${mode})`);
  }

  private handleState(socket: GameSocket, payload: unknown): void {
    const room = this.roomOf(socket);
    const record = room?.players.get(socket.id);
    if (!record) return;

    const state = sanitizeState(payload);
    if (!state) return; // malformed — keep the last known good state
    record.state = state;
    record.stateAt = Date.now();
  }

  /**
   * Validates a shot claim and applies server-side damage. Every rejection is
   * silent (never crashes, never errors back) so a hacked client learns nothing.
   */
  private handleShoot(socket: GameSocket, payload: unknown): void {
    const room = this.roomOf(socket);
    if (!room || !room.started || room.resetTimer !== null) return; // no live match
    if (room.mode === 'escape') return; // co-op: no shooting at all
    const party = room.party;
    if (party !== null) {
      // Party rounds gate shooting: playing phase only, and only when the
      // round allows it (or its mid-round gun unlock has passed).
      if (party.phase !== 'playing') return;
      const { shootingEnabled, gunsUnlockAt } = party.params;
      if (!shootingEnabled && (gunsUnlockAt === null || Date.now() < gunsUnlockAt)) return;
    }
    const shooter = room.players.get(socket.id);
    if (!shooter || !shooter.alive) return;

    const shot = sanitizeShot(payload);
    if (shot === null) return;

    const now = Date.now();
    if (now - shooter.lastShotAt < FIRE_COOLDOWN_MS - COOLDOWN_SLACK_MS) return;
    shooter.lastShotAt = now;

    // Tracer replication to everyone but the shooter (they render their own shot).
    socket.to(room.code).emit('player:shot', {
      shooterId: socket.id,
      origin: shot.origin,
      dir: shot.dir,
      hitPoint: shot.hitPoint,
    });

    if (shot.hitId !== null) {
      // A bullet reports one meaningful hit: a player hit wins over inkId.
      const target = room.players.get(shot.hitId);
      // Damage sanity checks — the tracer above is already relayed either way.
      if (!target || target === shooter || !target.alive) return;
      if (shot.hitPoint === null || target.state === null) return;
      if (distance(shot.hitPoint, target.state.pos) > HIT_POS_TOLERANCE) return;
      this.applyDamage(room, shooter, target, now);
      return;
    }

    // Erasure warfare (party shooting rounds only — the gate above already
    // passed): shooting an ink object removes it and refunds part of its cost.
    if (party === null || shot.inkId === null || shot.hitPoint === null) return;
    const record = room.inkObjects.get(shot.inkId);
    if (!record || !inkHitNear(record.object, shot.hitPoint)) return;
    this.removeInk(room, shot.inkId);
    const ink = this.accrueInk(room, socket.id);
    const refund = Math.min(record.cost * PARTY_ERASE_REFUND, PARTY_ERASE_REFUND_CAP);
    shooter.ink = Math.min(this.roomInkCap(room, socket.id), ink + refund);
    socket.emit('ink:budget', { ink: shooter.ink });
    console.log(
      `[room] ${room.code}: "${shooter.info.name}" erased ink #${shot.inkId} by gunfire (+${refund.toFixed(1)}m)`,
    );
  }

  /** Effective ink cap for a player: party round override + pity boost, else mode default. */
  private roomInkCap(room: Room, playerId: string): number {
    const party = room.party;
    if (party === null) return inkCap(room.mode);
    const pity = party.params.pityId === playerId ? PARTY_PITY_CAP_MULT : 1;
    return party.params.inkCap * pity;
  }

  /** Effective ink regen for a player: party round override (0 in sudden death) + pity boost. */
  private roomInkRegen(room: Room, playerId: string): number {
    const party = room.party;
    if (party === null) return inkRegen(room.mode);
    if (party.suddenDeathOn) return 0;
    const pity = party.params.pityId === playerId ? PARTY_PITY_REGEN_MULT : 1;
    return party.params.inkRegen * pity;
  }

  /** Lazily accrue ink regen for a player and return their current budget. */
  private accrueInk(room: Room, playerId: string): number {
    const player = room.players.get(playerId);
    if (!player) return 0;
    const now = Date.now();
    const cap = this.roomInkCap(room, playerId);
    player.ink = Math.min(
      cap,
      player.ink + ((now - player.inkUpdatedAt) / 1000) * this.roomInkRegen(room, playerId),
    );
    player.inkUpdatedAt = now;
    return player.ink;
  }

  private handleInkDraw(socket: GameSocket, payload: unknown): void {
    const room = this.roomOf(socket);
    if (!room || !room.started || room.resetTimer !== null) return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    const draw = sanitizeInkDraw(payload);
    if (draw === null) return;

    const ink = this.accrueInk(room, socket.id);
    if (draw.cost > ink + 0.01) {
      // Correct the client's predicted meter and tell the player why.
      socket.emit('ink:budget', { ink });
      socket.emit('room:error', { message: 'Not enough ink — wait for it to refill or erase a drawing.' });
      return;
    }
    player.ink = ink - draw.cost;

    // Room-wide cap: evict the oldest drawing (no refund — the owner may differ).
    if (room.inkObjects.size >= MAX_INK_OBJECTS_PER_ROOM) {
      const oldest = room.inkObjects.values().next().value;
      if (oldest) this.removeInk(room, oldest.object.id);
    }

    // Party rounds can stretch the TTL (finale wreckage outlives the round).
    const ttlMs = room.party !== null ? room.party.ttlMs : INK_TTL_COMBAT_MS;
    const object: InkObjectMsg = {
      id: room.nextInkId++,
      ownerId: socket.id,
      origin: draw.origin,
      right: draw.right,
      up: draw.up,
      strokes: draw.strokes,
      expiresAt: room.mode === 'escape' ? null : Date.now() + ttlMs,
    };
    const record: InkRecord = { object, cost: draw.cost, expiryTimer: null };
    if (object.expiresAt !== null) {
      record.expiryTimer = setTimeout(() => {
        try {
          this.removeInk(room, object.id);
        } catch (err) {
          console.error(`[room] ${room.code} ink expiry error:`, err);
        }
      }, ttlMs);
    }
    room.inkObjects.set(object.id, record);

    this.io.to(room.code).emit('ink:object', { object });
    socket.emit('ink:budget', { ink: player.ink });
    console.log(
      `[room] ${room.code}: "${player.info.name}" drew ink #${object.id} (${draw.cost.toFixed(1)}m, ${room.inkObjects.size} live)`,
    );
  }

  private handleInkErase(socket: GameSocket, payload: unknown): void {
    const room = this.roomOf(socket);
    if (!room || !room.started || room.resetTimer !== null) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    const id = finiteNumber(field(payload, 'id'));
    if (id === null) return;
    const record = room.inkObjects.get(id);
    if (!record || record.object.ownerId !== socket.id) return; // own ink only

    this.removeInk(room, id);
    const ink = this.accrueInk(room, socket.id);
    player.ink = Math.min(this.roomInkCap(room, socket.id), ink + record.cost);
    socket.emit('ink:budget', { ink: player.ink });
  }

  /** Removes a drawing (erase, expiry, eviction) and notifies the room. */
  private removeInk(room: Room, id: number): void {
    const record = room.inkObjects.get(id);
    if (!record) return;
    if (record.expiryTimer !== null) clearTimeout(record.expiryTimer);
    room.inkObjects.delete(id);
    this.io.to(room.code).emit('ink:removed', { id });
  }

  private clearInk(room: Room): void {
    for (const record of room.inkObjects.values()) {
      if (record.expiryTimer !== null) clearTimeout(record.expiryTimer);
    }
    room.inkObjects.clear();
  }

  /**
   * Escape puzzle progress. Client-reported and trusted (co-op, no stakes),
   * idempotent per stage; 'exit' finishes the escape.
   */
  private handleEscapeTrigger(socket: GameSocket, payload: unknown): void {
    const room = this.roomOf(socket);
    if (!room || !room.started || room.resetTimer !== null || room.mode !== 'escape') return;
    if (!room.players.has(socket.id)) return;

    const stage = sanitizeStage(field(payload, 'stage'));
    if (stage === null || room.escapeStages.has(stage)) return;
    room.escapeStages.add(stage);
    this.io.to(room.code).emit('escape:state', { stages: [...room.escapeStages] });
    console.log(`[room] ${room.code}: escape stage "${stage}" done`);

    if (stage === 'exit') {
      this.endMatch(room, 'escape');
    }
  }

  private applyDamage(room: Room, shooter: PlayerRecord, target: PlayerRecord, now: number): void {
    const party = room.party;
    const damage = party !== null ? party.shotDamage : SHOT_DAMAGE;
    target.health = Math.max(0, target.health - damage);
    this.io.to(room.code).emit('player:damaged', {
      targetId: target.info.id,
      health: target.health,
      shooterId: shooter.info.id,
    });
    if (target.health > 0) return;

    shooter.kills += 1;
    if (party !== null && party.phase === 'playing') {
      party.roundKills.set(shooter.info.id, (party.roundKills.get(shooter.info.id) ?? 0) + 1);
      shooter.points += party.params.pointsMult; // +1 x mult per shot kill
    }
    this.killPlayer(room, target, shooter.info.id, party !== null ? null : now + RESPAWN_MS);
    console.log(
      `[room] ${room.code}: "${shooter.info.name}" splatted "${target.info.name}" (${shooter.kills}k)`,
    );

    if (room.mode === 'kills' && room.targetKills !== null && shooter.kills >= room.targetKills) {
      this.endMatch(room, 'kills');
      return; // match over — killPlayer's respawn timer was just cancelled
    }
    if (party !== null) this.maybeEndPartyRoundEarly(room);
  }

  /**
   * Shared death bookkeeping for shot kills and environmental eliminations.
   * respawnAt null = party elimination: no respawn timer is scheduled (the
   * player stays dead until the round ends) and the broadcast advertises the
   * round end so the stock death overlay counts down to it. Environmental
   * kills pass killerId === target id (clients tolerate the self-kill).
   */
  private killPlayer(room: Room, target: PlayerRecord, killerId: string, respawnAt: number | null): void {
    const party = room.party;
    target.alive = false;
    target.health = 0;
    target.deaths += 1;
    target.lastKillerId = killerId;

    if (respawnAt === null && party !== null && party.phase === 'playing') {
      party.eliminatedOrder.push(target.info.id);
      // Dying later is worth more: elimination index (0-based) x round mult.
      target.points += (party.eliminatedOrder.length - 1) * party.params.pointsMult;
      target.respawnAt = party.phaseEndsAt;
      this.io.to(room.code).emit('player:died', {
        targetId: target.info.id,
        killerId,
        respawnAt: party.phaseEndsAt,
      });
      this.emitScores(room);
      this.partyElimQuips(room, target);
      return;
    }

    const at = respawnAt ?? Date.now() + RESPAWN_MS;
    target.respawnAt = at;
    this.io.to(room.code).emit('player:died', {
      targetId: target.info.id,
      killerId,
      respawnAt: at,
    });
    this.emitScores(room);
    target.respawnTimer = setTimeout(
      () => {
        try {
          this.respawn(room, target);
        } catch (err) {
          console.error(`[room] ${room.code} respawn timer error:`, err);
        }
      },
      Math.max(0, at - Date.now()),
    );
  }

  private respawn(room: Room, target: PlayerRecord): void {
    target.respawnTimer = null;
    if (!room.started || room.resetTimer !== null) return;
    if (!room.players.has(target.info.id)) return;
    target.health = MAX_HEALTH;
    target.alive = true;
    target.respawnAt = null;
    target.lastKillerId = null;
    this.io.to(room.code).emit('player:respawned', { id: target.info.id });
  }

  private endMatch(room: Room, reason: MatchEndReason, resetDelayMs: number = RESET_DELAY): void {
    if (!room.started || room.resetTimer !== null) return; // already over
    if (room.matchEndTimer !== null) {
      clearTimeout(room.matchEndTimer);
      room.matchEndTimer = null;
    }
    this.clearPartyTimers(room);
    // Nobody respawns onto the final scoreboard; the reset revives everyone.
    for (const player of room.players.values()) this.cancelRespawn(player);
    const escapeTimeMs =
      reason === 'escape' && room.startedAt !== null ? Date.now() - room.startedAt : null;
    this.io.to(room.code).emit('match:ended', { scores: this.scores(room), reason, escapeTimeMs });
    console.log(`[room] ${room.code}: match ended (${reason})`);
    room.resetTimer = setTimeout(() => {
      try {
        this.resetRoom(room);
      } catch (err) {
        console.error(`[room] ${room.code} reset timer error:`, err);
      }
    }, resetDelayMs);
  }

  /** Returns an ended room to the lobby state so the host can start a new match. */
  private resetRoom(room: Room): void {
    room.resetTimer = null;
    room.started = false;
    room.mode = null;
    room.endsAt = null;
    room.targetKills = null;
    room.startedAt = null;
    room.escapeStages.clear();
    this.clearPartyTimers(room);
    room.party = null;
    this.clearInk(room);
    for (const player of room.players.values()) this.resetCombat(player);
    this.io.to(room.code).emit('room:reset', { room: this.snapshot(room) });
    console.log(`[room] ${room.code}: reset to lobby`);
  }

  private resetCombat(player: PlayerRecord): void {
    this.cancelRespawn(player);
    player.health = MAX_HEALTH;
    player.alive = true;
    player.kills = 0;
    player.deaths = 0;
    player.points = 0;
    player.lastShotAt = 0;
    player.respawnAt = null;
    player.lastKillerId = null;
  }

  private cancelRespawn(player: PlayerRecord): void {
    if (player.respawnTimer !== null) {
      clearTimeout(player.respawnTimer);
      player.respawnTimer = null;
    }
  }

  private scores(room: Room): ScoreEntry[] {
    // Party mode rides the stock scoreboard pipeline: the kills column carries
    // points and the deaths column carries eliminations.
    const party = room.mode === 'party';
    return Array.from(room.players.values(), (p) => ({
      id: p.info.id,
      kills: party ? p.points : p.kills,
      deaths: p.deaths,
    }));
  }

  private emitScores(room: Room): void {
    this.io.to(room.code).emit('match:score', { scores: this.scores(room) });
  }

  // =====================================================================
  // Doodle Royale director
  // =====================================================================

  /** Fresh party shell; round 1 is populated by beginPartyIntermission. */
  private initPartyState(room: Room): void {
    room.party = {
      round: 1,
      totalRounds: PARTY_ROUND_COUNT,
      schedule: buildPartySchedule(PARTY_ROUND_COUNT),
      kind: 'rising-ink',
      phase: 'intermission',
      phaseEndsAt: 0,
      roundEndsAt: 0,
      phaseTimer: null,
      tick: null,
      quipTimer: null,
      params: {
        shootingEnabled: false,
        gunsUnlockAt: null,
        inkCap: INK_BUDGET_COMBAT,
        inkRegen: INK_REGEN_COMBAT,
        pityId: null,
        lava: null,
        pulse: null,
        pointsMult: 1,
      },
      announcer: '',
      shotDamage: SHOT_DAMAGE,
      ttlMs: INK_TTL_COMBAT_MS,
      suddenDeathAt: null,
      suddenDeathOn: false,
      lastSuddenInkAt: 0,
      nextPulse: 0,
      roundKills: new Map(),
      eliminatedOrder: [],
      playersAtRoundStart: room.players.size,
      lastQuipAt: 0,
      firstElimQuipped: false,
    };
  }

  /**
   * Computes round `round`'s config. All absolute times are baked from the
   * scheduled round start (intermission end) so the intermission and playing
   * payloads carry identical params.
   */
  private setupPartyRound(room: Room, round: number, now: number): void {
    const party = room.party;
    if (!party) return;
    const kind = party.schedule[round - 1] ?? 'rising-ink';
    const finale = round === party.totalRounds;
    const finaleRising = finale && kind === 'rising-ink';
    const duration = partyRoundDuration(kind);
    const roundStartAt = now + PARTY_INTERMISSION;

    // With BOOM_PARTY_ROUND_MS, in-round offsets scale so short rounds still
    // exercise every beat (grace is pinned at 15% of the round).
    const graceMs =
      PARTY_ROUND_OVERRIDE !== null ? Math.round(duration * 0.15) : PARTY_LAVA_GRACE_MS;
    const gunsMs =
      PARTY_ROUND_OVERRIDE !== null
        ? Math.round((duration * PARTY_GUNS_UNLOCK_MS) / PARTY_FLOOR_CHECK_MS)
        : PARTY_GUNS_UNLOCK_MS;
    const suddenMs =
      PARTY_ROUND_OVERRIDE !== null
        ? Math.round((duration * PARTY_SUDDEN_DEATH_MS) / PARTY_DRAW_DUEL_MS)
        : PARTY_SUDDEN_DEATH_MS;
    const pulseTimes = PARTY_PULSE_OFFSETS_S.map(
      (s) =>
        roundStartAt +
        (PARTY_ROUND_OVERRIDE !== null
          ? Math.round((s * 1000 * duration) / PARTY_FLOOR_CHECK_MS)
          : s * 1000),
    );

    const pityId = round >= 2 ? this.pickPityId(room) : null;
    const pointsMult = finale ? PARTY_FINALE_POINTS_MULT : 1;
    let params: PartyRoundParams;
    if (kind === 'rising-ink') {
      params = {
        shootingEnabled: false,
        gunsUnlockAt: null,
        inkCap: finaleRising ? PARTY_FINALE_CAP : PARTY_RISING_INK_CAP,
        inkRegen: finaleRising ? PARTY_FINALE_REGEN : PARTY_RISING_INK_REGEN,
        pityId,
        lava: {
          startY: PARTY_LAVA_START_Y,
          riseRate: PARTY_LAVA_RISE_RATE * (finaleRising ? PARTY_FINALE_RISE_MULT : 1),
          accel: PARTY_LAVA_ACCEL,
          startAt: roundStartAt + graceMs,
        },
        pulse: null,
        pointsMult,
      };
    } else if (kind === 'draw-duel') {
      params = {
        shootingEnabled: true,
        gunsUnlockAt: null,
        inkCap: PARTY_DRAW_DUEL_CAP,
        inkRegen: PARTY_DRAW_DUEL_REGEN,
        pityId,
        lava: null,
        pulse: null,
        pointsMult,
      };
    } else {
      params = {
        shootingEnabled: false,
        gunsUnlockAt: roundStartAt + gunsMs,
        inkCap: PARTY_FLOOR_CHECK_CAP,
        inkRegen: PARTY_FLOOR_CHECK_REGEN,
        pityId,
        lava: null,
        pulse: { times: pulseTimes, warnMs: PARTY_PULSE_WARN_MS },
        pointsMult,
      };
    }

    party.round = round;
    party.kind = kind;
    party.phase = 'intermission';
    party.phaseEndsAt = roundStartAt;
    party.roundEndsAt = roundStartAt + duration;
    party.params = params;
    party.shotDamage = kind === 'draw-duel' ? PARTY_DRAW_DUEL_DAMAGE : SHOT_DAMAGE;
    party.ttlMs = finale ? PARTY_FINALE_TTL_MS : INK_TTL_COMBAT_MS;
    party.suddenDeathAt = kind === 'draw-duel' ? roundStartAt + suddenMs : null;
    party.suddenDeathOn = false;
    party.lastSuddenInkAt = 0;
    party.nextPulse = 0;
    party.roundKills.clear();
    party.eliminatedOrder = [];
    party.firstElimQuipped = false;
  }

  /** Lowest points = pity pick (join order breaks ties). Callers skip round 1. */
  private pickPityId(room: Room): string | null {
    let worst: PlayerRecord | null = null;
    for (const player of room.players.values()) {
      if (worst === null || player.points < worst.points) worst = player;
    }
    return worst?.info.id ?? null;
  }

  /** Sets up the next round, runs the between-round sweep, announces the card. */
  private beginPartyIntermission(room: Room, round: number): void {
    const party = room.party;
    if (!party || !room.started || room.resetTimer !== null) return;
    const now = Date.now();
    this.setupPartyRound(room, round, now);

    // Between-round housekeeping (harmless no-ops on round 1): sweep every
    // drawing via removeInk so clients hear ink:removed (clearInk is silent —
    // never use it mid-match), revive the dead in bulk, then reseed everyone's
    // ink at the new round's cap (same pattern as handleStart).
    for (const id of [...room.inkObjects.keys()]) this.removeInk(room, id);
    for (const player of room.players.values()) {
      if (!player.alive) this.respawn(room, player);
    }
    for (const player of room.players.values()) {
      player.ink = this.roomInkCap(room, player.info.id);
      player.inkUpdatedAt = now;
      this.io.to(player.info.id).emit('ink:budget', { ink: player.ink });
    }

    party.announcer = pick(ANNOUNCE_INTRO[party.kind]);
    this.emitPartyRound(room);
    if (round === 1) {
      this.sendQuip(
        room,
        fillQuip(pick(QUIP_MATCH_START), {
          count: String(room.players.size),
          rounds: String(party.totalRounds),
        }),
      );
    } else if (party.params.pityId !== null) {
      const pity = room.players.get(party.params.pityId);
      if (pity) this.sendQuip(room, fillQuip(pick(QUIP_PITY), { name: pity.info.name }));
    }

    party.phaseTimer = setTimeout(() => {
      try {
        this.beginPartyPlaying(room);
      } catch (err) {
        console.error(`[room] ${room.code} party intermission timer error:`, err);
      }
    }, PARTY_INTERMISSION);
    console.log(
      `[room] ${room.code}: party round ${round}/${party.totalRounds} intermission (${party.kind})`,
    );
  }

  private beginPartyPlaying(room: Room): void {
    const party = room.party;
    if (!party || party.phase !== 'intermission') return;
    if (!room.started || room.resetTimer !== null) return;
    if (party.phaseTimer !== null) {
      clearTimeout(party.phaseTimer);
      party.phaseTimer = null;
    }
    party.phase = 'playing';
    party.phaseEndsAt = party.roundEndsAt;
    let alive = 0;
    for (const player of room.players.values()) if (player.alive) alive++;
    party.playersAtRoundStart = alive;
    party.announcer = pick(ANNOUNCE_GO);
    this.emitPartyRound(room);

    party.tick = setInterval(() => {
      try {
        this.partyTick(room);
      } catch (err) {
        console.error(`[room] ${room.code} party tick error:`, err);
      }
    }, PARTY_TICK_MS);
    party.phaseTimer = setTimeout(
      () => {
        try {
          this.endPartyRound(room);
        } catch (err) {
          console.error(`[room] ${room.code} party round timer error:`, err);
        }
      },
      Math.max(0, party.roundEndsAt - Date.now()),
    );
    this.maybeEndPartyRoundEarly(room); // degenerate rosters end immediately
    console.log(
      `[room] ${room.code}: party round ${party.round} playing (${party.kind}, ${alive} alive)`,
    );
  }

  /** Gameplay director (~4.5Hz, playing phase only): lava, pulses, sudden death. */
  private partyTick(room: Room): void {
    const party = room.party;
    if (!party || party.phase !== 'playing' || !room.started || room.resetTimer !== null) return;
    const now = Date.now();

    const lava = party.params.lava;
    if (lava !== null && now >= lava.startAt) {
      const t = (now - lava.startAt) / 1000;
      const height = lava.startY + lava.riseRate * t + 0.5 * lava.accel * t * t;
      for (const player of room.players.values()) {
        if (!player.alive) continue;
        const stale = player.state === null || now - player.stateAt > PARTY_STALE_STATE_MS;
        if (stale || player.state!.pos.y < height) {
          this.killPlayer(room, player, player.info.id, null);
        }
      }
    }

    const pulse = party.params.pulse;
    if (pulse !== null) {
      while (party.nextPulse < pulse.times.length && now >= pulse.times[party.nextPulse]!) {
        party.nextPulse += 1;
        for (const player of room.players.values()) {
          if (!player.alive) continue;
          const stale = player.state === null || now - player.stateAt > PARTY_STALE_STATE_MS;
          if (stale || player.state!.pos.y < PARTY_FLOOR_SAFE_Y) {
            this.killPlayer(room, player, player.info.id, null);
          }
        }
      }
    }

    if (party.suddenDeathAt !== null && now >= party.suddenDeathAt) {
      if (!party.suddenDeathOn) {
        // Settle everyone's accrued regen at the old rate before freezing it.
        for (const id of room.players.keys()) this.accrueInk(room, id);
        party.suddenDeathOn = true;
        this.sendQuip(room, pick(QUIP_SUDDEN_DEATH));
      }
      if (room.inkObjects.size > 0 && now - party.lastSuddenInkAt >= PARTY_SUDDEN_DEATH_INK_GAP_MS) {
        party.lastSuddenInkAt = now;
        const oldest = room.inkObjects.keys().next().value;
        if (oldest !== undefined) this.removeInk(room, oldest);
      }
    }

    this.maybeEndPartyRoundEarly(room);
    if (party.phase === 'playing' && now >= party.phaseEndsAt) this.endPartyRound(room);
  }

  /** Survival rounds end at 0 alive; draw-duel at <=1. Counts live players only. */
  private maybeEndPartyRoundEarly(room: Room): void {
    const party = room.party;
    if (!party || party.phase !== 'playing') return;
    let alive = 0;
    for (const player of room.players.values()) if (player.alive) alive++;
    const threshold = party.kind === 'draw-duel' ? 1 : 0;
    if (alive <= threshold) this.endPartyRound(room);
  }

  /** Awards survivor/winner points, then rolls into the next intermission or the podium. */
  private endPartyRound(room: Room): void {
    const party = room.party;
    if (!party || party.phase !== 'playing') return;
    if (!room.started || room.resetTimer !== null) return;
    this.clearPartyTimers(room);

    const mult = party.params.pointsMult;
    const alivePlayers = [...room.players.values()].filter((p) => p.alive);
    const winner = this.pickPartyRoundWinner(room, party, alivePlayers);
    const survivorPoints = Math.max(0, party.playersAtRoundStart - 1) * mult;
    for (const player of alivePlayers) player.points += survivorPoints;
    if (winner !== null) winner.points += PARTY_WINNER_BONUS * mult;
    this.emitScores(room);
    console.log(
      `[room] ${room.code}: party round ${party.round}/${party.totalRounds} over ` +
        `(${party.kind}, winner=${winner ? winner.info.name : 'nobody'})`,
    );

    if (party.round >= party.totalRounds) this.beginPartyPodium(room);
    else this.beginPartyIntermission(room, party.round + 1);
  }

  /**
   * Last alive wins outright; a full wipe crowns the latest elimination still
   * in the room. On timeout: rising-ink -> highest altitude, draw-duel -> most
   * round kills, floor-check -> earliest join (join order breaks all ties).
   */
  private pickPartyRoundWinner(
    room: Room,
    party: PartyState,
    alivePlayers: PlayerRecord[],
  ): PlayerRecord | null {
    if (alivePlayers.length === 1) return alivePlayers[0]!;
    if (alivePlayers.length === 0) {
      for (let i = party.eliminatedOrder.length - 1; i >= 0; i--) {
        const player = room.players.get(party.eliminatedOrder[i]!);
        if (player) return player;
      }
      return null;
    }
    if (party.kind === 'rising-ink') {
      let best = alivePlayers[0]!;
      for (const player of alivePlayers) {
        const y = player.state?.pos.y ?? -Infinity;
        const bestY = best.state?.pos.y ?? -Infinity;
        if (y > bestY) best = player;
      }
      return best;
    }
    if (party.kind === 'draw-duel') {
      let best = alivePlayers[0]!;
      for (const player of alivePlayers) {
        const kills = party.roundKills.get(player.info.id) ?? 0;
        const bestKills = party.roundKills.get(best.info.id) ?? 0;
        if (kills > bestKills) best = player;
      }
      return best;
    }
    return alivePlayers[0]!; // floor-check: earliest join among survivors
  }

  /** Final card: champion announcement, then the stock endMatch with the podium delay. */
  private beginPartyPodium(room: Room): void {
    const party = room.party;
    if (!party) return;
    const now = Date.now();
    party.phase = 'podium';
    party.phaseEndsAt = now + PARTY_PODIUM;
    const champion = this.pickPartyChampion(room);
    const name = champion ? champion.info.name : 'nobody';
    party.announcer = fillQuip(pick(ANNOUNCE_PODIUM), { name });
    this.emitPartyRound(room);
    let quip = fillQuip(pick(ANNOUNCE_PODIUM), { name });
    if (quip === party.announcer) quip = fillQuip(pick(ANNOUNCE_PODIUM), { name });
    this.sendQuip(room, quip);
    this.endMatch(room, 'party', PARTY_PODIUM);
  }

  /** Max points; ties broken by real kills, then join order. */
  private pickPartyChampion(room: Room): PlayerRecord | null {
    let best: PlayerRecord | null = null;
    for (const player of room.players.values()) {
      if (
        best === null ||
        player.points > best.points ||
        (player.points === best.points && player.kills > best.kills)
      ) {
        best = player;
      }
    }
    return best;
  }

  /** First elimination gets a delayed roast (comedy beat); later ones are sampled. */
  private partyElimQuips(room: Room, target: PlayerRecord): void {
    const party = room.party;
    if (!party) return;
    const name = target.info.name;
    if (!party.firstElimQuipped) {
      party.firstElimQuipped = true;
      const round = party.round;
      party.quipTimer = setTimeout(() => {
        if (room.party === party) party.quipTimer = null;
        if (!room.started || room.resetTimer !== null) return;
        if (room.party !== party || party.phase !== 'playing' || party.round !== round) return;
        this.sendQuip(room, fillQuip(pick(QUIP_FIRST_ELIM), { name }));
      }, PARTY_FIRST_ELIM_QUIP_DELAY_MS);
      return;
    }
    if (
      Date.now() - party.lastQuipAt >= PARTY_ELIM_QUIP_GAP_MS &&
      Math.random() < PARTY_ELIM_QUIP_CHANCE
    ) {
      this.sendQuip(room, fillQuip(pick(QUIP_ELIM), { name }));
    }
  }

  private sendQuip(room: Room, text: string): void {
    this.io.to(room.code).emit('party:quip', { text });
    if (room.party) room.party.lastQuipAt = Date.now();
  }

  private partyRoundPayload(party: PartyState): {
    round: number;
    totalRounds: number;
    kind: PartyRoundKind;
    phase: PartyPhase;
    endsAt: number;
    announcer: string;
    params: PartyRoundParams;
  } {
    return {
      round: party.round,
      totalRounds: party.totalRounds,
      kind: party.kind,
      phase: party.phase,
      endsAt: party.phaseEndsAt,
      announcer: party.announcer,
      params: party.params,
    };
  }

  private emitPartyRound(room: Room): void {
    const party = room.party;
    if (!party) return;
    this.io.to(room.code).emit('party:round', this.partyRoundPayload(party));
  }

  /** Cancels every director timer. Called from endMatch, resetRoom, and destroyRoom. */
  private clearPartyTimers(room: Room): void {
    const party = room.party;
    if (!party) return;
    if (party.phaseTimer !== null) {
      clearTimeout(party.phaseTimer);
      party.phaseTimer = null;
    }
    if (party.tick !== null) {
      clearInterval(party.tick);
      party.tick = null;
    }
    if (party.quipTimer !== null) {
      clearTimeout(party.quipTimer);
      party.quipTimer = null;
    }
  }

  /** Shared leave path for room:leave, disconnect, and switching rooms. No-op if not in a room. */
  private removePlayer(socket: GameSocket): void {
    const code = this.roomCodeBySocket.get(socket.id);
    if (code === undefined) return;
    this.roomCodeBySocket.delete(socket.id);
    socket.leave(code);

    const room = this.rooms.get(code);
    if (!room) return;

    const record = room.players.get(socket.id);
    if (record) this.cancelRespawn(record);
    room.players.delete(socket.id);
    const name = record ? record.info.name : socket.id;

    if (room.players.size === 0) {
      this.destroyRoom(room);
      console.log(`[room] ${code}: "${name}" left — room deleted (empty)`);
      return;
    }

    if (room.hostId === socket.id) {
      // Earliest-joined remaining player becomes host (Map preserves insertion order).
      const nextHostId = room.players.keys().next().value;
      if (nextHostId !== undefined) {
        room.hostId = nextHostId;
        console.log(`[room] ${code}: host migrated to ${nextHostId}`);
      }
    }
    socket.to(code).emit('room:player-left', { playerId: socket.id, newHostId: room.hostId });
    // Mid-match roster changes drop the leaver's scoreboard row.
    if (room.started) this.emitScores(room);
    // A leaver can satisfy a party round's win condition — never stall the round.
    if (room.started && room.resetTimer === null && room.party?.phase === 'playing') {
      this.maybeEndPartyRoundEarly(room);
    }
    console.log(`[room] ${code}: "${name}" left (${room.players.size}/${MAX_PLAYERS_PER_ROOM})`);
  }

  /** Deletes a room and cancels every room-level timer so nothing fires afterwards. */
  private destroyRoom(room: Room): void {
    if (room.matchEndTimer !== null) {
      clearTimeout(room.matchEndTimer);
      room.matchEndTimer = null;
    }
    if (room.resetTimer !== null) {
      clearTimeout(room.resetTimer);
      room.resetTimer = null;
    }
    this.clearPartyTimers(room);
    room.party = null;
    this.clearInk(room);
    for (const player of room.players.values()) this.cancelRespawn(player);
    this.rooms.delete(room.code);
  }

  private addPlayer(room: Room, socket: GameSocket, name: string): PlayerInfo {
    const used = new Set<string>();
    for (const player of room.players.values()) used.add(player.info.color);
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];

    const info: PlayerInfo = { id: socket.id, name, color };
    room.players.set(socket.id, {
      info,
      state: null,
      stateAt: 0,
      health: MAX_HEALTH,
      alive: true,
      kills: 0,
      deaths: 0,
      points: 0,
      lastShotAt: 0,
      respawnAt: null,
      lastKillerId: null,
      respawnTimer: null,
      ink: this.roomInkCap(room, socket.id),
      inkUpdatedAt: Date.now(),
    });
    this.roomCodeBySocket.set(socket.id, room.code);
    socket.join(room.code);
    return info;
  }

  private roomOf(socket: GameSocket): Room | undefined {
    const code = this.roomCodeBySocket.get(socket.id);
    return code === undefined ? undefined : this.rooms.get(code);
  }

  private snapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      hostId: room.hostId,
      started: room.started,
      players: Array.from(room.players.values(), (player) => player.info),
      mode: room.mode,
      endsAt: room.endsAt,
      targetKills: room.targetKills,
      startedAt: room.startedAt,
    };
  }

  /** Broadcasts every started room's latest states at SERVER_BROADCAST_HZ. Dead players are skipped. */
  private broadcastStates(): void {
    for (const room of this.rooms.values()) {
      if (!room.started) continue;
      const states: PlayerStateBroadcast[] = [];
      for (const { info, state, alive } of room.players.values()) {
        if (state !== null && alive) states.push({ id: info.id, pos: state.pos, yaw: state.yaw });
      }
      if (states.length > 0) this.io.to(room.code).emit('players:state', { states });
    }
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Unable to allocate a unique room code');
  }

  /** Wraps a handler so malformed payloads or bugs can never crash the process. */
  private safe<Args extends unknown[]>(
    socket: GameSocket,
    handler: (...args: Args) => void,
  ): (...args: Args) => void {
    return (...args: Args) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[room] handler error for ${socket.id}:`, err);
        socket.emit('room:error', { message: 'Something went wrong on the server.' });
      }
    };
  }
}
