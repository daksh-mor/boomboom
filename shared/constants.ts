export const MAX_PLAYERS_PER_ROOM = 8;
export const ROOM_CODE_LENGTH = 4;
/** Unambiguous alphabet: no O/0/I/1. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SERVER_BROADCAST_HZ = 15;
export const CLIENT_SEND_HZ = 15;
export const MAX_NAME_LENGTH = 16;
export const DEFAULT_PORT = 3001;
export const PLAYER_COLORS = [
  '#ff5252',
  '#40c4ff',
  '#69f0ae',
  '#ffd740',
  '#ff6ec7',
  '#b388ff',
  '#ffab40',
  '#64ffda',
] as const;

// --- Combat (Pencil Shooter) ---
export const MAX_HEALTH = 100;
export const SHOT_DAMAGE = 20;
export const MAG_SIZE = 8;
export const RELOAD_MS = 1200;
export const FIRE_COOLDOWN_MS = 250;
export const RESPAWN_MS = 3000;
/** Kills needed to win 'kills' mode. */
export const TARGET_KILLS = 10;
/** Timed-mode match length (5:00). */
export const MATCH_TIME_MS = 300_000;
/** Max distance (meters) between a claimed hitPoint and the target's last known position. */
export const HIT_POS_TOLERANCE = 3;

// --- Magic Ink (drawings become real) ---
/** Ink budget in meters of stroke length. */
export const INK_BUDGET_ESCAPE = 30;
export const INK_BUDGET_COMBAT = 12;
/** Ink regeneration, meters of stroke per second. */
export const INK_REGEN_ESCAPE = 0.6;
export const INK_REGEN_COMBAT = 1.0;
/** Caps applied to a single ink:draw payload. */
export const INK_MAX_STROKES = 6;
export const INK_MAX_POINTS_PER_STROKE = 64;
export const INK_MIN_TOTAL_LENGTH = 0.25;
export const INK_MAX_TOTAL_LENGTH = 32;
/** Sketch plane half-extents (meters); the server validates with a small margin. */
export const INK_SKETCH_HALF_W = 3.2;
export const INK_SKETCH_HALF_H = 2.2;
/** Rendered ink tube diameter (m); colliders are this tall. */
export const INK_THICKNESS = 0.35;
/** Collider padding perpendicular to the stroke (m). */
export const INK_DEPTH = 0.7;
/** Drawn objects despawn after this long in combat modes (permanent in escape). */
export const INK_TTL_COMBAT_MS = 30_000;
/** Per-room cap; the oldest object is evicted when exceeded. */
export const MAX_INK_OBJECTS_PER_ROOM = 40;

// --- Doodle Royale (party mode) ---
export const PARTY_ROUNDS = 5;
export const PARTY_INTERMISSION_MS = 8000;
export const PARTY_PODIUM_MS = 14_000;
/** Last-place pity boost, applied to the round's ink cap / regen. */
export const PARTY_PITY_CAP_MULT = 1.3;
export const PARTY_PITY_REGEN_MULT = 1.5;
/** Erasure warfare: fraction of the object's cost refunded to the shooter. */
export const PARTY_ERASE_REFUND = 0.5;
/** Max meters refunded per erased object. */
export const PARTY_ERASE_REFUND_CAP = 4;
/** Bonus points for the round winner (x pointsMult). */
export const PARTY_WINNER_BONUS = 2;
/** Finale (last round) points multiplier. */
export const PARTY_FINALE_POINTS_MULT = 2;

// Round 'rising-ink': survive the rising tide; higher = better.
export const PARTY_RISING_INK_MS = 85_000;
/** Grace before the tide starts rising (from round start). */
export const PARTY_LAVA_GRACE_MS = 10_000;
export const PARTY_LAVA_START_Y = 0;
/** Meters per second (plus 0.5*accel*t^2 acceleration). */
export const PARTY_LAVA_RISE_RATE = 0.12;
export const PARTY_LAVA_ACCEL = 0.002;
export const PARTY_RISING_INK_CAP = 22;
export const PARTY_RISING_INK_REGEN = 0.9;

// Round 'draw-duel': one-hit kills, scarce ink, sudden death drains the arena.
export const PARTY_DRAW_DUEL_MS = 75_000;
/** Sudden death offset from round start: regen stops, ink objects decay. */
export const PARTY_SUDDEN_DEATH_MS = 60_000;
export const PARTY_DRAW_DUEL_DAMAGE = 100;
export const PARTY_DRAW_DUEL_CAP = 8;
export const PARTY_DRAW_DUEL_REGEN = 0.4;

// Round 'floor-check': periodic pulses eliminate anyone on the bare floor.
export const PARTY_FLOOR_CHECK_MS = 70_000;
/** Pulse offsets from round start, in seconds. */
export const PARTY_PULSE_OFFSETS_S = [15, 26, 35, 43, 50, 56, 61, 65] as const;
/** Klaxon warning lead time before each pulse. */
export const PARTY_PULSE_WARN_MS = 3000;
/** Feet below this height at a pulse = eliminated (crates/platforms/ink are safe). */
export const PARTY_FLOOR_SAFE_Y = 0.5;
/** Guns unlock offset from round start (floor-check only). */
export const PARTY_GUNS_UNLOCK_MS = 30_000;
export const PARTY_FLOOR_CHECK_CAP = 10;
export const PARTY_FLOOR_CHECK_REGEN = 0.5;

// Finale remix (round 5 rising-ink): faster tide, generous ink, lasting wreckage.
export const PARTY_FINALE_RISE_MULT = 1.25;
export const PARTY_FINALE_CAP = 30;
export const PARTY_FINALE_REGEN = 1.2;
export const PARTY_FINALE_TTL_MS = 60_000;
