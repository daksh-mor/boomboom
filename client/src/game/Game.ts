import * as THREE from 'three';
import {
  CLIENT_SEND_HZ,
  INK_BUDGET_COMBAT,
  INK_BUDGET_ESCAPE,
  INK_REGEN_COMBAT,
  INK_REGEN_ESCAPE,
  PARTY_PITY_CAP_MULT,
  PARTY_PITY_REGEN_MULT,
} from '../../../shared/constants';
import type {
  EscapeStage,
  InkObjectMsg,
  InkPoint,
  MatchMode,
  PartyRoundKind,
  PartyRoundParams,
  PlayerInfo,
  PlayerStateBroadcast,
  Vec3,
} from '../../../shared/types';
import {
  sendEscapeTrigger,
  sendInkDraw,
  sendInkErase,
  sendPlayerState,
  sendShoot,
} from '../net/socket';
import { BlobShadows, type BlobShadowHandle } from './BlobShadow';
import { createInputState } from './controls/InputState';
import { KeyboardMouse } from './controls/KeyboardMouse';
import { TouchControls } from './controls/TouchControls';
import { EscapeWorld } from './EscapeWorld';
import { InkObjects } from './ink/InkObjects';
import { isKey } from './ink/recognizer';
import { SketchControl } from './ink/SketchControl';
import { MovementEffects } from './MovementEffects';
import { EYE_HEIGHT, PlayerController } from './PlayerController';
import { RemotePlayers } from './RemotePlayers';
import { Weapon } from './Weapon';
import { World } from './World';

const PHYSICS_STEP = 1 / 60;
const MAX_FRAME_DELTA = 0.1; // clamp huge deltas (tab was backgrounded)
const SEND_INTERVAL_MS = 1000 / CLIENT_SEND_HZ;
const FPS_WINDOW_MS = 500; // rolling FPS average, reported ~2x/s

const MOUSE_LOOK_SENS = 0.002; // rad per px
const TOUCH_LOOK_SENS = 0.004;

const ERASE_RANGE = 7; // m
const ERASE_HOLD_S = 0.45; // aim at your own ink this long to erase it
const ESCAPE_SENSOR_INTERVAL_MS = 150;

// --- party mode
const PODIUM_ORBIT_RADIUS = 26; // m
const PODIUM_ORBIT_HEIGHT = 15; // m
const PODIUM_ORBIT_PERIOD_S = 20; // one revolution
/** Fog warms up as the rising ink climbs past ~1m (cheap drama). */
const FOG_WARM_COLOR = new THREE.Color(0xff8a5c);

// Module-level scratch.
const _box = new THREE.Box3();
const _gold = new THREE.Color(0xffd75e);

export type PartyPhase = 'intermission' | 'playing' | 'podium';

/** `party:round` payload, per the pinned party protocol. */
export interface PartyRoundMsg {
  round: number;
  totalRounds: number;
  kind: PartyRoundKind;
  phase: PartyPhase;
  endsAt: number;
  announcer: string;
  params: PartyRoundParams;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  selfId: string;
  /** Full room roster (self included — it is filtered out for remotes). */
  players: readonly PlayerInfo[];
  mode: MatchMode;
  /** Coarse-pointer device: touch controls, lower pixel ratio, no MSAA at high DPR. */
  isCoarse: boolean;
  /** HUD layer the touch controls mount into. */
  touchLayer: HTMLElement;
  /** HUD layer the sketch-mode overlay mounts into. */
  sketchLayer: HTMLElement;
  /** Roster color lookup for rendering ink in its owner's color. */
  colorOf(id: string): string;
  onPointerLockChange(locked: boolean): void;
  /** Rolling-average FPS, reported ~2x per second. */
  onFps(fps: number): void;
  /** Ammo/reload state for the HUD. progress is 0..1 while reloading, else 0. */
  onAmmoChange(mag: number, reloading: boolean, progress: number): void;
  /** Predicted ink meter for the HUD (server corrections snap it). */
  onInk(ink: number, cap: number): void;
  onToast(message: string): void;
  /** Party floor-check warning; fired once per displayed second (3, 2, 1). */
  onKlaxon(secondsLeft: number): void;
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: World | EscapeWorld;
  private readonly controller: PlayerController;
  private readonly remotePlayers: RemotePlayers;
  private readonly movementEffects: MovementEffects;
  private readonly blobShadows: BlobShadows;
  private readonly localShadow: BlobShadowHandle;
  private readonly weapon: Weapon;
  private readonly inkObjects: InkObjects;
  private readonly sketch: SketchControl;
  private readonly input = createInputState();
  private readonly keyboardMouse: KeyboardMouse;
  private readonly touchControls: TouchControls | null = null;

  private rafId = 0;
  private running = false;
  private lastFrameMs = 0;
  private accumulator = 0;
  private lastSendMs = 0;
  private fpsWindowStart = 0;
  private fpsFrames = 0;
  private selfDead = false;
  private matchOver = false;
  private readonly eyeScratch = new THREE.Vector3();

  // --- ink budget (client prediction; ink:budget snaps it)
  private inkCap: number;
  private inkRegen: number;
  private ink: number;
  private lastReportedInk = -1;

  // --- eraser
  private eraseTargetId: number | null = null;
  private eraseProgress = 0;

  // --- party mode
  private partyPhase: PartyPhase | null = null;
  private partyShootingEnabled = false;
  private partyGunsUnlockAt: number | null = null;
  /** Guns usable right now (round allows it, or its mid-round unlock passed). */
  private partyGunsLive = false;
  private partyPulse: { times: number[]; warnMs: number } | null = null;
  private lastKlaxonSeconds = -1;
  private podiumOrbit = false;
  private podiumStartMs = 0;

  // --- escape mode
  private readonly escapeStages = new Set<EscapeStage>();
  private readonly sentStages = new Set<EscapeStage>();
  private lastSensorCheckMs = 0;

  constructor(private readonly opts: GameOptions) {
    // High-DPR phones render at (near-)native resolution — MSAA is wasted there.
    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: !(opts.isCoarse && (window.devicePixelRatio || 1) >= 2),
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.isCoarse ? 1.5 : 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 400);
    this.camera.rotation.order = 'YXZ';
    // The camera must be in the scene graph so its children (the pencil
    // viewmodel) are rendered.
    this.scene.add(this.camera);

    this.world = opts.mode === 'escape' ? new EscapeWorld() : new World();
    this.scene.add(this.world.group);
    this.scene.background = this.world.skyColor;
    const lighting = this.world.lighting;
    this.scene.fog = new THREE.Fog(this.world.skyColor, lighting.fogNear, lighting.fogFar);

    // No shadow maps anywhere (blob shadows instead).
    const hemisphere = new THREE.HemisphereLight(
      lighting.hemiSky,
      lighting.hemiGround,
      lighting.hemiIntensity,
    );
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight(lighting.sunColor, lighting.sunIntensity);
    sun.position.set(18, 30, 14);
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.controller = new PlayerController(this.world.colliders);
    this.movementEffects = new MovementEffects(this.scene, this.camera);
    this.movementEffects.setViewport(opts.canvas.height);

    this.blobShadows = new BlobShadows(this.scene, this.world.colliders);
    this.localShadow = this.blobShadows.create();

    this.remotePlayers = new RemotePlayers(this.scene, opts.selfId, this.blobShadows);
    this.remotePlayers.syncRoster(opts.players);

    this.inkObjects = new InkObjects(this.scene, this.world.colliders, this.movementEffects.particles);

    this.inkCap = opts.mode === 'escape' ? INK_BUDGET_ESCAPE : INK_BUDGET_COMBAT;
    this.inkRegen = opts.mode === 'escape' ? INK_REGEN_ESCAPE : INK_REGEN_COMBAT;
    this.ink = this.inkCap;

    this.weapon = new Weapon(
      this.scene,
      this.camera,
      this.remotePlayers,
      this.world.colliders,
      this.inkObjects,
      this.movementEffects.particles,
      {
        onShoot: (origin, dir, hitId, hitPoint, inkId) =>
          sendShoot(origin, dir, hitId, hitPoint, inkId),
        onAmmo: (mag, reloading, progress) => opts.onAmmoChange(mag, reloading, progress),
      },
    );

    this.sketch = new SketchControl(this.scene, this.camera, this.world.colliders, opts.sketchLayer, {
      tryCast: (origin, right, up, strokes, cost) => this.castInk(origin, right, up, strokes, cost),
      inKeyZone: (origin) => this.isInKeyZone(origin),
      tryKey: (strokes) => this.tryKey(strokes),
      getInk: () => this.ink,
      onToast: (message) => opts.onToast(message),
      onOpenChange: (open) => {
        document.body.classList.toggle('sketching', open);
        if (open) this.input.firePressed = false;
      },
    });

    this.keyboardMouse = new KeyboardMouse(
      opts.canvas,
      this.input,
      (dx, dy) => this.routeMouseDelta(dx, dy, MOUSE_LOOK_SENS),
      (locked) => {
        if (!locked && this.sketch.active) this.sketch.cancel();
        opts.onPointerLockChange(locked);
      },
      !opts.isCoarse,
    );
    if (opts.isCoarse) {
      this.touchControls = new TouchControls(opts.canvas, opts.touchLayer, this.input, (dx, dy) =>
        this.routeMouseDelta(dx, dy, TOUCH_LOOK_SENS),
      );
      // Party starts on an intermission; applyPartyRound re-shows the combat
      // buttons per shooting round.
      this.touchControls.setCombatButtonsVisible(opts.mode !== 'escape' && opts.mode !== 'party');
    }
  }

  /** Locked-mouse / touch-look deltas go to the camera — or the sketch pen. */
  private routeMouseDelta(dxPx: number, dyPx: number, sensitivity: number): void {
    if (this.podiumOrbit) return; // cinematic camera owns the view
    if (this.sketch.active) {
      this.sketch.penDelta(dxPx, dyPx);
    } else {
      this.controller.applyLook(-dxPx * sensitivity, -dyPx * sensitivity);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.controller.spawn(this.world.spawnPoints);
    // Compile the particle shader before gameplay so the first burst
    // (e.g. the first double jump on mobile) doesn't hitch.
    this.movementEffects.warmup();
    this.keyboardMouse.attach();
    this.touchControls?.attach();
    window.addEventListener('resize', this.handleResize);
    document.addEventListener('fullscreenchange', this.handleResize);
    document.addEventListener('webkitfullscreenchange', this.handleResize);
    this.opts.onPointerLockChange(false);
    this.reportInk(true);

    this.lastFrameMs = performance.now();
    this.lastSendMs = 0;
    this.fpsWindowStart = this.lastFrameMs;
    this.fpsFrames = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  addPlayer(player: PlayerInfo): void {
    this.remotePlayers.add(player);
  }

  removePlayer(id: string): void {
    this.remotePlayers.remove(id);
  }

  onPlayersState(states: readonly PlayerStateBroadcast[]): void {
    this.remotePlayers.pushStates(states);
  }

  /** Render another player's tracer/splat from a `player:shot` broadcast. */
  onRemoteShot(origin: Vec3, dir: Vec3, hitPoint: Vec3 | null): void {
    this.weapon.spawnRemoteShot(origin, dir, hitPoint);
  }

  remotePlayerDamaged(id: string): void {
    this.remotePlayers.flashDamage(id);
  }

  remotePlayerDied(id: string): void {
    this.remotePlayers.setAlive(id, false);
  }

  remotePlayerRespawned(id: string): void {
    this.remotePlayers.setAlive(id, true);
  }

  // ---------------------------------------------------------------- magic ink

  /** A drawing materialized (broadcast) — ours or anyone's. */
  onInkObject(object: InkObjectMsg): void {
    const boxes = this.inkObjects.add(object, this.opts.colorOf(object.ownerId));

    // "Ink elevator": ink drawn into the player lifts them onto its top
    // surface instead of trapping them inside solid geometry.
    if (this.selfDead || boxes.length === 0) return;
    const p = this.controller.pos;
    _box.min.set(p.x - 0.4, p.y, p.z - 0.4);
    _box.max.set(p.x + 0.4, p.y + 1.8, p.z + 0.4);
    let top = -Infinity;
    for (const box of boxes) {
      if (box.intersectsBox(_box) && box.max.y > top) top = box.max.y;
    }
    if (top > -Infinity) this.controller.liftTo(top);
  }

  onInkRemoved(id: number): void {
    this.inkObjects.remove(id);
    if (this.eraseTargetId === id) {
      this.eraseTargetId = null;
      this.eraseProgress = 0;
    }
  }

  /** Authoritative budget from the server — snaps the local prediction. */
  onInkBudget(ink: number): void {
    // Never clamp to the locally-known cap: a party round's reseeded budget
    // can land one event before the party:round that carries the new cap.
    this.ink = Math.max(0, ink);
    this.reportInk(true);
    this.sketch.markCostDirty();
  }

  /** Reconfigure the ink budget mid-match (party rounds tune cap/regen). */
  setInkConfig(cap: number, regen: number): void {
    this.inkCap = cap;
    this.inkRegen = regen;
    if (this.ink > cap) this.ink = cap;
    this.reportInk(true);
    this.sketch.markCostDirty();
  }

  private castInk(origin: Vec3, right: Vec3, up: Vec3, strokes: InkPoint[][], cost: number): boolean {
    sendInkDraw(origin, right, up, strokes);
    this.ink = Math.max(0, this.ink - cost); // optimistic; ink:budget confirms
    this.reportInk(true);
    return true;
  }

  private reportInk(force: boolean): void {
    if (!force && Math.abs(this.ink - this.lastReportedInk) < 0.05) return;
    this.lastReportedInk = this.ink;
    this.opts.onInk(this.ink, this.inkCap);
  }

  // ---------------------------------------------------------------- escape

  onEscapeState(stages: readonly EscapeStage[]): void {
    for (const stage of stages) this.escapeStages.add(stage);
    if (this.world instanceof EscapeWorld) this.world.setStagesDone(this.escapeStages);
  }

  private isInKeyZone(origin: THREE.Vector3): boolean {
    if (!(this.world instanceof EscapeWorld) || this.escapeStages.has('key')) return false;
    return origin.distanceTo(this.world.keyZoneCenter) <= this.world.keyZoneRadius;
  }

  private tryKey(strokes: InkPoint[][]): boolean {
    if (!isKey(strokes)) return false;
    this.triggerStage('key');
    this.opts.onToast('THE KEY FITS — the door is opening!');
    if (this.world instanceof EscapeWorld) {
      const c = this.world.keyZoneCenter;
      for (let i = 0; i < 14; i++) {
        this.movementEffects.particles.spawn(
          c.x + (Math.random() - 0.5) * 1.5,
          c.y + Math.random() * 1.5,
          c.z + (Math.random() - 0.5) * 1.5,
          (Math.random() - 0.5) * 1.2,
          1 + Math.random() * 1.5,
          (Math.random() - 0.5) * 1.2,
          _gold.r, _gold.g, _gold.b,
          0.07,
          0.6,
        );
      }
    }
    return true;
  }

  private triggerStage(stage: EscapeStage): void {
    if (this.sentStages.has(stage) || this.escapeStages.has(stage)) return;
    this.sentStages.add(stage);
    sendEscapeTrigger(stage);
  }

  private updateEscape(nowMs: number): void {
    if (!(this.world instanceof EscapeWorld) || this.selfDead || this.matchOver) return;
    const world = this.world;
    const p = this.controller.pos;

    // Fell into the chasm: back to the ledge, no harm done.
    if (p.y < world.fallY) {
      this.controller.teleport(world.fallRecovery);
      this.opts.onToast('The ink abyss ate you — draw a sturdier path!');
      return;
    }

    if (!this.escapeStages.has('chasm') && p.x > world.chasmCrossedX) {
      this.triggerStage('chasm');
    }

    if (nowMs - this.lastSensorCheckMs >= ESCAPE_SENSOR_INTERVAL_MS) {
      this.lastSensorCheckMs = nowMs;

      if (!this.escapeStages.has('plate')) {
        _box.min.set(p.x - 0.4, p.y, p.z - 0.4);
        _box.max.set(p.x + 0.4, p.y + 1.8, p.z + 0.4);
        if (_box.intersectsBox(world.plateSensor) || this.inkObjects.intersectsBox(world.plateSensor)) {
          this.triggerStage('plate');
        }
      }

      if (this.escapeStages.has('key') && !this.escapeStages.has('exit')) {
        _box.min.set(p.x - 0.4, p.y, p.z - 0.4);
        _box.max.set(p.x + 0.4, p.y + 1.8, p.z + 0.4);
        if (_box.intersectsBox(world.exitZone)) this.triggerStage('exit');
      }
    }
  }

  // ---------------------------------------------------------------- party

  /** Apply a `party:round` phase flip (also replayed to late joiners). */
  applyPartyRound(payload: PartyRoundMsg): void {
    this.partyPhase = payload.phase;
    this.lastKlaxonSeconds = -1;
    const params = payload.params;

    // The server reseeds budgets with the round's cap (pity included) at the
    // START of the intermission — mirror the config on every phase, not just
    // 'playing', so the meter denominator matches the reseeded budget.
    const pity = params.pityId !== null && params.pityId === this.opts.selfId;
    this.setInkConfig(
      params.inkCap * (pity ? PARTY_PITY_CAP_MULT : 1),
      params.inkRegen * (pity ? PARTY_PITY_REGEN_MULT : 1),
    );

    if (payload.phase === 'playing') {
      this.partyShootingEnabled = params.shootingEnabled;
      this.partyGunsUnlockAt = params.gunsUnlockAt;
      this.partyPulse = params.pulse;
      if (this.world instanceof World) this.world.setLava(params.lava);
      this.applyPartyGuns(this.partyGunsLiveNow());
    } else {
      // Intermission and podium: shooting off, flood cleared.
      this.partyShootingEnabled = false;
      this.partyGunsUnlockAt = null;
      this.partyPulse = null;
      if (this.world instanceof World) this.world.setLava(null);
      this.applyPartyGuns(false);
    }
  }

  /** Mirror of the server's shoot gate: enabled outright, or the unlock passed. */
  private partyGunsLiveNow(): boolean {
    return (
      this.partyShootingEnabled ||
      (this.partyGunsUnlockAt !== null && Date.now() >= this.partyGunsUnlockAt)
    );
  }

  /** Flip everything gun-related together: firing, bullet-erasure, touch buttons. */
  private applyPartyGuns(live: boolean): void {
    this.partyGunsLive = live;
    this.weapon.setInkErasure(live);
    this.touchControls?.setCombatButtonsVisible(live);
  }

  /** Detach the camera into the slow podium orbit over the final wreckage. */
  startPodiumOrbit(): void {
    if (this.podiumOrbit) return;
    this.podiumOrbit = true;
    this.podiumStartMs = performance.now();
    this.weapon.setVisible(false);
    if (this.sketch.active) this.sketch.cancel();
  }

  /** PNG snapshot of the current view (explicit render, so no preserveDrawingBuffer). */
  captureScreenshot(): string | null {
    try {
      this.renderer.render(this.scene, this.camera);
      return this.renderer.domElement.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  /** Floor-check warning: notify the HUD once per displayed second before a pulse. */
  private updateKlaxon(): void {
    const pulse = this.partyPulse;
    if (!pulse || this.partyPhase !== 'playing') return;
    const now = Date.now();
    let next = Infinity;
    for (const t of pulse.times) {
      if (t > now && t < next) next = t;
    }
    if (next === Infinity || next - now > pulse.warnMs) {
      this.lastKlaxonSeconds = -1;
      return;
    }
    const seconds = Math.max(1, Math.ceil((next - now) / 1000));
    if (seconds !== this.lastKlaxonSeconds) {
      this.lastKlaxonSeconds = seconds;
      this.opts.onKlaxon(seconds);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Local death/respawn. Dead: movement + fire are locked, the viewmodel and
   * blob hide, and player:state stops being sent. Respawn: fresh random spawn
   * point and a full mag.
   */
  setSelfDead(dead: boolean): void {
    if (this.selfDead === dead) return;
    this.selfDead = dead;
    this.weapon.setVisible(!dead && !this.podiumOrbit);
    this.localShadow.setVisible(!dead);
    if (dead && this.sketch.active) this.sketch.cancel();
    if (!dead) {
      this.controller.spawn(this.world.spawnPoints);
      this.weapon.refill();
      this.input.jumpQueuedAt = -Infinity; // no buffered mid-death jumps
      this.accumulator = 0;
    }
  }

  /** Between match:ended and room:reset shots are rejected — stop firing locally too. */
  setMatchOver(): void {
    this.matchOver = true;
    if (this.sketch.active) this.sketch.cancel();
  }

  private readonly frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    const delta = Math.min((nowMs - this.lastFrameMs) / 1000, MAX_FRAME_DELTA);
    this.lastFrameMs = nowMs;

    // --- Sketch toggle (Q key / DRAW button), consumed once per frame.
    if (this.input.sketchToggleQueued) {
      this.input.sketchToggleQueued = false;
      if (this.sketch.active) {
        this.sketch.cast();
      } else if (!this.selfDead && !this.matchOver && !this.podiumOrbit) {
        this.sketch.open();
      }
    }

    if (this.selfDead || this.podiumOrbit) {
      // Dead: physics and inputs freeze where the player fell.
      // Podium: the cinematic camera owns the frame — inputs are ignored.
      this.accumulator = 0;
    } else {
      this.accumulator += delta;
      while (this.accumulator >= PHYSICS_STEP) {
        this.controller.step(this.input, PHYSICS_STEP);
        this.movementEffects.onStep(
          this.controller.isGrounded(),
          this.controller.getHorizontalSpeed(),
          this.controller.getFallVelocity(),
          this.controller.pos,
        );
        for (const event of this.controller.drainEvents()) {
          this.movementEffects.onEvent(event, this.controller.pos);
        }
        this.accumulator -= PHYSICS_STEP;
      }
    }

    const alpha = this.accumulator / PHYSICS_STEP;
    this.camera.position.copy(this.controller.getEyePosition(alpha, this.eyeScratch));

    // Blob shadow follows the interpolated feet (camera is eye height above,
    // and view bob has not been applied yet).
    this.localShadow.update(
      this.camera.position.x,
      this.camera.position.y - EYE_HEIGHT,
      this.camera.position.z,
    );

    const bob = this.movementEffects.update(
      delta,
      this.controller.isGrounded(),
      this.controller.getHorizontalSpeed(),
    );
    // Apply bob in camera-local space (yaw only).
    const yaw = this.controller.yaw;
    this.camera.position.x += Math.cos(yaw) * bob.x - Math.sin(yaw) * bob.z;
    this.camera.position.y += bob.y;
    this.camera.position.z += Math.sin(yaw) * bob.x + Math.cos(yaw) * bob.z;

    this.camera.rotation.y = this.controller.yaw;
    this.camera.rotation.x = this.controller.pitch;

    // Podium: override the first-person pose with a slow orbit over the arena.
    if (this.podiumOrbit) {
      const angle =
        (((nowMs - this.podiumStartMs) / 1000) * Math.PI * 2) / PODIUM_ORBIT_PERIOD_S;
      this.camera.position.set(
        Math.cos(angle) * PODIUM_ORBIT_RADIUS,
        PODIUM_ORBIT_HEIGHT,
        Math.sin(angle) * PODIUM_ORBIT_RADIUS,
      );
      this.camera.lookAt(0, 2, 0);
    }

    this.remotePlayers.update(nowMs);
    this.world.update(delta);
    this.inkObjects.update(delta, Date.now());
    this.sketch.update();

    if (this.opts.mode === 'party') {
      this.updateKlaxon();
      // Cheap drama: fog warms as the rising ink climbs past ~1m.
      if (this.world instanceof World && this.scene.fog instanceof THREE.Fog) {
        const lavaY = this.world.lavaHeight;
        const warm = lavaY === null ? 0 : Math.min(1, Math.max(0, (lavaY - 1) / 5)) * 0.4;
        this.scene.fog.color.copy(this.world.skyColor).lerp(FOG_WARM_COLOR, warm);
      }
    }

    // Ink regen prediction (server corrections snap via ink:budget).
    if (this.ink < this.inkCap) {
      this.ink = Math.min(this.inkCap, this.ink + this.inkRegen * delta);
      this.reportInk(false);
    }

    // --- Eraser (hold G / ERASE aiming at your own ink).
    const erasing = this.input.erasePressed && !this.sketch.active && !this.selfDead && !this.matchOver;
    this.weapon.setEraseMode(erasing);
    if (erasing) {
      const dir = this.camera.getWorldDirection(this.eyeScratch);
      const hit = this.inkObjects.raycast(this.camera.position, dir, ERASE_RANGE);
      if (hit && hit.ownerId === this.opts.selfId) {
        if (hit.id !== this.eraseTargetId) {
          this.eraseTargetId = hit.id;
          this.eraseProgress = 0;
        }
        this.inkObjects.setHighlight(hit.id);
        this.eraseProgress += delta;
        if (this.eraseProgress >= ERASE_HOLD_S) {
          sendInkErase(hit.id);
          this.eraseProgress = -0.3; // brief cooldown until ink:removed lands
        }
      } else {
        this.inkObjects.setHighlight(null);
        this.eraseTargetId = null;
        this.eraseProgress = 0;
      }
    } else if (this.eraseTargetId !== null) {
      this.inkObjects.setHighlight(null);
      this.eraseTargetId = null;
      this.eraseProgress = 0;
    }

    // Party floor-check: guns unlock mid-round — flip fire/erasure/buttons on
    // together the moment the server-side gate opens.
    if (
      this.opts.mode === 'party' &&
      !this.partyGunsLive &&
      this.partyPhase === 'playing' &&
      this.partyGunsLiveNow()
    ) {
      this.applyPartyGuns(true);
      this.opts.onToast('GUNS UNLOCKED!');
    }

    // After the camera transform is final: fire raycasts and tracer spawns
    // read the exact pose being rendered this frame.
    const partyFireBlocked = this.opts.mode === 'party' && !this.partyGunsLive;
    const canFire =
      !this.selfDead &&
      !this.matchOver &&
      !this.sketch.active &&
      !erasing &&
      this.opts.mode !== 'escape' &&
      !partyFireBlocked;
    this.weapon.update(
      nowMs,
      delta,
      this.input,
      canFire,
      this.controller.isGrounded(),
      this.controller.getHorizontalSpeed(),
    );

    if (this.opts.mode === 'escape') this.updateEscape(nowMs);

    this.touchControls?.update();

    if (!this.selfDead && !this.podiumOrbit && nowMs - this.lastSendMs >= SEND_INTERVAL_MS) {
      this.lastSendMs = nowMs;
      sendPlayerState(this.controller.getNetworkState());
    }

    this.fpsFrames += 1;
    const fpsElapsed = nowMs - this.fpsWindowStart;
    if (fpsElapsed >= FPS_WINDOW_MS) {
      this.opts.onFps(Math.round((this.fpsFrames * 1000) / fpsElapsed));
      this.fpsWindowStart = nowMs;
      this.fpsFrames = 0;
    }

    this.renderer.render(this.scene, this.camera);
  };

  private readonly handleResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.movementEffects.setViewport(this.opts.canvas.height);
  };

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('fullscreenchange', this.handleResize);
    document.removeEventListener('webkitfullscreenchange', this.handleResize);
    document.body.classList.remove('sketching');

    this.keyboardMouse.dispose();
    this.touchControls?.dispose();
    this.sketch.dispose();
    this.inkObjects.dispose();
    this.weapon.dispose();
    this.remotePlayers.dispose();
    this.movementEffects.dispose();
    this.blobShadows.dispose();
    this.world.dispose();

    this.scene.clear();
    this.renderer.dispose();
  }
}
