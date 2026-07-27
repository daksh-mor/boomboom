import * as THREE from 'three';

const BLOB_SIZE = 1.1; // m
const BLOB_OPACITY = 0.35;
const SURFACE_OFFSET = 0.02; // m above the surface, avoids z-fighting
const SURFACE_EPS = 0.01; // tolerance when matching the surface under the feet
const FADE_HEIGHT = 8; // m of air below the feet for the full fade

function createBlobTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
  gradient.addColorStop(0.55, 'rgba(0, 0, 0, 0.65)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

export interface BlobShadowHandle {
  /** Place the blob under a player's feet position (world space). */
  update(x: number, feetY: number, z: number): void;
  /** Hide/show the blob (e.g. while its player is dead). Hidden blobs ignore update(). */
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Cheap fake shadows, identical on every device (real-time shadow maps are
 * disabled everywhere): a shared radial-gradient texture on one small plane
 * per player, dropped straight down onto the highest world-collider top
 * surface at or below the feet, fading and shrinking slightly with height.
 */
export class BlobShadows {
  private readonly texture = createBlobTexture();
  private readonly geometry = new THREE.PlaneGeometry(BLOB_SIZE, BLOB_SIZE);
  private readonly handles = new Set<BlobShadowHandle>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly colliders: readonly THREE.Box3[],
  ) {}

  /** One blob per player. Invisible until its first update(). */
  create(): BlobShadowHandle {
    // Materials are per-blob (opacity fades individually); texture/geometry
    // and the compiled shader program are shared.
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: BLOB_OPACITY,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 1; // above the ground within the transparent pass
    mesh.visible = false;
    this.scene.add(mesh);

    const colliders = this.colliders;
    let hidden = false;
    const handle: BlobShadowHandle = {
      update(x: number, feetY: number, z: number): void {
        if (hidden) return;
        // Highest collider top at or below the feet that contains (x, z).
        // ~30 boxes — a linear scan beats any raycasting machinery.
        let surfaceY = -Infinity;
        for (const box of colliders) {
          if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue;
          const top = box.max.y;
          if (top <= feetY + SURFACE_EPS && top > surfaceY) surfaceY = top;
        }
        if (surfaceY === -Infinity) {
          mesh.visible = false;
          return;
        }
        const height = Math.max(0, feetY - surfaceY);
        const k = Math.min(1, height / FADE_HEIGHT);
        mesh.visible = true;
        mesh.position.set(x, surfaceY + SURFACE_OFFSET, z);
        mesh.scale.setScalar(1 - 0.35 * k);
        material.opacity = BLOB_OPACITY * (1 - 0.5 * k);
      },
      setVisible(visible: boolean): void {
        hidden = !visible;
        if (hidden) mesh.visible = false;
        // When shown again the next update() re-places and re-shows it.
      },
      dispose: () => {
        this.scene.remove(mesh);
        material.dispose();
        this.handles.delete(handle);
      },
    };
    this.handles.add(handle);
    return handle;
  }

  dispose(): void {
    for (const handle of [...this.handles]) handle.dispose();
    this.geometry.dispose();
    this.texture.dispose();
  }
}
