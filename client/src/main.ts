import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import './style.css';

import { MAX_HEALTH } from '../../shared/constants';
import type {
  EscapeStage,
  PartyRoundKind,
  PlayerInfo,
  RoomSnapshot,
  ScoreEntry,
} from '../../shared/types';
import { Game } from './game/Game';
import * as net from './net/socket';
import { createHud, type HudScreen, type ScoreRow } from './ui/hud';
import { createLanding, type LandingScreen } from './ui/landing';
import { createLobby, type LobbyScreen } from './ui/lobby';
import {
  createMobileExperience,
  onMobileExperienceChange,
} from './ui/mobileExperience';
import { showToast } from './ui/toast';

const IS_COARSE = window.matchMedia('(pointer: coarse)').matches;
const FALLBACK_COLOR = '#8294a8';
const mobile = createMobileExperience();

const uiRoot = document.getElementById('ui-root')!;
const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

type Screen = 'landing' | 'lobby' | 'game';

let screen: Screen = 'landing';
let room: RoomSnapshot | null = null;
let selfId = '';
let game: Game | null = null;
let landing: LandingScreen | null = null;
let lobby: LobbyScreen | null = null;
let hud: HudScreen | null = null;
let rotateOverlay: HTMLElement | null = null;

let latestScores: ScoreEntry[] = [];
let lastFps: number | null = null;
let lastRtt: number | null = null;
/** After a late join the server replays player:died for hiding, not for the feed. */
let suppressKillFeedUntil = 0;
/** Party podium state: match:ended (reason 'party') refreshes the pinned board. */
let podiumShown = false;
let podiumAnnouncer = '';

// ---------------------------------------------------------------- helpers

function playerOf(id: string): PlayerInfo | undefined {
  return room?.players.find((p) => p.id === id);
}

function nameOf(id: string): string {
  return playerOf(id)?.name ?? 'PLAYER';
}

function colorOf(id: string): string {
  return playerOf(id)?.color ?? FALLBACK_COLOR;
}

/** Party round display names + in-round objectives, by round kind. */
const PARTY_KIND_NAMES: Record<PartyRoundKind, string> = {
  'rising-ink': 'RISING INK',
  'draw-duel': 'DRAW DUEL',
  'floor-check': 'FLOOR CHECK',
};
const PARTY_OBJECTIVES: Record<PartyRoundKind, string> = {
  'rising-ink': 'STAY ABOVE THE INK',
  'draw-duel': 'LAST ARTIST STANDING',
  'floor-check': 'OFF THE FLOOR AT THE KLAXON',
};

/** Escape objectives, shown in fixed order as stages complete. */
const ESCAPE_OBJECTIVES: ReadonlyArray<{ stage: EscapeStage; text: string }> = [
  { stage: 'chasm', text: 'CROSS THE CHASM — DRAW A PATH' },
  { stage: 'plate', text: 'WEIGH THE HIGH PLATE — INK OR A BODY' },
  { stage: 'key', text: 'DRAW THE KEY AT THE DOOR' },
  { stage: 'exit', text: 'GO! THROUGH THE DOOR!' },
];

function escapeObjective(stages: ReadonlySet<EscapeStage>): string | null {
  for (const { stage, text } of ESCAPE_OBJECTIVES) {
    if (!stages.has(stage)) return text;
  }
  return null;
}

/** Join the latest scores with roster names/colors, sorted for the scoreboard. */
function buildScoreRows(): ScoreRow[] {
  return latestScores
    .map((s) => ({
      id: s.id,
      name: nameOf(s.id),
      color: colorOf(s.id),
      kills: s.kills,
      deaths: s.deaths,
      isSelf: s.id === selfId,
    }))
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
}

function updateHudScores(): void {
  hud?.setScores(buildScoreRows());
}

/** Pin (or refresh) the party podium board with the freshest standings. */
function showPodiumBoard(): void {
  if (!hud) return;
  const rows = buildScoreRows();
  hud.showPodium(rows, rows[0]?.name ?? 'NOBODY', podiumAnnouncer);
}

// ---------------------------------------------------------------- screens

function clearScreens(): void {
  hud?.dispose();
  landing = null;
  lobby = null;
  hud = null;
  uiRoot.replaceChildren();
}

function updateRotateOverlay(): void {
  if (!IS_COARSE) return;
  if (mobile.shouldShowRotateOverlay()) {
    if (!rotateOverlay) {
      rotateOverlay = mobile.createRotateOverlay(() => {
        rotateOverlay = null;
      });
      document.body.appendChild(rotateOverlay);
    }
  } else if (rotateOverlay) {
    rotateOverlay.remove();
    rotateOverlay = null;
  }
}

function showLanding(): void {
  disposeGame();
  screen = 'landing';
  room = null;
  latestScores = [];
  clearScreens();
  landing = createLanding({
    onCreate: (name) => net.createRoom(name),
    onJoin: (code, name) => net.joinRoom(code, name),
  });
  uiRoot.replaceChildren(landing.el);
  updateRotateOverlay();
}

function showLobby(): void {
  if (!room) return;
  disposeGame();
  screen = 'lobby';
  latestScores = [];
  clearScreens();
  lobby = createLobby({
    onStart: (mode) => net.startRoom(mode),
    onLeave: leaveToLanding,
  });
  lobby.update(room, selfId);
  uiRoot.replaceChildren(lobby.el);
  updateRotateOverlay();
}

function enterGame(): void {
  if (!room || game) return;
  screen = 'game';
  clearScreens();
  if (rotateOverlay) {
    rotateOverlay.remove();
    rotateOverlay = null;
  }

  const mode = room.mode ?? 'endless';
  lastFps = null;
  podiumShown = false;
  podiumAnnouncer = '';
  hud = createHud({
    onLeave: leaveToLanding,
    onSaveArt: () => {
      const dataUrl = game?.captureScreenshot();
      if (!dataUrl) return;
      const anchor = document.createElement('a');
      anchor.href = dataUrl;
      anchor.download = 'boomboom-masterpiece.png';
      anchor.click();
    },
  });
  hud.setRoomInfo(room.code, room.players.length);
  hud.setMatchInfo(room.mode, room.endsAt, room.targetKills, room.startedAt);
  hud.setPerf(lastFps, lastRtt);
  if (mode === 'escape') {
    hud.el.classList.add('hud-escape');
    hud.setObjective(escapeObjective(new Set()));
  }
  if (mode === 'party') hud.el.classList.add('hud-party');
  uiRoot.replaceChildren(hud.el);
  document.body.classList.add('in-game');

  game = new Game({
    canvas,
    selfId,
    players: room.players,
    mode,
    isCoarse: IS_COARSE,
    touchLayer: hud.touchLayer,
    sketchLayer: hud.sketchLayer,
    colorOf,
    onPointerLockChange: (locked) => hud?.setLockHintVisible(!locked && !IS_COARSE),
    onFps: (fps) => {
      lastFps = fps;
      hud?.setPerf(fps, lastRtt);
    },
    onAmmoChange: (mag, reloading, progress) => hud?.setAmmo(mag, reloading, progress),
    onInk: (ink, cap) => hud?.setInk(ink, cap),
    onToast: showToast,
    onKlaxon: (seconds) => hud?.flashKlaxon(seconds),
  });
  game.start();
}

function disposeGame(): void {
  game?.dispose();
  game = null;
  document.body.classList.remove('in-game');
}

function leaveToLanding(): void {
  net.leaveRoom();
  showLanding();
}

// ---------------------------------------------------------------- socket wiring

net.socket.on('room:created', ({ room: snapshot, selfId: id }) => {
  room = snapshot;
  selfId = id;
  showLobby();
});

net.socket.on('room:joined', ({ room: snapshot, selfId: id }) => {
  room = snapshot;
  selfId = id;
  // Late join into a running match: the game must exist synchronously here —
  // the server immediately replays match:score and player:died events.
  if (snapshot.started) {
    suppressKillFeedUntil = performance.now() + 1500;
    enterGame();
  } else {
    showLobby();
  }
});

net.socket.on('room:player-joined', ({ player }) => {
  if (!room || player.id === selfId) return;
  if (!room.players.some((p: PlayerInfo) => p.id === player.id)) {
    room.players.push(player);
  }
  lobby?.update(room, selfId);
  game?.addPlayer(player);
  hud?.setRoomInfo(room.code, room.players.length);
  // Mid-match joins don't trigger a room-wide match:score — add the 0/0 row.
  if (room.started && !latestScores.some((s) => s.id === player.id)) {
    latestScores.push({ id: player.id, kills: 0, deaths: 0 });
    updateHudScores();
  }
});

net.socket.on('room:player-left', ({ playerId, newHostId }) => {
  if (!room) return;
  room.players = room.players.filter((p: PlayerInfo) => p.id !== playerId);
  room.hostId = newHostId || room.hostId;
  lobby?.update(room, selfId);
  game?.removePlayer(playerId);
  hud?.setRoomInfo(room.code, room.players.length);
  if (latestScores.some((s) => s.id === playerId)) {
    latestScores = latestScores.filter((s) => s.id !== playerId);
    updateHudScores();
  }
});

net.socket.on('room:started', ({ mode, endsAt, targetKills, startedAt }) => {
  if (room) {
    room.started = true;
    room.mode = mode;
    room.endsAt = endsAt;
    room.targetKills = targetKills;
    room.startedAt = startedAt;
  }
  if (screen === 'lobby') enterGame();
});

net.socket.on('players:state', ({ states }) => {
  game?.onPlayersState(states);
});

net.socket.on('player:shot', ({ origin, dir, hitPoint }) => {
  game?.onRemoteShot(origin, dir, hitPoint);
});

net.socket.on('player:damaged', ({ targetId, health, shooterId }) => {
  if (targetId === selfId) {
    hud?.setHealth(health);
    hud?.flashDamage();
  } else {
    game?.remotePlayerDamaged(targetId);
  }
  // Own confirmed hit (the shooter never receives their own player:shot).
  if (shooterId === selfId) hud?.flashHitMarker();
});

net.socket.on('player:died', ({ targetId, killerId, respawnAt }) => {
  // Environmental deaths (killerId === targetId, party hazards) skip the
  // "X ✏ X" feed line — The Critic's quips carry the comedy instead.
  const environmental = killerId === targetId;
  if (performance.now() >= suppressKillFeedUntil && !environmental) {
    hud?.addKill(nameOf(killerId), colorOf(killerId), nameOf(targetId), colorOf(targetId));
  }
  if (targetId === selfId) {
    game?.setSelfDead(true);
    // Party deaths are round eliminations: spectate until the round ends.
    if (room?.mode === 'party') {
      hud?.showEliminated(respawnAt);
    } else {
      hud?.showDeathOverlay(nameOf(killerId), respawnAt);
    }
  } else {
    game?.remotePlayerDied(targetId);
  }
});

net.socket.on('player:respawned', ({ id }) => {
  if (id === selfId) {
    game?.setSelfDead(false);
    hud?.hideDeathOverlay();
    hud?.setHealth(MAX_HEALTH);
  } else {
    game?.remotePlayerRespawned(id);
  }
});

net.socket.on('match:score', ({ scores }) => {
  latestScores = [...scores];
  updateHudScores();
});

net.socket.on('match:ended', ({ scores, reason, escapeTimeMs }) => {
  latestScores = [...scores];
  updateHudScores();
  game?.setMatchOver();
  hud?.hideDeathOverlay();
  hud?.setObjective(null);
  hud?.showMatchEnd(reason, escapeTimeMs);
  if (reason === 'party') {
    hud?.setRoundTimer(null);
    // Final scores are in — refresh the champion title if the podium card
    // (party:round phase 'podium') already pinned the board.
    if (podiumShown) showPodiumBoard();
  }
});

// ---------------------------------------------------------------- party mode

net.socket.on('party:round', (payload) => {
  game?.applyPartyRound(payload);
  if (!hud) return;
  if (payload.phase === 'intermission') {
    hud.setRoundTimer(null);
    hud.setObjective(null);
    hud.hideDeathOverlay(); // round is over — spectators get the card, not the vignette
    hud.showRoundCard(
      `ROUND ${payload.round}/${payload.totalRounds} — ${PARTY_KIND_NAMES[payload.kind]}`,
      'STARTS IN',
      payload.endsAt,
      payload.announcer,
    );
  } else if (payload.phase === 'playing') {
    hud.hideRoundCard();
    hud.setRoundTimer(payload.endsAt);
    hud.setObjective(PARTY_OBJECTIVES[payload.kind]);
    if (payload.announcer) hud.addQuip(payload.announcer);
  } else {
    // Podium: cinematic orbit behind the pinned final board.
    podiumShown = true;
    podiumAnnouncer = payload.announcer;
    hud.setRoundTimer(null);
    hud.setObjective(null);
    hud.hideDeathOverlay();
    game?.startPodiumOrbit();
    showPodiumBoard();
  }
});

net.socket.on('party:quip', ({ text }) => {
  hud?.addQuip(text);
});

// ---------------------------------------------------------------- magic ink

net.socket.on('ink:object', ({ object }) => {
  game?.onInkObject(object);
});

net.socket.on('ink:removed', ({ id }) => {
  game?.onInkRemoved(id);
});

net.socket.on('ink:budget', ({ ink }) => {
  game?.onInkBudget(ink);
});

net.socket.on('escape:state', ({ stages }) => {
  game?.onEscapeState(stages);
  hud?.setObjective(escapeObjective(new Set(stages)));
});

net.socket.on('room:reset', ({ room: snapshot }) => {
  room = snapshot;
  latestScores = [];
  if (screen === 'game') showLobby();
  else if (screen === 'lobby') lobby?.update(snapshot, selfId);
});

net.socket.on('room:error', ({ message }) => {
  showToast(message);
  landing?.setPending(false);
});

function handleConnectionLoss(): void {
  if (screen === 'landing') return;
  showLanding();
  showToast('Connection lost');
}

net.socket.on('disconnect', handleConnectionLoss);
net.socket.on('connect_error', handleConnectionLoss);

net.startPingLoop((rtt) => {
  lastRtt = rtt;
  hud?.setPerf(lastFps, rtt);
});

mobile.init();
onMobileExperienceChange(mobile, updateRotateOverlay);
showLanding();
