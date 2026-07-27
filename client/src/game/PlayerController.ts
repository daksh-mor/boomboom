import * as THREE from 'three';
import type { PlayerStateMsg } from '../../../shared/types';
import type { InputState } from './controls/InputState';
import type { MovementEvent } from './MovementEffects';

// Player AABB half-extents 0.4 x 0.9 x 0.4 => 0.8m wide, 1.8m tall.
const HALF_X = 0.4;
const HALF_Z = 0.4;
const HEIGHT = 1.8;
export const EYE_HEIGHT = 1.6;

const WALK_SPEED = 6; // m/s
const GROUND_ACCEL = 60; // m/s^2 — reaches full speed in ~0.1s (snappy)
const AIR_ACCEL = GROUND_ACCEL * 0.3; // ~30% air control
const GRAVITY = 22; // m/s^2
const JUMP_VELOCITY = 7.3; // apex = v^2 / 2g ≈ 1.21m
const DOUBLE_JUMP_VELOCITY = 6.5; // slightly lower second jump
const MAX_FALL_SPEED = 40; // m/s
const COYOTE_TIME = 0.08; // s
const JUMP_BUFFER_MS = 120; // press slightly before landing still jumps
const MAX_JUMPS = 2;
/**
 * Auto step-up: while grounded, obstacles rising up to this much are climbed
 * without jumping. Drawn ink ramps are chopped into ~0.35m collider steps, so
 * players can run straight up their own drawings.
 */
const STEP_HEIGHT = 0.42;

const MAX_PITCH = THREE.MathUtils.degToRad(89);

/**
 * Kinematic first-person controller stepped at a fixed 60Hz.
 * `pos` is the FEET position (bottom-center of the AABB) — this is also the
 * position sent over the network and expected by RemotePlayers.
 */
export class PlayerController {
  readonly pos = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();

  yaw = 0;
  pitch = 0;

  private grounded = false;
  private simTime = 0;
  private lastGroundedTime = -Infinity;
  private jumpsUsed = 0;
  private readonly pendingEvents: MovementEvent[] = [];
  private lastFallVelocity = 0;

  constructor(private readonly colliders: readonly THREE.Box3[]) {}

  spawn(spawnPoints: readonly THREE.Vector3[]): void {
    const point = spawnPoints[Math.floor(Math.random() * spawnPoints.length)]!;
    this.pos.copy(point);
    this.prevPos.copy(point);
    this.vel.set(0, 0, 0);
    // Face the arena center.
    this.yaw = Math.atan2(point.x, point.z);
    this.pitch = 0;
    this.grounded = false;
    this.lastGroundedTime = -Infinity;
    this.jumpsUsed = 0;
    this.pendingEvents.length = 0;
  }

  applyLook(deltaYaw: number, deltaPitch: number): void {
    this.yaw += deltaYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + deltaPitch, -MAX_PITCH, MAX_PITCH);
  }

  /** Hard reposition (escape-room fall recovery). Keeps the current look. */
  teleport(point: THREE.Vector3): void {
    this.pos.copy(point);
    this.prevPos.copy(point);
    this.vel.set(0, 0, 0);
    this.grounded = false;
    this.lastGroundedTime = -Infinity;
    this.jumpsUsed = 0;
  }

  /**
   * Ink materialized inside the player: lift them onto its top surface (the
   * "ink elevator") instead of leaving them stuck inside solid geometry.
   */
  liftTo(topY: number): void {
    this.pos.y = topY + 0.002;
    this.prevPos.y = this.pos.y;
    if (this.vel.y < 0) this.vel.y = 0;
    this.grounded = true;
    this.lastGroundedTime = this.simTime;
    this.jumpsUsed = 0;
  }

  /** Drain one-shot movement events emitted during the last step. */
  drainEvents(): MovementEvent[] {
    if (this.pendingEvents.length === 0) return [];
    return this.pendingEvents.splice(0);
  }

  getHorizontalSpeed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  isGrounded(): boolean {
    return this.grounded;
  }

  getFallVelocity(): number {
    return this.lastFallVelocity;
  }

  /** One fixed physics step. Classic per-axis move-and-resolve: X, Z, then Y. */
  step(input: InputState, dt: number): void {
    this.simTime += dt;
    this.prevPos.copy(this.pos);
    this.lastFallVelocity = this.vel.y;

    // --- Horizontal acceleration toward the camera-yaw-relative wish velocity.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward = (-sin, -cos), right = (cos, -sin) for yaw around +Y.
    let wishX = -sin * input.moveY + cos * input.moveX;
    let wishZ = -cos * input.moveY - sin * input.moveX;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1) {
      wishX /= wishLen;
      wishZ /= wishLen;
    }
    const targetX = wishX * WALK_SPEED;
    const targetZ = wishZ * WALK_SPEED;

    const accel = (this.grounded ? GROUND_ACCEL : AIR_ACCEL) * dt;
    const dx = targetX - this.vel.x;
    const dz = targetZ - this.vel.z;
    const dLen = Math.hypot(dx, dz);
    if (dLen <= accel || dLen === 0) {
      this.vel.x = targetX;
      this.vel.z = targetZ;
    } else {
      this.vel.x += (dx / dLen) * accel;
      this.vel.z += (dz / dLen) * accel;
    }

    // --- Gravity and (buffered) jump with coyote time.
    this.vel.y = Math.max(this.vel.y - GRAVITY * dt, -MAX_FALL_SPEED);

    const jumpBuffered = performance.now() - input.jumpQueuedAt <= JUMP_BUFFER_MS;
    if (jumpBuffered) {
      const onGround = this.grounded || this.simTime - this.lastGroundedTime <= COYOTE_TIME;
      if (onGround && this.jumpsUsed === 0) {
        input.jumpQueuedAt = -Infinity;
        this.vel.y = JUMP_VELOCITY;
        this.grounded = false;
        this.lastGroundedTime = -Infinity;
        this.jumpsUsed = 1;
        this.pendingEvents.push('jump');
      } else if (!onGround && this.jumpsUsed === 1 && this.jumpsUsed < MAX_JUMPS) {
        input.jumpQueuedAt = -Infinity;
        this.vel.y = DOUBLE_JUMP_VELOCITY;
        this.jumpsUsed = 2;
        this.pendingEvents.push('doubleJump');
      }
      // If jumpsUsed === 2, buffered input is ignored (no third jump).
    }

    // --- Per-axis move and resolve against world AABBs (with auto step-up).
    this.pos.x += this.vel.x * dt;
    for (const box of this.colliders) {
      if (!this.overlaps(box)) continue;
      if (this.tryStepUp(box)) continue;
      if (this.vel.x > 0) this.pos.x = box.min.x - HALF_X;
      else if (this.vel.x < 0) this.pos.x = box.max.x + HALF_X;
      this.vel.x = 0;
    }

    this.pos.z += this.vel.z * dt;
    for (const box of this.colliders) {
      if (!this.overlaps(box)) continue;
      if (this.tryStepUp(box)) continue;
      if (this.vel.z > 0) this.pos.z = box.min.z - HALF_Z;
      else if (this.vel.z < 0) this.pos.z = box.max.z + HALF_Z;
      this.vel.z = 0;
    }

    const wasGrounded = this.grounded;
    this.pos.y += this.vel.y * dt;
    this.grounded = false;
    for (const box of this.colliders) {
      if (!this.overlaps(box)) continue;
      if (this.vel.y <= 0) {
        this.pos.y = box.max.y; // landed on top
        this.grounded = true;
      } else {
        this.pos.y = box.min.y - HEIGHT; // bumped head
      }
      this.vel.y = 0;
    }

    if (this.grounded) {
      if (!wasGrounded) {
        this.pendingEvents.push('land');
      }
      this.lastGroundedTime = this.simTime;
      this.jumpsUsed = 0;
    }
  }

  /**
   * Climb a low obstacle instead of colliding with it: lift onto its top when
   * grounded, the rise is within STEP_HEIGHT, and the lifted position is free.
   */
  private tryStepUp(box: THREE.Box3): boolean {
    if (!this.grounded || this.vel.y > 0.01) return false;
    const lift = box.max.y - this.pos.y;
    if (lift <= 0 || lift > STEP_HEIGHT) return false;
    const oldY = this.pos.y;
    this.pos.y = box.max.y + 1e-3;
    for (const other of this.colliders) {
      if (this.overlaps(other)) {
        this.pos.y = oldY;
        return false;
      }
    }
    return true;
  }

  private overlaps(box: THREE.Box3): boolean {
    return (
      this.pos.x - HALF_X < box.max.x &&
      this.pos.x + HALF_X > box.min.x &&
      this.pos.y < box.max.y &&
      this.pos.y + HEIGHT > box.min.y &&
      this.pos.z - HALF_Z < box.max.z &&
      this.pos.z + HALF_Z > box.min.z
    );
  }

  /** Eye position interpolated between the last two physics steps. */
  getEyePosition(alpha: number, out: THREE.Vector3): THREE.Vector3 {
    out.lerpVectors(this.prevPos, this.pos, alpha);
    out.y += EYE_HEIGHT;
    return out;
  }

  getNetworkState(): PlayerStateMsg {
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    return {
      pos: { x: round(this.pos.x), y: round(this.pos.y), z: round(this.pos.z) },
      yaw: round(this.yaw),
    };
  }
}

/** Exported for unit tests — run N fixed steps without rendering. */
export function simulateSteps(
  controller: PlayerController,
  input: InputState,
  steps: number,
  dt = 1 / 60,
): void {
  for (let i = 0; i < steps; i++) controller.step(input, dt);
}
