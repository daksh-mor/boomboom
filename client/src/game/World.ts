import * as THREE from 'three';

export interface WorldLighting {
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  fogNear: number;
  fogFar: number;
}

/**
 * Party "rising ink" flood parameters (mirrors PartyRoundParams.lava).
 * Height is closed-form and identical on the server:
 * height(now) = startY + riseRate*t + 0.5*accel*t^2, t in seconds since startAt.
 */
export interface LavaParams {
  startY: number;
  riseRate: number;
  accel: number;
  startAt: number;
}

/**
 * ~40x40m arena. Playable area spans x/z in [-20, 20] (inner wall faces).
 * Everything solid is an axis-aligned box exposed in `colliders`.
 */

const ARENA_HALF = 20; // inner wall face
const WALL_HEIGHT = 3;
const WALL_THICKNESS = 1;
const GROUND_SIZE = ARENA_HALF * 2 + WALL_THICKNESS * 2; // 42

const PALETTE = {
  groundA: '#5fb46b',
  groundB: '#55a961',
  gridLine: 'rgba(20, 60, 30, 0.16)',
  wall: '#8a7ff0',
  wallTrim: '#7a6fe0',
  stairs: '#e17055',
  crates: ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#1dd1a1', '#f368e0', '#54a0ff', '#ffb142'],
  platforms: ['#a29bfe', '#74b9ff', '#55efc4', '#fdcb6e'],
} as const;

export class World {
  readonly group = new THREE.Group();
  readonly colliders: THREE.Box3[] = [];
  readonly spawnPoints: THREE.Vector3[] = [];
  readonly skyColor = new THREE.Color('#d9ecff');
  readonly lighting: WorldLighting = {
    hemiSky: 0xcfe6ff,
    hemiGround: 0x87a06b,
    hemiIntensity: 1.0,
    sunColor: 0xfff2cc,
    sunIntensity: 2.2,
    fogNear: 45,
    fogFar: 150,
  };

  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);

  // --- party rising ink (lazily created; same pulse trick as EscapeWorld's lava)
  private lavaParams: LavaParams | null = null;
  private lavaMesh: THREE.Mesh | null = null;
  private lavaMaterial: THREE.MeshBasicMaterial | null = null;
  private lavaTime = 0;
  private lavaY: number | null = null;

  constructor() {
    this.buildSky();
    this.buildGround();
    this.buildWalls();
    this.buildObstacles();
    this.buildSpawnPoints();
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  /** Solid box: mesh + matching AABB collider. x/z are the center, y is the box center. */
  private addBox(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    color: string,
  ): THREE.Mesh {
    const material = this.track(new THREE.MeshLambertMaterial({ color }));
    const mesh = new THREE.Mesh(this.boxGeometry, material);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    this.colliders.push(
      new THREE.Box3(
        new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
        new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2),
      ),
    );
    return mesh;
  }

  /** Ground-sitting box, y computed from height. */
  private addGrounded(w: number, h: number, d: number, x: number, z: number, color: string): void {
    this.addBox(w, h, d, x, h / 2, z, color);
  }

  private buildSky(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#3f8cf2'); // zenith
    grad.addColorStop(0.55, '#8ec4ff');
    grad.addColorStop(0.78, '#d9ecff'); // horizon, matches fog
    grad.addColorStop(1, '#d9ecff');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 256);

    const texture = this.track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;

    const geometry = this.track(new THREE.SphereGeometry(180, 24, 16));
    const material = this.track(
      new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
      }),
    );
    this.group.add(new THREE.Mesh(geometry, material));
  }

  private buildGround(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    const cells = 8; // 64px per cell, one cell = 2m in world space
    const cell = canvas.width / cells;
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        ctx.fillStyle = (i + j) % 2 === 0 ? PALETTE.groundA : PALETTE.groundB;
        ctx.fillRect(i * cell, j * cell, cell, cell);
      }
    }
    ctx.strokeStyle = PALETTE.gridLine;
    ctx.lineWidth = 2;
    for (let i = 0; i <= cells; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, canvas.height);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(canvas.width, i * cell);
      ctx.stroke();
    }

    const texture = this.track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    // Texture spans 8 cells x 2m = 16m; repeat to cover the ground plane.
    texture.repeat.set(GROUND_SIZE / 16, GROUND_SIZE / 16);
    texture.anisotropy = 4;

    const geometry = this.track(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE));
    const material = this.track(new THREE.MeshLambertMaterial({ map: texture }));
    const ground = new THREE.Mesh(geometry, material);
    ground.rotation.x = -Math.PI / 2;
    this.group.add(ground);

    // Thick ground collider so fast falls can't tunnel through the top plane.
    this.colliders.push(
      new THREE.Box3(
        new THREE.Vector3(-GROUND_SIZE / 2, -4, -GROUND_SIZE / 2),
        new THREE.Vector3(GROUND_SIZE / 2, 0, GROUND_SIZE / 2),
      ),
    );
  }

  private buildWalls(): void {
    const y = WALL_HEIGHT / 2;
    const offset = ARENA_HALF + WALL_THICKNESS / 2; // 20.5
    const length = GROUND_SIZE; // overlap corners
    this.addBox(length, WALL_HEIGHT, WALL_THICKNESS, 0, y, -offset, PALETTE.wall);
    this.addBox(length, WALL_HEIGHT, WALL_THICKNESS, 0, y, offset, PALETTE.wall);
    this.addBox(WALL_THICKNESS, WALL_HEIGHT, length, -offset, y, 0, PALETTE.wallTrim);
    this.addBox(WALL_THICKNESS, WALL_HEIGHT, length, offset, y, 0, PALETTE.wallTrim);
  }

  private buildObstacles(): void {
    const crate = (size: number, x: number, z: number, colorIndex: number): void =>
      this.addGrounded(size, size, size, x, z, PALETTE.crates[colorIndex % PALETTE.crates.length]!);

    // Crate clusters (1-2m cubes); several form jumpable step-ups.
    crate(2.0, -6, -4, 0);
    crate(1.2, -6, -1.7, 1); // step up to the 2m crate next to it
    crate(1.0, 5, -7, 2);
    crate(1.5, 7, -6, 3);
    crate(1.0, 7, -3.5, 4);
    crate(2.0, 10, 8, 5);
    crate(1.4, -9, 9, 6);
    crate(1.0, -11, 7, 7);
    crate(1.6, 3, 11, 0);
    crate(1.2, 14.5, -12.5, 1);
    crate(1.0, -13, -10, 2);
    crate(2.0, 0.5, 3, 3);
    crate(1.0, -11.2, -2, 4); // hop-up for the 2m platform
    crate(1.0, 2, -12, 5); // hop-up for the 1.5m platform

    // Floating platforms (0.4m slabs, top height listed).
    const platform = (
      w: number,
      d: number,
      top: number,
      x: number,
      z: number,
      colorIndex: number,
    ): void => {
      this.addBox(w, 0.4, d, x, top - 0.2, z, PALETTE.platforms[colorIndex % PALETTE.platforms.length]!);
    };

    platform(4, 4, 2.0, -14, -2, 0); // reach via the 1m crate at (-11.2, -2)
    platform(4.5, 4, 3.0, 14, 2, 1); // reach via the stairs below
    platform(5, 3.5, 1.5, -2, -12, 2); // reach via the 1m crate at (2, -12)
    platform(3, 3, 4.0, 9.5, 2, 3); // reach by jumping from the 3m platform

    // Stair-steps up to the 3m platform: stacked boxes rising 0.6m each
    // (jump apex is ~1.2m, so every riser is comfortably jumpable).
    const stairX = 14;
    const stepDepth = 1.2;
    const stepWidth = 2.4;
    for (let i = 0; i < 4; i++) {
      const height = 0.6 * (i + 1); // 0.6, 1.2, 1.8, 2.4
      const z = -0.7 - stepDepth * (3 - i); // farthest step is the lowest
      this.addGrounded(stepWidth, height, stepDepth, stairX, z, PALETTE.stairs);
    }
  }

  private buildSpawnPoints(): void {
    // Feet positions on the ground (y = 0), spread out, all clear of obstacles.
    const points: Array<[number, number]> = [
      [17.5, 0],
      [11.3, 11.3],
      [0, 16],
      [-11.3, 11.3],
      [-17.5, 0.5],
      [-11.3, -11.3],
      [0, -16],
      [11.3, -11.3],
      [17.5, 12],
      [-17.5, -12],
    ];
    for (const [x, z] of points) this.spawnPoints.push(new THREE.Vector3(x, 0, z));
  }

  /** Start/stop the rising ink flood (party "rising ink" round); null clears it. */
  setLava(params: LavaParams | null): void {
    this.lavaParams = params;
    if (params && !this.lavaMesh) {
      // Visual only — the server owns the kill plane. Fog-free so the glow
      // reads through the arena haze; DoubleSide so eliminated spectators
      // caught under the surface still see it.
      this.lavaMaterial = this.track(
        new THREE.MeshBasicMaterial({ color: '#ff3d78', fog: false, side: THREE.DoubleSide }),
      );
      const geometry = this.track(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE));
      this.lavaMesh = new THREE.Mesh(geometry, this.lavaMaterial);
      this.lavaMesh.rotation.x = -Math.PI / 2;
      this.group.add(this.lavaMesh);
    }
    if (this.lavaMesh) this.lavaMesh.visible = params !== null;
    if (!params) this.lavaY = null;
  }

  /** Current ink flood height (m), or null when no flood is active. */
  get lavaHeight(): number | null {
    return this.lavaY;
  }

  /** Animates the rising ink; a no-op outside party rising-ink rounds. */
  update(dt: number): void {
    const p = this.lavaParams;
    if (!p || !this.lavaMesh || !this.lavaMaterial) return;

    // PINNED closed-form height, identical to the server's kill plane.
    const t = Math.max(0, (Date.now() - p.startAt) / 1000);
    this.lavaY = p.startY + p.riseRate * t + 0.5 * p.accel * t * t;
    // +1cm cosmetic lift kills z-fighting while the surface crosses the floor.
    this.lavaMesh.position.y = this.lavaY + 0.01;

    // Magenta-orange "party ink" pulse (EscapeWorld's lava pulse pattern).
    this.lavaTime += dt;
    const pulse = 0.85 + 0.15 * Math.sin(this.lavaTime * 2.2);
    this.lavaMaterial.color.setRGB(1 * pulse, 0.26 * pulse, 0.42 * pulse);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.boxGeometry.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
