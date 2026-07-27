import * as THREE from 'three';
import { INK_THICKNESS } from '../../../../shared/constants';
import type { InkObjectMsg } from '../../../../shared/types';
import type { ParticlePool } from '../ParticlePool';

/** Collider chop length along a stroke (m). Short boxes approximate any slope. */
const CHOP = 0.45;
/** Horizontal collider padding (m) so drawn beams are comfortably walkable. */
const PAD_H = 0.3;
const PAD_V = INK_THICKNESS / 2;
/** Materialize glow: emissive decays from bright to a subtle permanent glow. */
const GLOW_TIME = 0.45;
const GLOW_REST = 0.14;
/** Drawings blink for their last moments before combat-mode expiry. */
const EXPIRY_WARN_MS = 3000;

const HIGHLIGHT_COLOR = new THREE.Color(0xffffff);

// Module-level scratch.
const _v = new THREE.Vector3();
const _color = new THREE.Color();

/** Ray vs AABB entry-t (same slab test as the weapon); Infinity on miss. */
function rayBoxT(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  box: THREE.Box3,
): number {
  let tMin = 0;
  let tMax = Infinity;
  if (Math.abs(dx) < 1e-12) {
    if (ox < box.min.x || ox > box.max.x) return Infinity;
  } else {
    const inv = 1 / dx;
    let t1 = (box.min.x - ox) * inv;
    let t2 = (box.max.x - ox) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
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
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
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
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return Infinity;
  }
  return tMin;
}

interface Entry {
  object: InkObjectMsg;
  group: THREE.Group;
  material: THREE.MeshLambertMaterial;
  geometries: THREE.BufferGeometry[];
  /** This object's boxes, spliced out of the shared collider array on removal. */
  boxes: THREE.Box3[];
  baseColor: THREE.Color;
  /** Materialize glow countdown (s). */
  glow: number;
  highlighted: boolean;
  fading: boolean;
}

/**
 * Client-side registry of materialized drawings. Builds the identical tube
 * meshes and AABB collider chains on every client from the broadcast stroke
 * data, and keeps the shared world collider array in sync so players can walk
 * on (and shoot against) the ink.
 */
export class InkObjects {
  private readonly entries = new Map<number, Entry>();

  constructor(
    private readonly scene: THREE.Scene,
    /** The live world collider array — ink boxes are pushed/spliced in place. */
    private readonly colliders: THREE.Box3[],
    private readonly particles: ParticlePool,
  ) {}

  get count(): number {
    return this.entries.size;
  }

  /**
   * Materialize a drawing. Returns the new collider boxes so the caller can
   * resolve overlaps with the local player (the "ink elevator" lift).
   */
  add(object: InkObjectMsg, colorHex: string): readonly THREE.Box3[] {
    if (this.entries.has(object.id)) return [];

    const origin = _v.set(object.origin.x, object.origin.y, object.origin.z).clone();
    const right = new THREE.Vector3(object.right.x, object.right.y, object.right.z);
    const up = new THREE.Vector3(object.up.x, object.up.y, object.up.z);

    const baseColor = new THREE.Color(colorHex);
    const material = new THREE.MeshLambertMaterial({ color: baseColor });
    material.emissive.copy(baseColor);
    material.emissiveIntensity = 1;

    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    const boxes: THREE.Box3[] = [];

    for (const stroke of object.strokes) {
      if (stroke.length < 2) continue;
      const worldPoints = stroke.map((p) =>
        new THREE.Vector3()
          .copy(origin)
          .addScaledVector(right, p.x)
          .addScaledVector(up, p.y),
      );

      const curve = new THREE.CatmullRomCurve3(worldPoints, false, 'centripetal', 0.5);
      const segments = Math.min(96, Math.max(6, worldPoints.length * 4));
      const geometry = new THREE.TubeGeometry(curve, segments, INK_THICKNESS / 2, 6, false);
      geometries.push(geometry);
      group.add(new THREE.Mesh(geometry, material));

      // Collider chain: chop the polyline into short AABBs so any slope is
      // approximated well enough for the kinematic controller to walk on.
      for (let i = 1; i < worldPoints.length; i++) {
        const a = worldPoints[i - 1]!;
        const b = worldPoints[i]!;
        const len = a.distanceTo(b);
        const pieces = Math.max(1, Math.ceil(len / CHOP));
        for (let k = 0; k < pieces; k++) {
          const t0 = k / pieces;
          const t1 = (k + 1) / pieces;
          const x0 = a.x + (b.x - a.x) * t0;
          const y0 = a.y + (b.y - a.y) * t0;
          const z0 = a.z + (b.z - a.z) * t0;
          const x1 = a.x + (b.x - a.x) * t1;
          const y1 = a.y + (b.y - a.y) * t1;
          const z1 = a.z + (b.z - a.z) * t1;
          boxes.push(
            new THREE.Box3(
              new THREE.Vector3(Math.min(x0, x1) - PAD_H, Math.min(y0, y1) - PAD_V, Math.min(z0, z1) - PAD_H),
              new THREE.Vector3(Math.max(x0, x1) + PAD_H, Math.max(y0, y1) + PAD_V, Math.max(z0, z1) + PAD_H),
            ),
          );
        }
      }

      // Materialize sparkle along the stroke.
      const sparkles = Math.min(16, Math.max(4, Math.round(curve.getLength() * 2)));
      _color.copy(baseColor).lerp(HIGHLIGHT_COLOR, 0.5);
      for (let s = 0; s < sparkles; s++) {
        curve.getPoint(s / Math.max(1, sparkles - 1), _v);
        this.particles.spawn(
          _v.x, _v.y, _v.z,
          (Math.random() - 0.5) * 0.8,
          0.6 + Math.random() * 1.0,
          (Math.random() - 0.5) * 0.8,
          _color.r, _color.g, _color.b,
          0.05,
          0.4,
        );
      }
    }

    this.scene.add(group);
    this.colliders.push(...boxes);
    this.entries.set(object.id, {
      object,
      group,
      material,
      geometries,
      boxes,
      baseColor,
      glow: GLOW_TIME,
      highlighted: false,
      fading: false,
    });
    return boxes;
  }

  remove(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.scene.remove(entry.group);
    for (const box of entry.boxes) {
      const index = this.colliders.indexOf(box);
      if (index !== -1) this.colliders.splice(index, 1);
    }
    for (const g of entry.geometries) g.dispose();
    entry.material.dispose();

    // A little puff where it stood (center of the first collider).
    const box = entry.boxes[0];
    if (box) {
      const cx = (box.min.x + box.max.x) / 2;
      const cy = (box.min.y + box.max.y) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      for (let i = 0; i < 5; i++) {
        this.particles.spawn(
          cx, cy, cz,
          (Math.random() - 0.5) * 1.2,
          0.4 + Math.random() * 0.8,
          (Math.random() - 0.5) * 1.2,
          entry.baseColor.r, entry.baseColor.g, entry.baseColor.b,
          0.05,
          0.3,
        );
      }
    }
  }

  /** Glow decay + expiry blink. Call once per frame. */
  update(dt: number, nowEpochMs: number): void {
    for (const entry of this.entries.values()) {
      if (entry.glow > 0) {
        entry.glow = Math.max(0, entry.glow - dt);
        const t = entry.glow / GLOW_TIME;
        entry.material.emissiveIntensity = GLOW_REST + (1 - GLOW_REST) * t;
      } else if (entry.highlighted) {
        // Erase-target pulse.
        entry.material.emissiveIntensity = 0.45 + 0.35 * Math.sin(performance.now() / 90);
      } else if (entry.material.emissiveIntensity !== GLOW_REST) {
        entry.material.emissiveIntensity = GLOW_REST;
      }

      const expiresAt = entry.object.expiresAt;
      if (expiresAt !== null) {
        const remaining = expiresAt - nowEpochMs;
        if (remaining < EXPIRY_WARN_MS) {
          if (!entry.fading) {
            entry.fading = true;
            entry.material.transparent = true;
          }
          const blink = 0.45 + 0.35 * Math.sin(performance.now() / 110);
          entry.material.opacity = Math.max(0.25, Math.min(1, blink));
        }
      }
    }
  }

  /** Nearest ink object hit by the ray, or null. Used by the eraser. */
  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
  ): { id: number; ownerId: string; distance: number } | null {
    let bestT = maxDist;
    let best: Entry | null = null;
    for (const entry of this.entries.values()) {
      for (const box of entry.boxes) {
        const t = rayBoxT(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, box);
        if (t < bestT) {
          bestT = t;
          best = entry;
        }
      }
    }
    return best ? { id: best.object.id, ownerId: best.object.ownerId, distance: bestT } : null;
  }

  /** True when any ink collider intersects the box (pressure-plate sensor). */
  intersectsBox(box: THREE.Box3): boolean {
    for (const entry of this.entries.values()) {
      for (const b of entry.boxes) {
        if (b.intersectsBox(box)) return true;
      }
    }
    return false;
  }

  /** Highlight exactly one object (the erase target); null clears. */
  setHighlight(id: number | null): void {
    for (const entry of this.entries.values()) {
      entry.highlighted = entry.object.id === id;
    }
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) {
      const entry = this.entries.get(id)!;
      this.entries.delete(id);
      this.scene.remove(entry.group);
      for (const box of entry.boxes) {
        const index = this.colliders.indexOf(box);
        if (index !== -1) this.colliders.splice(index, 1);
      }
      for (const g of entry.geometries) g.dispose();
      entry.material.dispose();
    }
  }
}
