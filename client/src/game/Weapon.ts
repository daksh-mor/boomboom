import * as THREE from 'three';
import { FIRE_COOLDOWN_MS, MAG_SIZE, RELOAD_MS } from '../../../shared/constants';
import type { Vec3 } from '../../../shared/types';
import type { InputState } from './controls/InputState';
import type { InkObjects } from './ink/InkObjects';
import type { ParticlePool } from './ParticlePool';
import type { RemotePlayers } from './RemotePlayers';

const WEAPON_RANGE = 100; // m

// Remote player hitbox: vertical capsule matching RemotePlayers' render mesh.
const CAPSULE_RADIUS = 0.4;
const CAP_BOTTOM_Y = 0.4; // lower sphere center above the feet
const CAP_TOP_Y = 1.4; // upper sphere center above the feet

// --- Viewmodel proportions (meters).
const BODY_RADIUS = 0.028;
const ERASER_LEN = 0.055;
const FERRULE_LEN = 0.045;
const BODY_LEN = 0.28;
const COLLAR_LEN = 0.06;
const TIP_LEN = 0.045;
const PENCIL_LEN = ERASER_LEN + FERRULE_LEN + BODY_LEN + COLLAR_LEN + TIP_LEN;

const BASE_POS = new THREE.Vector3(0.25, -0.2, -0.45);

const COLOR_BODY = 0xf2b632; // warm pencil yellow
const COLOR_WOOD = 0xe8c79c;
const COLOR_GRAPHITE = 0x23252e;
const COLOR_FERRULE = 0xb9c4cf;
const COLOR_ERASER = 0xf27d9d;

// Ink palette: bright "magic ink" tracer (additive), dark ink splats (alpha).
const TRACER_COLOR = 0x59e8ff;
const INK_COLOR = new THREE.Color(0x1d2646);
const SPARK_COLOR = new THREE.Color(0xaef4ff);

const TRACER_COUNT = 16;
const TRACER_LIFE = 0.1; // s (~100ms fade)
const TRACER_RADIUS = 0.018;
const TRACER_MAX_OPACITY = 0.85;

const SPLAT_PARTICLES = 8;
const SPLAT_SIZE = 0.07;
const SPLAT_LIFE = 0.45;

const RECOIL_KICK_Z = 0.07; // m back toward the camera
const RECOIL_KICK_Y = 0.02;
const RECOIL_KICK_PITCH = 0.12; // rad tip-up
const RECOIL_RETURN = 9; // 1/s exponential spring return
const RELOAD_DIP = 0.16; // m

const UP = new THREE.Vector3(0, 1, 0);

// Module-level scratch (single-threaded; never retained across calls).
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _end = new THREE.Vector3();
const _quat = new THREE.Quaternion();

/** Ray vs vertical capsule (sphere centers at y0/y1 over (cx,cz), radius r). Returns hit t or Infinity. */
function rayVerticalCapsuleT(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cz: number, y0: number, y1: number, r: number,
): number {
  let best = Infinity;

  // Cylinder body: 2D circle test in the XZ plane, hit must land between the caps.
  const a = dx * dx + dz * dz;
  if (a > 1e-9) {
    const mx = ox - cx;
    const mz = oz - cz;
    const b = mx * dx + mz * dz;
    const c = mx * mx + mz * mz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      if (t >= 0) {
        const hy = oy + dy * t;
        if (hy >= y0 && hy <= y1) best = t;
      }
    }
  }

  // End-cap spheres.
  for (let i = 0; i < 2; i++) {
    const sy = i === 0 ? y0 : y1;
    const mx = ox - cx;
    const my = oy - sy;
    const mz = oz - cz;
    const b = mx * dx + my * dy + mz * dz;
    const c = mx * mx + my * my + mz * mz - r * r;
    const disc = b * b - c; // dir is unit length
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && t < best) best = t;
  }

  return best;
}

/** Ray vs AABB slab test. Returns entry t (0 when starting inside) or Infinity. */
function rayBoxT(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  box: THREE.Box3,
): number {
  let tMin = 0;
  let tMax = Infinity;

  // Per-axis explicit branches: avoids 0 * Infinity = NaN from the 1/d form.
  if (Math.abs(dx) < 1e-12) {
    if (ox < box.min.x || ox > box.max.x) return Infinity;
  } else {
    const inv = 1 / dx;
    let t1 = (box.min.x - ox) * inv;
    let t2 = (box.max.x - ox) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return Infinity;
  }
  if (Math.abs(dy) < 1e-12) {
    if (oy < box.min.y || oy > box.max.y) return Infinity;
  } else {
    const inv = 1 / dy;
    let t1 = (box.min.y - oy) * inv;
    let t2 = (box.max.y - oy) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return Infinity;
  }
  if (Math.abs(dz) < 1e-12) {
    if (oz < box.min.z || oz > box.max.z) return Infinity;
  } else {
    const inv = 1 / dz;
    let t1 = (box.min.z - oz) * inv;
    let t2 = (box.max.z - oz) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return Infinity;
  }

  return tMin;
}

/**
 * Fixed pool of additive ink-streak tracers: thin open-ended cylinders
 * stretched between two points, fading out over ~100ms. Zero steady-state
 * allocation — spawn takes scalars and reuses meshes/materials.
 */
class TracerPool {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  private readonly meshes: THREE.Mesh[] = [];
  private readonly materials: THREE.MeshBasicMaterial[] = [];
  private readonly life = new Float32Array(TRACER_COUNT);

  constructor() {
    for (let i = 0; i < TRACER_COUNT; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: TRACER_COLOR,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false; // short-lived, transforms mutate in place
      mesh.renderOrder = 2; // with particles, after blob shadows
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(material);
    }
  }

  spawn(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): void {
    const lx = ex - sx;
    const ly = ey - sy;
    const lz = ez - sz;
    const len = Math.hypot(lx, ly, lz);
    if (len < 1e-4) return;

    // Free slot, else steal the oldest (smallest remaining life).
    let slot = -1;
    let oldest = Infinity;
    for (let i = 0; i < TRACER_COUNT; i++) {
      if (this.life[i]! <= 0) { slot = i; break; }
      if (this.life[i]! < oldest) { oldest = this.life[i]!; slot = i; }
    }
    if (slot < 0) return;

    const mesh = this.meshes[slot]!;
    _dir.set(lx / len, ly / len, lz / len);
    mesh.quaternion.copy(_quat.setFromUnitVectors(UP, _dir));
    mesh.position.set(sx + lx * 0.5, sy + ly * 0.5, sz + lz * 0.5);
    mesh.scale.set(TRACER_RADIUS, len, TRACER_RADIUS);
    mesh.visible = true;
    this.materials[slot]!.opacity = TRACER_MAX_OPACITY;
    this.life[slot] = TRACER_LIFE;
  }

  update(dt: number): void {
    for (let i = 0; i < TRACER_COUNT; i++) {
      const remaining = this.life[i]!;
      if (remaining <= 0) continue;
      const next = remaining - dt;
      this.life[i] = next;
      if (next <= 0) {
        this.meshes[i]!.visible = false;
        continue;
      }
      this.materials[i]!.opacity = (next / TRACER_LIFE) * TRACER_MAX_OPACITY;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}

export interface WeaponCallbacks {
  /**
   * A local shot was fired (already rendered locally) — send it to the server.
   * inkId is non-null only when bullet-erasure is active and the nearest
   * impact along the ray was an ink object.
   */
  onShoot(
    origin: Vec3,
    dir: Vec3,
    hitId: string | null,
    hitPoint: Vec3 | null,
    inkId: number | null,
  ): void;
  /** Ammo/reload state for the HUD. progress is 0..1 while reloading, else 0. */
  onAmmo(mag: number, reloading: boolean, progress: number): void;
}

/**
 * The magic pencil: first-person viewmodel parented to the camera, client-side
 * ammo/reload state machine, hitscan raycast against remote-player capsules
 * with world AABBs as occluders, and pooled tracers/ink splats for both local
 * and remote shots.
 */
export class Weapon {
  private readonly root = new THREE.Group();
  private readonly tipMarker = new THREE.Object3D();
  private readonly tracers = new TracerPool();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly reducedMotion: boolean;

  private mag = MAG_SIZE;
  private reloading = false;
  private reloadStartedAt = 0;
  private lastFiredAt = -Infinity;

  private swayTime = 0;
  private bobPhase = 0;
  private recoil = 0;
  /** 0..1 blend toward eraser-out (pencil flipped 180°). */
  private flip = 0;
  private eraseMode = false;
  /** Party shooting rounds: bullets that hit ink report it for erasure. */
  private inkErasureEnabled = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly remotePlayers: RemotePlayers,
    private readonly colliders: readonly THREE.Box3[],
    private readonly inkObjects: InkObjects,
    private readonly particles: ParticlePool,
    private readonly callbacks: WeaponCallbacks,
  ) {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.buildViewmodel();
    this.root.position.copy(BASE_POS);
    this.camera.add(this.root);
    this.scene.add(this.tracers.group);
  }

  private buildViewmodel(): void {
    // Built along +Y (tip at the top), then rotated so the tip points at -Z
    // (camera forward). Shadow maps are off globally — never set castShadow.
    const pencil = new THREE.Group();
    pencil.rotation.x = -Math.PI / 2;
    pencil.position.z = PENCIL_LEN / 2; // center the pencil around the root

    const lambert = (color: number): THREE.MeshLambertMaterial => {
      const material = new THREE.MeshLambertMaterial({ color });
      this.materials.push(material);
      return material;
    };
    const track = <G extends THREE.BufferGeometry>(g: G): G => {
      this.geometries.push(g);
      return g;
    };

    let y = 0;
    const stack = (geometry: THREE.BufferGeometry, len: number, material: THREE.Material): void => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = y + len / 2;
      mesh.frustumCulled = false; // hugs the near plane; never cull
      pencil.add(mesh);
      y += len;
    };

    // Back to front: eraser, ferrule, hex body, wood collar, graphite tip.
    stack(
      track(new THREE.CylinderGeometry(BODY_RADIUS * 0.82, BODY_RADIUS * 0.82, ERASER_LEN, 8)),
      ERASER_LEN,
      lambert(COLOR_ERASER),
    );
    stack(
      track(new THREE.CylinderGeometry(BODY_RADIUS * 1.06, BODY_RADIUS * 1.06, FERRULE_LEN, 8)),
      FERRULE_LEN,
      lambert(COLOR_FERRULE),
    );
    stack(
      track(new THREE.CylinderGeometry(BODY_RADIUS, BODY_RADIUS, BODY_LEN, 6)),
      BODY_LEN,
      lambert(COLOR_BODY),
    );
    stack(
      track(new THREE.CylinderGeometry(BODY_RADIUS * 0.4, BODY_RADIUS, COLLAR_LEN, 6)),
      COLLAR_LEN,
      lambert(COLOR_WOOD),
    );
    stack(
      track(new THREE.ConeGeometry(BODY_RADIUS * 0.4, TIP_LEN, 6)),
      TIP_LEN,
      lambert(COLOR_GRAPHITE),
    );

    this.tipMarker.position.y = PENCIL_LEN;
    pencil.add(this.tipMarker);
    this.root.add(pencil);
  }

  get magazine(): number {
    return this.mag;
  }

  get isReloading(): boolean {
    return this.reloading;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** Flip the pencil around so the eraser end leads (hold-to-erase). */
  setEraseMode(on: boolean): void {
    this.eraseMode = on;
  }

  /** Enable bullet-erasure (party mode, shooting rounds only). */
  setInkErasure(on: boolean): void {
    this.inkErasureEnabled = on;
  }

  /** Instantly refill the mag and cancel any reload (used on respawn). */
  refill(): void {
    this.mag = MAG_SIZE;
    this.reloading = false;
    this.callbacks.onAmmo(this.mag, false, 0);
  }

  /**
   * Per-frame update: fire/reload state machine, viewmodel animation, tracer
   * fade. Call after the camera transform is final for the frame.
   */
  update(
    nowMs: number,
    dt: number,
    input: InputState,
    canFire: boolean,
    grounded: boolean,
    horizontalSpeed: number,
  ): void {
    // --- Reload completion.
    if (this.reloading) {
      const t = (nowMs - this.reloadStartedAt) / RELOAD_MS;
      if (t >= 1) {
        this.reloading = false;
        this.mag = MAG_SIZE;
        this.callbacks.onAmmo(this.mag, false, 0);
      } else {
        this.callbacks.onAmmo(this.mag, true, t);
      }
    }

    // --- Manual reload request (consumed even when it can't start).
    const reloadRequested = input.reloadQueued;
    input.reloadQueued = false;
    if (reloadRequested && canFire && !this.reloading && this.mag < MAG_SIZE) {
      this.startReload(nowMs);
    }

    // --- Fire (hold-to-fire at the cooldown rate).
    if (input.firePressed && canFire && !this.reloading) {
      if (this.mag <= 0) {
        this.startReload(nowMs); // auto-reload when squeezing an empty mag
      } else if (nowMs - this.lastFiredAt >= FIRE_COOLDOWN_MS) {
        this.fire(nowMs);
      }
    }

    this.animate(nowMs, dt, grounded, horizontalSpeed);
    this.tracers.update(dt);
  }

  private startReload(nowMs: number): void {
    this.reloading = true;
    this.reloadStartedAt = nowMs;
    this.callbacks.onAmmo(this.mag, true, 0);
  }

  private fire(nowMs: number): void {
    this.lastFiredAt = nowMs;
    this.mag -= 1;
    this.recoil = 1;
    this.callbacks.onAmmo(this.mag, false, 0);

    // Ray from the crosshair (camera has no parent, so position is world space).
    const origin = _origin.copy(this.camera.position);
    const dir = this.camera.getWorldDirection(_dir); // normalized

    // Nearest world occluder.
    let tWorld = WEAPON_RANGE;
    for (const box of this.colliders) {
      const t = rayBoxT(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, box);
      if (t < tWorld) tWorld = t;
    }

    // Nearest visible remote player in front of that occluder.
    let hitId: string | null = null;
    let tHit = tWorld;
    this.remotePlayers.forEachTarget((id, fx, fy, fz) => {
      const t = rayVerticalCapsuleT(
        origin.x, origin.y, origin.z,
        dir.x, dir.y, dir.z,
        fx, fz, fy + CAP_BOTTOM_Y, fy + CAP_TOP_Y, CAPSULE_RADIUS,
      );
      if (t < tHit) {
        tHit = t;
        hitId = id;
      }
    });

    // Bullet-eraser (party shooting rounds): ink boxes live in the shared
    // collider array, so the nearest ink t can never beat tWorld — it can only
    // EQUAL it, which means the nearest thing this bullet hit is an ink
    // object (and no player capsule was closer). Report it for erasure.
    let inkId: number | null = null;
    if (this.inkErasureEnabled && hitId === null && tWorld < WEAPON_RANGE) {
      const inkHit = this.inkObjects.raycast(origin, dir, WEAPON_RANGE);
      if (inkHit && inkHit.distance <= tWorld + 1e-4) inkId = inkHit.id;
    }

    const hasImpact = hitId !== null || tWorld < WEAPON_RANGE;
    const tEnd = hasImpact ? tHit : WEAPON_RANGE;
    _end.set(origin.x + dir.x * tEnd, origin.y + dir.y * tEnd, origin.z + dir.z * tEnd);

    // Send before the local presentation: TracerPool.spawn() reuses the _dir
    // scratch that `dir` aliases, so the payload must be built while it still
    // holds the camera direction.
    const hitPoint: Vec3 | null = hasImpact ? { x: _end.x, y: _end.y, z: _end.z } : null;
    this.callbacks.onShoot(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dir.x, y: dir.y, z: dir.z },
      hitId,
      hitPoint,
      inkId,
    );

    // Local presentation: tracer from the pencil tip, splat + sparkle.
    const tip = this.tipMarker.getWorldPosition(_tip);
    this.tracers.spawn(tip.x, tip.y, tip.z, _end.x, _end.y, _end.z);
    if (hasImpact) this.spawnInkSplat(_end.x, _end.y, _end.z);
    this.spawnTipSparkle(tip.x, tip.y, tip.z);

    if (this.mag <= 0) this.startReload(nowMs);
  }

  /** Render another player's shot from a `player:shot` broadcast. */
  spawnRemoteShot(origin: Vec3, dir: Vec3, hitPoint: Vec3 | null): void {
    if (hitPoint) {
      _end.set(hitPoint.x, hitPoint.y, hitPoint.z);
    } else {
      _end.set(
        origin.x + dir.x * WEAPON_RANGE,
        origin.y + dir.y * WEAPON_RANGE,
        origin.z + dir.z * WEAPON_RANGE,
      );
    }
    this.tracers.spawn(origin.x, origin.y, origin.z, _end.x, _end.y, _end.z);
    if (hitPoint) this.spawnInkSplat(_end.x, _end.y, _end.z);
  }

  private spawnInkSplat(x: number, y: number, z: number): void {
    for (let i = 0; i < SPLAT_PARTICLES; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.8 + Math.random() * 1.4;
      this.particles.spawn(
        x, y, z,
        Math.cos(angle) * speed,
        0.6 + Math.random() * 1.4,
        Math.sin(angle) * speed,
        INK_COLOR.r, INK_COLOR.g, INK_COLOR.b,
        SPLAT_SIZE,
        SPLAT_LIFE,
      );
    }
  }

  private spawnTipSparkle(x: number, y: number, z: number): void {
    for (let i = 0; i < 2; i++) {
      this.particles.spawn(
        x, y, z,
        (Math.random() - 0.5) * 0.6,
        0.4 + Math.random() * 0.4,
        (Math.random() - 0.5) * 0.6,
        SPARK_COLOR.r, SPARK_COLOR.g, SPARK_COLOR.b,
        0.03,
        0.15,
      );
    }
  }

  private animate(nowMs: number, dt: number, grounded: boolean, horizontalSpeed: number): void {
    if (!this.root.visible) return;

    let x = BASE_POS.x;
    let py = BASE_POS.y;
    let z = BASE_POS.z;
    let pitch = 0;
    let roll = 0;

    if (!this.reducedMotion) {
      // Idle sway.
      this.swayTime += dt;
      x += Math.sin(this.swayTime * 1.1) * 0.003;
      py += Math.sin(this.swayTime * 1.7) * 0.004;

      // Movement bob, scaled by ground speed.
      const speedK = Math.min(1, horizontalSpeed / 6);
      if (grounded && horizontalSpeed > 0.5) {
        this.bobPhase += dt * 7 * speedK;
      }
      x += Math.cos(this.bobPhase * Math.PI) * 0.012 * speedK;
      py += Math.sin(this.bobPhase * Math.PI * 2) * 0.009 * speedK;
    }

    // Recoil kick with exponential spring return.
    if (this.recoil > 0.001) {
      this.recoil *= Math.exp(-RECOIL_RETURN * dt);
      z += this.recoil * RECOIL_KICK_Z;
      py += this.recoil * RECOIL_KICK_Y;
      pitch += this.recoil * RECOIL_KICK_PITCH;
    } else {
      this.recoil = 0;
    }

    // Reload: dip down and spin once around the pencil's long axis.
    if (this.reloading) {
      const t = Math.min(1, (nowMs - this.reloadStartedAt) / RELOAD_MS);
      py -= Math.sin(Math.PI * t) * RELOAD_DIP;
      const ease = t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2; // easeInOutQuad
      roll += ease * Math.PI * 2;
    }

    // Eraser flip: blend a 180° pitch so the pink end points forward.
    const flipTarget = this.eraseMode ? 1 : 0;
    this.flip += (flipTarget - this.flip) * Math.min(1, dt * 10);
    if (Math.abs(this.flip - flipTarget) < 0.001) this.flip = flipTarget;
    pitch += this.flip * Math.PI;
    py -= this.flip * 0.03;

    this.root.position.set(x, py, z);
    this.root.rotation.set(pitch, 0, roll);
  }

  dispose(): void {
    this.camera.remove(this.root);
    this.tracers.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
