export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Static identity of a player in a room. */
export interface PlayerInfo {
  id: string; // socket id
  name: string;
  color: string; // hex color assigned by server, e.g. "#ff5252"
}

/** Movement state a client reports for itself. */
export interface PlayerStateMsg {
  pos: Vec3;
  yaw: number; // radians, rotation around world Y axis
}

/** A player's state as relayed by the server. */
export interface PlayerStateBroadcast extends PlayerStateMsg {
  id: string;
}

export type MatchMode = 'endless' | 'kills' | 'timed' | 'escape' | 'party';

/** One row of the match scoreboard. */
export interface ScoreEntry {
  id: string;
  kills: number;
  deaths: number;
}

export interface RoomSnapshot {
  code: string;
  hostId: string;
  started: boolean;
  players: PlayerInfo[];
  /** null while in the lobby (no match running). */
  mode: MatchMode | null;
  /** Epoch ms when a timed match ends; null unless mode is 'timed'. */
  endsAt: number | null;
  /** Kills needed to win; null unless mode is 'kills'. */
  targetKills: number | null;
  /** Epoch ms when the current match started; null in the lobby. */
  startedAt: number | null;
}

/** A 2D point in sketch-plane space (meters; x along `right`, y along `up`). */
export interface InkPoint {
  x: number;
  y: number;
}

/**
 * A materialized ink drawing, broadcast by the server. Every client builds the
 * identical mesh + colliders from this data: world point = origin + right*p.x + up*p.y.
 */
export interface InkObjectMsg {
  id: number;
  ownerId: string;
  origin: Vec3;
  /** Unit, horizontal plane basis X. */
  right: Vec3;
  /** Unit, world-up plane basis Y. */
  up: Vec3;
  strokes: InkPoint[][];
  /** Epoch ms when the object despawns (combat modes); null = permanent. */
  expiresAt: number | null;
}

/** Escape-room puzzle stages, reported by clients and recorded idempotently. */
export type EscapeStage = 'chasm' | 'plate' | 'key' | 'exit';

export type MatchEndReason = 'kills' | 'time' | 'escape' | 'party';

// --- Doodle Royale (party mode) ---

export type PartyRoundKind = 'rising-ink' | 'draw-duel' | 'floor-check';

export interface PartyRoundParams {
  shootingEnabled: boolean;
  /** Epoch ms when guns unlock mid-round; null = fixed for the round. */
  gunsUnlockAt: number | null;
  inkCap: number;
  inkRegen: number;
  /** Player receiving the pity boost (x1.3 cap, x1.5 regen); null = none. */
  pityId: string | null;
  /** Rising ink tide; null = none. height(now) = startY + riseRate*t + 0.5*accel*t^2, t = max(0,(now-startAt)/1000) seconds. */
  lava: { startY: number; riseRate: number; accel: number; startAt: number } | null;
  /** Floor-check pulses: epoch ms of each pulse; clients show a klaxon warnMs before each. */
  pulse: { times: number[]; warnMs: number } | null;
  /** Round points multiplier (finale = 2). */
  pointsMult: number;
}

export interface ClientToServerEvents {
  'room:create': (payload: { name: string }) => void;
  'room:join': (payload: { code: string; name: string }) => void;
  /** Payload is optional for backwards compatibility; the server defaults to 'endless'. */
  'room:start': (payload?: { mode: MatchMode }) => void;
  'room:leave': () => void;
  'player:state': (payload: PlayerStateMsg) => void;
  'player:shoot': (payload: {
    origin: Vec3;
    dir: Vec3;
    hitId: string | null;
    hitPoint: Vec3 | null;
    /** Nearest ink object the bullet hit (party erasure warfare); absent/null = no ink hit. */
    inkId?: number | null;
  }) => void;
  'ink:draw': (payload: { origin: Vec3; right: Vec3; up: Vec3; strokes: InkPoint[][] }) => void;
  'ink:erase': (payload: { id: number }) => void;
  'escape:trigger': (payload: { stage: EscapeStage }) => void;
  'net:ping': (t: number) => void;
}

export interface ServerToClientEvents {
  'room:created': (payload: { room: RoomSnapshot; selfId: string }) => void;
  'room:joined': (payload: { room: RoomSnapshot; selfId: string }) => void;
  'room:player-joined': (payload: { player: PlayerInfo }) => void;
  'room:player-left': (payload: { playerId: string; newHostId: string }) => void;
  'room:started': (payload: {
    mode: MatchMode;
    endsAt: number | null;
    targetKills: number | null;
    startedAt: number;
  }) => void;
  'players:state': (payload: { states: PlayerStateBroadcast[] }) => void;
  'room:error': (payload: { message: string }) => void;
  'player:shot': (payload: { shooterId: string; origin: Vec3; dir: Vec3; hitPoint: Vec3 | null }) => void;
  'player:damaged': (payload: { targetId: string; health: number; shooterId: string }) => void;
  'player:died': (payload: { targetId: string; killerId: string; respawnAt: number }) => void;
  'player:respawned': (payload: { id: string }) => void;
  'match:score': (payload: { scores: ScoreEntry[] }) => void;
  'match:ended': (payload: {
    scores: ScoreEntry[];
    reason: MatchEndReason;
    /** Escape completion time; null unless reason is 'escape'. */
    escapeTimeMs: number | null;
  }) => void;
  'room:reset': (payload: { room: RoomSnapshot }) => void;
  'ink:object': (payload: { object: InkObjectMsg }) => void;
  'ink:removed': (payload: { id: number }) => void;
  /** Authoritative remaining ink (meters of stroke) for the receiving player. */
  'ink:budget': (payload: { ink: number }) => void;
  /** Completed escape stages (cumulative, any order). */
  'escape:state': (payload: { stages: EscapeStage[] }) => void;
  /** Party-mode round/phase change (Doodle Royale director + announcer). */
  'party:round': (payload: {
    round: number;
    totalRounds: number;
    kind: PartyRoundKind;
    phase: 'intermission' | 'playing' | 'podium';
    endsAt: number;
    announcer: string;
    params: PartyRoundParams;
  }) => void;
  /** One-liner from The Critic (party-mode announcer). */
  'party:quip': (payload: { text: string }) => void;
  'net:pong': (t: number) => void;
}
