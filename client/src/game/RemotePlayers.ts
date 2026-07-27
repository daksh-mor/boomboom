import * as THREE from 'three';
import type { PlayerInfo, PlayerStateBroadcast, Vec3 } from '../../../shared/types';
import type { BlobShadowHandle, BlobShadows } from './BlobShadow';

/** Render remote players this far in the past so 15Hz updates interpolate smoothly. */
const RENDER_DELAY_MS = 100;
const MAX_BUFFER = 40;

const CAPSULE_RADIUS = 0.4;
const CAPSULE_CYLINDER = 1.0; // total height = cylinder + 2r = 1.8m
const NAME_TAG_HEIGHT = 2.2;

interface Snapshot {
  t: number;
  pos: Vec3;
  yaw: number;
}

const DAMAGE_FLASH_MS = 120;
const DAMAGE_FLASH_COLOR = 0xff6655; // reddish-white emissive pulse

interface Entry {
  info: PlayerInfo;
  group: THREE.Group;
  blob: BlobShadowHandle;
  buffer: Snapshot[];
  bodyMaterial: THREE.MeshLambertMaterial;
  alive: boolean;
  /** performance.now() when the damage flash ends; 0 = not flashing. */
  flashUntil: number;
  disposables: Array<{ dispose(): void }>;
}

function shortestAngleDelta(from: number, to: number): number {
  const tau = Math.PI * 2;
  let delta = (to - from) % tau;
  if (delta > Math.PI) delta -= tau;
  if (delta < -Math.PI) delta += tau;
  return delta;
}

function makeNameTag(name: string): { sprite: THREE.Sprite; disposables: Array<{ dispose(): void }> } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '700 44px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.font = font;
  const padX = 30;
  const height = 88;
  const width = Math.ceil(ctx.measureText(name).width) + padX * 2;
  canvas.width = width;
  canvas.height = height;

  // Dark rounded pill with white text.
  ctx.fillStyle = 'rgba(10, 13, 20, 0.72)';
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, height / 2);
  ctx.fill();
  ctx.font = font;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, width / 2, height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  const worldHeight = 0.42;
  sprite.scale.set(worldHeight * (width / height), worldHeight, 1);
  sprite.position.y = NAME_TAG_HEIGHT;
  sprite.renderOrder = 3; // always drawn over blob shadows and particles
  return { sprite, disposables: [texture, material] };
}

export class RemotePlayers {
  private readonly entries = new Map<string, Entry>();
  private readonly capsuleGeometry = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_CYLINDER, 4, 12);
  private readonly visorGeometry = new THREE.BoxGeometry(0.36, 0.14, 0.16);
  private readonly visorMaterial = new THREE.MeshLambertMaterial({ color: '#1c2230' });

  constructor(
    private readonly scene: THREE.Scene,
    private readonly selfId: string,
    private readonly blobShadows: BlobShadows,
  ) {}

  syncRoster(players: readonly PlayerInfo[]): void {
    for (const player of players) this.add(player);
  }

  add(info: PlayerInfo): void {
    if (info.id === this.selfId || this.entries.has(info.id)) return;

    const group = new THREE.Group();
    const disposables: Array<{ dispose(): void }> = [];

    const bodyMaterial = new THREE.MeshLambertMaterial({ color: info.color });
    disposables.push(bodyMaterial);
    const body = new THREE.Mesh(this.capsuleGeometry, bodyMaterial);
    body.position.y = CAPSULE_RADIUS + CAPSULE_CYLINDER / 2; // feet at group origin
    group.add(body);

    // Small dark visor so the facing direction is visible (forward is -Z).
    const visor = new THREE.Mesh(this.visorGeometry, this.visorMaterial);
    visor.position.set(0, 1.5, -(CAPSULE_RADIUS - 0.06));
    group.add(visor);

    const tag = makeNameTag(info.name);
    disposables.push(...tag.disposables);
    group.add(tag.sprite);

    group.visible = false; // until the first state snapshot arrives
    this.scene.add(group);
    this.entries.set(info.id, {
      info,
      group,
      blob: this.blobShadows.create(),
      buffer: [],
      bodyMaterial,
      alive: true,
      flashUntil: 0,
      disposables,
    });
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.scene.remove(entry.group);
    entry.blob.dispose();
    for (const d of entry.disposables) d.dispose();
  }

  /** Flash a player reddish-white for ~120ms (they just took damage). */
  flashDamage(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || !entry.alive) return;
    entry.bodyMaterial.emissive.setHex(DAMAGE_FLASH_COLOR);
    entry.flashUntil = performance.now() + DAMAGE_FLASH_MS;
  }

  /** Hide a dead player (mesh, name tag and blob) or bring them back on respawn. */
  setAlive(id: string, alive: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || entry.alive === alive) return;
    entry.alive = alive;
    // Drop stale snapshots either way: after a respawn the first fresh states
    // place the player at their new spawn instead of gliding from the corpse.
    entry.buffer.length = 0;
    if (!alive) {
      entry.group.visible = false;
      entry.blob.setVisible(false);
      entry.bodyMaterial.emissive.setHex(0);
      entry.flashUntil = 0;
    } else {
      entry.blob.setVisible(true); // repositioned on the next state snapshot
    }
  }

  /** Iterate alive, visible remote players (feet positions) for hit testing. */
  forEachTarget(cb: (id: string, feetX: number, feetY: number, feetZ: number) => void): void {
    for (const entry of this.entries.values()) {
      if (!entry.alive || !entry.group.visible) continue;
      const p = entry.group.position;
      cb(entry.info.id, p.x, p.y, p.z);
    }
  }

  /** Push a server broadcast into each player's snapshot buffer. */
  pushStates(states: readonly PlayerStateBroadcast[]): void {
    const now = performance.now();
    for (const state of states) {
      if (state.id === this.selfId) continue;
      const entry = this.entries.get(state.id);
      if (!entry || !entry.alive) continue; // skip unknown ids and race-y post-death states
      entry.buffer.push({ t: now, pos: state.pos, yaw: state.yaw });
      if (entry.buffer.length > MAX_BUFFER) entry.buffer.shift();
    }
  }

  /** Interpolate every remote player at (now - 100ms). Call once per frame. */
  update(nowMs: number): void {
    const renderTime = nowMs - RENDER_DELAY_MS;
    for (const entry of this.entries.values()) {
      if (entry.flashUntil !== 0 && nowMs >= entry.flashUntil) {
        entry.flashUntil = 0;
        entry.bodyMaterial.emissive.setHex(0);
      }
      if (!entry.alive) continue;
      const buf = entry.buffer;
      if (buf.length === 0) continue;
      entry.group.visible = true;

      // Drop snapshots that are entirely in the past, keeping one before renderTime.
      while (buf.length >= 2 && buf[1]!.t <= renderTime) buf.shift();

      const a = buf[0]!;
      if (buf.length === 1 || renderTime <= a.t) {
        // Buffer underrun (or ahead of first snapshot): hold the boundary state.
        entry.group.position.set(a.pos.x, a.pos.y, a.pos.z);
        entry.group.rotation.y = a.yaw;
      } else {
        const b = buf[1]!;
        const k = THREE.MathUtils.clamp((renderTime - a.t) / (b.t - a.t), 0, 1);
        entry.group.position.set(
          a.pos.x + (b.pos.x - a.pos.x) * k,
          a.pos.y + (b.pos.y - a.pos.y) * k,
          a.pos.z + (b.pos.z - a.pos.z) * k,
        );
        entry.group.rotation.y = a.yaw + shortestAngleDelta(a.yaw, b.yaw) * k;
      }

      const p = entry.group.position;
      entry.blob.update(p.x, p.y, p.z); // group origin is the feet
    }
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
    this.capsuleGeometry.dispose();
    this.visorGeometry.dispose();
    this.visorMaterial.dispose();
  }
}
