import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  EscapeStage,
  InkPoint,
  MatchMode,
  PlayerStateMsg,
  ServerToClientEvents,
  Vec3,
} from '../../../shared/types';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Same-origin connection: Vite proxies /socket.io to the game server in dev,
 * and the server serves the built client in production.
 */
export const socket: GameSocket = io();

export function createRoom(name: string): void {
  socket.emit('room:create', { name });
}

export function joinRoom(code: string, name: string): void {
  socket.emit('room:join', { code, name });
}

export function startRoom(mode: MatchMode): void {
  socket.emit('room:start', { mode });
}

export function leaveRoom(): void {
  // Never buffer a leave: replaying it after a reconnect could kick the
  // player out of a room they just created/joined.
  if (socket.connected) socket.emit('room:leave');
}

export function sendPlayerState(state: PlayerStateMsg): void {
  // Volatile: stale positions must be dropped, not queued, while disconnected.
  socket.volatile.emit('player:state', state);
}

export function sendShoot(
  origin: Vec3,
  dir: Vec3,
  hitId: string | null,
  hitPoint: Vec3 | null,
  /** Party bullet-eraser: the ink object this shot's nearest impact hit. */
  inkId: number | null = null,
): void {
  socket.emit('player:shoot', { origin, dir, hitId, hitPoint, inkId });
}

export function sendInkDraw(origin: Vec3, right: Vec3, up: Vec3, strokes: InkPoint[][]): void {
  socket.emit('ink:draw', { origin, right, up, strokes });
}

export function sendInkErase(id: number): void {
  socket.emit('ink:erase', { id });
}

export function sendEscapeTrigger(stage: EscapeStage): void {
  socket.emit('escape:trigger', { stage });
}

const PING_INTERVAL_MS = 2000;

/**
 * Measures round-trip time every 2s while connected: emits `net:ping` with a
 * performance.now() timestamp and computes RTT when the server echoes it back
 * on `net:pong`. Returns a stop function.
 */
export function startPingLoop(onRtt: (rttMs: number) => void): () => void {
  const handlePong = (t: number): void => {
    if (typeof t !== 'number' || !Number.isFinite(t)) return;
    onRtt(Math.max(0, Math.round(performance.now() - t)));
  };
  socket.on('net:pong', handlePong);

  const tick = (): void => {
    // Volatile: a stale ping queued while disconnected would report a bogus RTT.
    if (socket.connected) socket.volatile.emit('net:ping', performance.now());
  };
  tick();
  const timer = window.setInterval(tick, PING_INTERVAL_MS);

  return () => {
    window.clearInterval(timer);
    socket.off('net:pong', handlePong);
  };
}
