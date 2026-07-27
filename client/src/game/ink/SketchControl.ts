import * as THREE from 'three';
import {
  INK_MAX_POINTS_PER_STROKE,
  INK_MAX_STROKES,
  INK_MIN_TOTAL_LENGTH,
  INK_SKETCH_HALF_H,
  INK_SKETCH_HALF_W,
} from '../../../../shared/constants';
import type { InkPoint, Vec3 } from '../../../../shared/types';
import { simplifyStroke, strokesLength } from './rdp';

const ANCHOR_MIN = 2.0; // m in front of the camera
const ANCHOR_MAX = 5.5;
const ANCHOR_DEFAULT = 3.5;
const ANCHOR_BACKOFF = 0.4; // pulled back from a world hit so ink doesn't clip in
const ANCHOR_MAX_LIFT = 1.5; // m above eye height the anchor may float
const PEN_SENS = 0.0032; // m of pen travel per px of locked-mouse movement
const MIN_POINT_SPACING = 0.02; // m between captured raw points
const MAX_RAW_POINTS = 300;
const RDP_EPSILON = 0.045;

interface RawStroke {
  points: InkPoint[];
  length: number;
}

export interface SketchCallbacks {
  /** Send the drawing. Return true to close the sketch (accepted locally). */
  tryCast(origin: Vec3, right: Vec3, up: Vec3, strokes: InkPoint[][], cost: number): boolean;
  /** Escape mode: is this anchor inside the key-drawing zone by the door? */
  inKeyZone(origin: THREE.Vector3): boolean;
  /** Escape mode: attempt the key. True = recognized (closes, no ink spent). */
  tryKey(strokes: InkPoint[][]): boolean;
  getInk(): number;
  onToast(message: string): void;
  /** Fired on open/close so the game can reroute look input and gate firing. */
  onOpenChange(open: boolean): void;
}

function makeGridTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 176;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(0, 229, 255, 0.05)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
  ctx.lineWidth = 1;
  const step = 16;
  for (let x = 0; x <= w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.9)';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
  return new THREE.CanvasTexture(canvas);
}

function makePenTexture(): THREE.CanvasTexture {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(0, 229, 255, 0.9)';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 4, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(canvas);
}

/**
 * Sketch mode: a translucent world-anchored drawing plane. The pen is driven
 * by locked-mouse deltas on desktop and by absolute pointer raycasts on touch
 * (and unlocked desktop). Raw strokes are previewed as lines, then simplified
 * (RDP) and cast as an ink:draw — or checked against the key recognizer when
 * drawn in the escape door zone.
 */
export class SketchControl {
  private readonly group = new THREE.Group();
  private readonly planeMesh: THREE.Mesh;
  private readonly penSprite: THREE.Sprite;
  private readonly previewLines: THREE.Line[] = [];
  private readonly previewPositions: Float32Array[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  private readonly origin = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly normal = new THREE.Vector3();

  private readonly ui: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly costEl: HTMLElement;
  private readonly castBtn: HTMLButtonElement;
  private readonly captureEl: HTMLElement;

  private isOpen = false;
  private keyZone = false;
  private penX = 0;
  private penY = 0;
  private penDown = false;
  private activePointerId: number | null = null;
  private readonly strokes: RawStroke[] = [];
  private current: RawStroke | null = null;
  private costDirty = true;

  // Scratch
  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly basisMatrix = new THREE.Matrix4();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly colliders: readonly THREE.Box3[],
    container: HTMLElement,
    private readonly callbacks: SketchCallbacks,
  ) {
    // --- 3D pieces
    const gridTexture = makeGridTexture();
    gridTexture.colorSpace = THREE.SRGBColorSpace;
    const planeGeometry = new THREE.PlaneGeometry(INK_SKETCH_HALF_W * 2, INK_SKETCH_HALF_H * 2);
    const planeMaterial = new THREE.MeshBasicMaterial({
      map: gridTexture,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.planeMesh = new THREE.Mesh(planeGeometry, planeMaterial);
    this.planeMesh.renderOrder = 6;
    this.disposables.push(gridTexture, planeGeometry, planeMaterial);

    const penTexture = makePenTexture();
    const penMaterial = new THREE.SpriteMaterial({
      map: penTexture,
      transparent: true,
      depthTest: false,
      fog: false,
    });
    this.penSprite = new THREE.Sprite(penMaterial);
    this.penSprite.scale.setScalar(0.16);
    this.penSprite.renderOrder = 8;
    this.disposables.push(penTexture, penMaterial);

    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      fog: false,
    });
    this.disposables.push(lineMaterial);
    for (let i = 0; i < INK_MAX_STROKES; i++) {
      const positions = new Float32Array(MAX_RAW_POINTS * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setDrawRange(0, 0);
      const line = new THREE.Line(geometry, lineMaterial);
      line.renderOrder = 7;
      line.frustumCulled = false;
      this.previewLines.push(line);
      this.previewPositions.push(positions);
      this.disposables.push(geometry);
      this.group.add(line);
    }

    this.group.add(this.planeMesh, this.penSprite);
    this.group.visible = false;
    this.scene.add(this.group);

    // --- DOM overlay
    this.ui = document.createElement('div');
    this.ui.className = 'sketch-ui';
    this.ui.hidden = true;
    this.ui.dataset['sketch'] = '';
    this.ui.innerHTML = `
      <div class="sketch-capture" data-sketch-capture></div>
      <div class="sketch-top">
        <div class="chip sketch-title" data-sketch-title>SKETCH MODE</div>
        <div class="chip sketch-cost" data-sketch-cost></div>
      </div>
      <div class="sketch-actions">
        <button type="button" class="sketch-btn" data-sketch-undo>UNDO</button>
        <button type="button" class="sketch-btn" data-sketch-cancel>CANCEL</button>
        <button type="button" class="sketch-btn sketch-btn-cast" data-sketch-cast>CAST</button>
      </div>
    `;
    container.appendChild(this.ui);
    this.titleEl = this.ui.querySelector<HTMLElement>('[data-sketch-title]')!;
    this.costEl = this.ui.querySelector<HTMLElement>('[data-sketch-cost]')!;
    this.castBtn = this.ui.querySelector<HTMLButtonElement>('[data-sketch-cast]')!;
    this.captureEl = this.ui.querySelector<HTMLElement>('[data-sketch-capture]')!;

    this.ui.querySelector<HTMLButtonElement>('[data-sketch-undo]')!.addEventListener('click', () => this.undo());
    this.ui.querySelector<HTMLButtonElement>('[data-sketch-cancel]')!.addEventListener('click', () => this.cancel());
    this.castBtn.addEventListener('click', () => this.cast());
  }

  get active(): boolean {
    return this.isOpen;
  }

  /** Anchor the plane along the camera ray and enter sketch mode. */
  open(): void {
    if (this.isOpen) return;

    const camPos = this.camera.position;
    const dir = this.camera.getWorldDirection(this.scratchA);

    // Nearest world hit along the aim ray decides the anchor distance.
    let tHit = Infinity;
    for (const box of this.colliders) {
      const t = this.rayBox(camPos, dir, box);
      if (t < tHit) tHit = t;
    }
    const dist =
      tHit === Infinity
        ? ANCHOR_DEFAULT
        : Math.min(ANCHOR_MAX, Math.max(ANCHOR_MIN, tHit - ANCHOR_BACKOFF));

    this.origin.copy(camPos).addScaledVector(dir, dist);
    this.origin.y = Math.min(Math.max(this.origin.y, 0.9), camPos.y + ANCHOR_MAX_LIFT);
    this.origin.x = Math.min(Math.max(this.origin.x, -58), 58);
    this.origin.z = Math.min(Math.max(this.origin.z, -58), 58);

    // Upright plane, facing the player: right is horizontal, up is world-up.
    const fx = dir.x;
    const fz = dir.z;
    const fLen = Math.hypot(fx, fz) || 1;
    this.right.set(-fz / fLen, 0, fx / fLen);
    this.normal.crossVectors(this.right, this.up); // points back toward the player
    this.basisMatrix.makeBasis(this.right, this.up, this.normal);
    // The group itself stays at the identity: pen + preview lines are written
    // in world coordinates; only the plane mesh carries the anchor transform.
    this.planeMesh.position.copy(this.origin);
    this.planeMesh.quaternion.setFromRotationMatrix(this.basisMatrix);

    this.keyZone = this.callbacks.inKeyZone(this.origin);
    this.titleEl.textContent = this.keyZone ? 'DRAW THE KEY' : 'SKETCH MODE';
    this.titleEl.classList.toggle('sketch-title-key', this.keyZone);

    this.penX = 0;
    this.penY = 0;
    this.penDown = false;
    this.activePointerId = null;
    this.strokes.length = 0;
    this.current = null;
    this.costDirty = true;
    for (const line of this.previewLines) line.geometry.setDrawRange(0, 0);

    this.isOpen = true;
    this.group.visible = true;
    this.ui.hidden = false;
    this.syncPen();

    this.captureEl.addEventListener('pointerdown', this.handlePointerDown);
    this.captureEl.addEventListener('pointermove', this.handlePointerMove);
    this.captureEl.addEventListener('pointerup', this.handlePointerEnd);
    this.captureEl.addEventListener('pointercancel', this.handlePointerEnd);
    document.addEventListener('mousedown', this.handleLockedMouseDown);
    document.addEventListener('mouseup', this.handleLockedMouseUp);
    window.addEventListener('keydown', this.handleKeyDown);

    this.callbacks.onOpenChange(true);
  }

  cancel(): void {
    this.close();
  }

  /** Simplify, validate and send the current drawing (or try the key). */
  cast(): void {
    if (!this.isOpen) return;
    this.endStroke();

    const simplified: InkPoint[][] = [];
    for (const stroke of this.strokes) {
      let epsilon = RDP_EPSILON;
      let points = simplifyStroke(stroke.points, epsilon);
      while (points.length > INK_MAX_POINTS_PER_STROKE && epsilon < 1) {
        epsilon *= 1.6;
        points = simplifyStroke(stroke.points, epsilon);
      }
      if (points.length >= 2) simplified.push(points.slice(0, INK_MAX_POINTS_PER_STROKE));
    }

    if (simplified.length === 0) {
      this.callbacks.onToast('Draw something first!');
      return;
    }

    if (this.keyZone) {
      // Key attempts are free: recognized -> the door opens; otherwise retry.
      if (this.callbacks.tryKey(simplified)) {
        this.close();
      } else {
        this.callbacks.onToast("That doesn't look like the key — copy the glowing mural.");
      }
      return;
    }

    const cost = strokesLength(simplified);
    if (cost < INK_MIN_TOTAL_LENGTH) {
      this.callbacks.onToast('Draw something first!');
      return;
    }
    if (cost > this.callbacks.getInk() + 0.01) {
      this.callbacks.onToast('Not enough ink — erase something or wait for it to refill.');
      return;
    }

    const accepted = this.callbacks.tryCast(
      { x: this.origin.x, y: this.origin.y, z: this.origin.z },
      { x: this.right.x, y: this.right.y, z: this.right.z },
      { x: this.up.x, y: this.up.y, z: this.up.z },
      simplified,
      cost,
    );
    if (accepted) this.close();
  }

  undo(): void {
    this.endStroke();
    const removed = this.strokes.pop();
    if (removed) {
      this.previewLines[this.strokes.length]!.geometry.setDrawRange(0, 0);
      this.costDirty = true;
    }
  }

  /** Locked-mouse pen movement (raw pixel deltas routed from the game). */
  penDelta(dxPx: number, dyPx: number): void {
    if (!this.isOpen) return;
    this.movePen(this.penX + dxPx * PEN_SENS, this.penY - dyPx * PEN_SENS);
  }

  /** Per-frame upkeep: cost readout (cheap, only when dirty). */
  update(): void {
    if (!this.isOpen || !this.costDirty) return;
    this.costDirty = false;
    let cost = 0;
    for (const stroke of this.strokes) cost += stroke.length;
    if (this.current) cost += this.current.length;
    const ink = this.callbacks.getInk();
    this.costEl.textContent = this.keyZone
      ? 'FREE — KEY ATTEMPT'
      : `COST ${cost.toFixed(1)}m · INK ${ink.toFixed(1)}m`;
    this.costEl.classList.toggle('sketch-cost-over', !this.keyZone && cost > ink + 0.01);
  }

  markCostDirty(): void {
    this.costDirty = true;
  }

  dispose(): void {
    this.close();
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose();
    this.ui.remove();
  }

  // ---------------------------------------------------------------- internals

  private close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.group.visible = false;
    this.ui.hidden = true;
    this.captureEl.removeEventListener('pointerdown', this.handlePointerDown);
    this.captureEl.removeEventListener('pointermove', this.handlePointerMove);
    this.captureEl.removeEventListener('pointerup', this.handlePointerEnd);
    this.captureEl.removeEventListener('pointercancel', this.handlePointerEnd);
    document.removeEventListener('mousedown', this.handleLockedMouseDown);
    document.removeEventListener('mouseup', this.handleLockedMouseUp);
    window.removeEventListener('keydown', this.handleKeyDown);
    this.callbacks.onOpenChange(false);
  }

  private get lockActive(): boolean {
    return document.pointerLockElement !== null;
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Enter') {
      e.preventDefault();
      this.cast();
    } else if (e.code === 'Escape') {
      // Also fires via pointerlockchange -> game cancel when the lock drops.
      this.cancel();
    } else if (e.code === 'Backspace') {
      e.preventDefault();
      this.undo();
    }
  };

  private handleLockedMouseDown = (e: MouseEvent): void => {
    if (!this.lockActive || e.button !== 0) return;
    this.startStroke();
  };

  private handleLockedMouseUp = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.endStroke();
  };

  private handlePointerDown = (e: PointerEvent): void => {
    if (this.lockActive || this.activePointerId !== null) return;
    e.preventDefault();
    this.activePointerId = e.pointerId;
    try {
      this.captureEl.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort.
    }
    const p = this.screenToPlane(e.clientX, e.clientY);
    if (p) {
      this.movePen(p.x, p.y);
      this.startStroke();
    }
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (this.lockActive || e.pointerId !== this.activePointerId) return;
    e.preventDefault();
    const p = this.screenToPlane(e.clientX, e.clientY);
    if (p) this.movePen(p.x, p.y);
  };

  private handlePointerEnd = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointerId) return;
    e.preventDefault();
    this.activePointerId = null;
    this.endStroke();
  };

  /** Raycast a screen point onto the sketch plane; null when parallel/behind. */
  private screenToPlane(clientX: number, clientY: number): InkPoint | null {
    const ndcX = (clientX / window.innerWidth) * 2 - 1;
    const ndcY = -(clientY / window.innerHeight) * 2 + 1;
    const point = this.scratchA.set(ndcX, ndcY, 0.5).unproject(this.camera);
    const dir = point.sub(this.camera.position).normalize();
    const denom = dir.dot(this.normal);
    if (Math.abs(denom) < 1e-4) return null;
    const toPlane = this.scratchB.copy(this.origin).sub(this.camera.position);
    const t = toPlane.dot(this.normal) / denom;
    if (t <= 0) return null;
    const hit = this.scratchB.copy(this.camera.position).addScaledVector(dir, t).sub(this.origin);
    return { x: hit.dot(this.right), y: hit.y };
  }

  private movePen(x: number, y: number): void {
    this.penX = Math.min(Math.max(x, -INK_SKETCH_HALF_W), INK_SKETCH_HALF_W);
    this.penY = Math.min(Math.max(y, -INK_SKETCH_HALF_H), INK_SKETCH_HALF_H);
    this.syncPen();
    if (this.penDown && this.current) this.appendPoint();
  }

  private syncPen(): void {
    this.penSprite.position
      .copy(this.origin)
      .addScaledVector(this.right, this.penX)
      .addScaledVector(this.up, this.penY);
  }

  private startStroke(): void {
    if (!this.isOpen || this.penDown) return;
    if (this.strokes.length >= INK_MAX_STROKES) {
      this.callbacks.onToast(`Max ${INK_MAX_STROKES} strokes — cast it or undo one.`);
      return;
    }
    this.penDown = true;
    this.current = { points: [{ x: this.penX, y: this.penY }], length: 0 };
    this.writePreviewPoint(this.strokes.length, 0, this.penX, this.penY);
    this.previewLines[this.strokes.length]!.geometry.setDrawRange(0, 1);
    this.costDirty = true;
  }

  private appendPoint(): void {
    const stroke = this.current!;
    const last = stroke.points[stroke.points.length - 1]!;
    const d = Math.hypot(this.penX - last.x, this.penY - last.y);
    if (d < MIN_POINT_SPACING || stroke.points.length >= MAX_RAW_POINTS) return;
    stroke.points.push({ x: this.penX, y: this.penY });
    stroke.length += d;
    const strokeIndex = this.strokes.length;
    this.writePreviewPoint(strokeIndex, stroke.points.length - 1, this.penX, this.penY);
    this.previewLines[strokeIndex]!.geometry.setDrawRange(0, stroke.points.length);
    this.costDirty = true;
  }

  private endStroke(): void {
    if (!this.penDown) return;
    this.penDown = false;
    const stroke = this.current;
    this.current = null;
    if (!stroke) return;
    if (stroke.points.length < 2 || stroke.length < 0.05) {
      // Too small to matter — clear its preview.
      this.previewLines[this.strokes.length]!.geometry.setDrawRange(0, 0);
      this.costDirty = true;
      return;
    }
    this.strokes.push(stroke);
    this.costDirty = true;
  }

  private writePreviewPoint(strokeIndex: number, pointIndex: number, px: number, py: number): void {
    const positions = this.previewPositions[strokeIndex]!;
    const world = this.scratchA
      .copy(this.origin)
      .addScaledVector(this.right, px)
      .addScaledVector(this.up, py)
      // Nudge toward the player so the line never z-fights the plane.
      .addScaledVector(this.normal, 0.01);
    positions[pointIndex * 3] = world.x;
    positions[pointIndex * 3 + 1] = world.y;
    positions[pointIndex * 3 + 2] = world.z;
    const attr = this.previewLines[strokeIndex]!.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
  }

  private rayBox(origin: THREE.Vector3, dir: THREE.Vector3, box: THREE.Box3): number {
    let tMin = 0;
    let tMax = Infinity;
    const o = [origin.x, origin.y, origin.z] as const;
    const d = [dir.x, dir.y, dir.z] as const;
    const min = [box.min.x, box.min.y, box.min.z] as const;
    const max = [box.max.x, box.max.y, box.max.z] as const;
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(d[axis]!) < 1e-12) {
        if (o[axis]! < min[axis]! || o[axis]! > max[axis]!) return Infinity;
      } else {
        const inv = 1 / d[axis]!;
        let t1 = (min[axis]! - o[axis]!) * inv;
        let t2 = (max[axis]! - o[axis]!) * inv;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) return Infinity;
      }
    }
    return tMin;
  }
}
