import * as THREE from 'three';
import { ParticlePool } from './ParticlePool';

const BASE_FOV = 75;
const BOB_FREQ = 9; // steps per second at full speed
const BOB_AMP = 0.04; // m vertical bob
const BOB_SIDE = 0.02; // m lateral sway
const FOV_KICK = 4; // degrees added on double jump
const LAND_DIP = 0.12; // m camera dip on hard landing
const PARTICLE_LIFE = 0.35; // s
const PARTICLE_SIZE = 0.08; // m — matches the old 0.08m cube particles

// Precomputed once at module load; the spawn paths must not allocate.
const JUMP_COLOR = new THREE.Color(0xffe566);
const DOUBLE_JUMP_COLOR = new THREE.Color(0x40c4ff);
const DUST_COLOR = new THREE.Color(0xc8b89a);

export type MovementEvent = 'jump' | 'doubleJump' | 'land';

export class MovementEffects {
  private readonly pool: ParticlePool;
  private readonly reducedMotion: boolean;
  private readonly bobScratch = new THREE.Vector3();

  private bobPhase = 0;
  private fovKick = 0;
  private landDip = 0;
  private prevGrounded = true;
  private appliedFov: number;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.camera.fov = BASE_FOV;
    this.camera.updateProjectionMatrix();
    this.appliedFov = BASE_FOV;

    // 256: movement bursts + weapon ink splats share this pool (spawn() drops
    // silently when full, so headroom matters more than memory here).
    this.pool = new ParticlePool(256);
    this.scene.add(this.pool.points);
  }

  /** Shared pool — other systems (e.g. weapon ink splats) may spawn into it. */
  get particles(): ParticlePool {
    return this.pool;
  }

  /**
   * Force the particle shader to compile + first-draw before gameplay: one
   * sub-pixel particle below the ground renders on the next frame, so the
   * first real burst (mobile double jump) doesn't hitch.
   */
  warmup(): void {
    this.pool.spawn(0, -2, 0, 0, 0, 0, 1, 1, 1, 0.001, 0.3);
  }

  /** Keep particle size attenuation in sync with the drawing buffer height. */
  setViewport(drawingBufferHeight: number): void {
    this.pool.setPerspective(drawingBufferHeight, BASE_FOV);
  }

  /** Call once per physics step with controller state. */
  onStep(
    grounded: boolean,
    horizontalSpeed: number,
    fallVelocity: number,
    feetPos: THREE.Vector3,
  ): void {
    if (grounded && !this.prevGrounded && fallVelocity < -4) {
      this.triggerLand(Math.min(1, (-fallVelocity - 4) / 12), feetPos);
    }
    this.prevGrounded = grounded;

    if (this.reducedMotion) return;

    if (grounded && horizontalSpeed > 0.5) {
      this.bobPhase += BOB_FREQ * (1 / 60) * Math.min(1, horizontalSpeed / 6);
    }
  }

  onEvent(event: MovementEvent, position: THREE.Vector3): void {
    if (this.reducedMotion) return;

    switch (event) {
      case 'jump':
        this.spawnBurst(position, 6, JUMP_COLOR, 1.2);
        break;
      case 'doubleJump':
        this.fovKick = FOV_KICK;
        this.spawnBurst(position, 10, DOUBLE_JUMP_COLOR, 2.0);
        break;
      case 'land':
        // Handled via onStep fall detection.
        break;
    }
  }

  private triggerLand(intensity: number, feetPos: THREE.Vector3): void {
    if (this.reducedMotion) return;
    this.landDip = LAND_DIP * intensity;
    const count = Math.floor(4 + intensity * 6);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      this.pool.spawn(
        feetPos.x + (Math.random() - 0.5) * 0.6,
        feetPos.y + 0.05,
        feetPos.z + (Math.random() - 0.5) * 0.6,
        Math.cos(angle) * (0.3 + Math.random() * 0.5),
        0.5 + Math.random() * 0.8,
        Math.sin(angle) * (0.3 + Math.random() * 0.5),
        DUST_COLOR.r,
        DUST_COLOR.g,
        DUST_COLOR.b,
        PARTICLE_SIZE,
        PARTICLE_LIFE,
      );
    }
  }

  private spawnBurst(origin: THREE.Vector3, count: number, color: THREE.Color, speed: number): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const up = 0.5 + Math.random() * 0.8;
      this.pool.spawn(
        origin.x,
        origin.y + 0.1,
        origin.z,
        Math.cos(angle) * speed * (0.3 + Math.random() * 0.7),
        up * speed,
        Math.sin(angle) * speed * (0.3 + Math.random() * 0.7),
        color.r,
        color.g,
        color.b,
        PARTICLE_SIZE,
        PARTICLE_LIFE,
      );
    }
  }

  /**
   * Apply camera offsets for the current frame. Returns the bob offset to add
   * to the eye position — a reused scratch vector, valid until the next call.
   */
  update(dt: number, grounded: boolean, horizontalSpeed: number): THREE.Vector3 {
    const bob = this.bobScratch.set(0, 0, 0);

    if (!this.reducedMotion) {
      if (grounded && horizontalSpeed > 0.3) {
        const bobY = Math.sin(this.bobPhase * Math.PI * 2) * BOB_AMP;
        const bobX = Math.cos(this.bobPhase * Math.PI) * BOB_SIDE;
        bob.set(bobX, bobY, 0);
      }

      // Decay FOV kick and landing dip.
      if (this.fovKick > 0) {
        this.fovKick = Math.max(0, this.fovKick - dt * 30);
      }
      if (this.landDip > 0) {
        this.landDip = Math.max(0, this.landDip - dt * 3);
        bob.y -= this.landDip;
      }
    }

    // Rebuilding the projection matrix is not free — only do it on the frames
    // where the FOV kick actually changed the value.
    const targetFov = BASE_FOV + this.fovKick;
    if (targetFov !== this.appliedFov) {
      this.appliedFov = targetFov;
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }

    this.pool.update(dt);
    return bob;
  }

  dispose(): void {
    this.scene.remove(this.pool.points);
    this.pool.dispose();
  }
}
