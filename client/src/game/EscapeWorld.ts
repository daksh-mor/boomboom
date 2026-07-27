import * as THREE from 'three';
import type { EscapeStage } from '../../../shared/types';
import { KEY_TEMPLATE_STROKES } from './ink/recognizer';
import type { WorldLighting } from './World';

/**
 * "The Doodle Dungeon" — the co-op escape room. A sealed torch-lit hall:
 * spawn ledge, an 8m ink-abyss chasm (draw across it), a high pressure plate
 * that opens the gate (weigh it with ink or a body), and the key door with a
 * glowing mural hint. Interior x in [-28, 28], z in [-8, 8], ceiling at 12m.
 */

const PALETTE = {
  floor: '#3d3a52',
  floorB: '#36334a',
  gridLine: 'rgba(10, 8, 22, 0.35)',
  wall: '#494263',
  wallDark: '#3c3654',
  pillar: '#55506e',
  gate: '#7a6a4f',
  door: '#8a6f3f',
  doorFrame: '#4e4666',
  plate: '#2d4a56',
  plateOn: '#37e0c8',
  lava: '#ff5e2b',
  ceiling: '#232033',
  exit: '#37e08a',
  torch: '#ffb45e',
} as const;

const GATE_OPEN_Y = 6.2; // gate slides up by this much
const DOOR_OPEN_Y = 5.2;

export class EscapeWorld {
  readonly group = new THREE.Group();
  readonly colliders: THREE.Box3[] = [];
  readonly spawnPoints: THREE.Vector3[] = [];
  readonly skyColor = new THREE.Color('#16131f');
  readonly lighting: WorldLighting = {
    hemiSky: 0x8a86c8,
    hemiGround: 0x2a2438,
    hemiIntensity: 0.65,
    sunColor: 0xffd9a0,
    sunIntensity: 0.45,
    fogNear: 12,
    fogFar: 58,
  };

  // --- escape gameplay geometry
  readonly plateSensor = new THREE.Box3(
    new THREE.Vector3(1.1, 3.0, -4.9),
    new THREE.Vector3(2.9, 4.4, -3.1),
  );
  readonly exitZone = new THREE.Box3(
    new THREE.Vector3(24.8, 0, -1.8),
    new THREE.Vector3(28, 3, 1.8),
  );
  readonly chasmCrossedX = -7.5;
  readonly keyZoneCenter = new THREE.Vector3(22.5, 2, 0);
  readonly keyZoneRadius = 4.5;
  readonly fallY = -3.5;
  readonly fallRecovery = new THREE.Vector3(-19, 0, 0);

  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);

  private gateMesh!: THREE.Mesh;
  private gateCollider!: THREE.Box3;
  private gateClosedY = 0;
  private gateOpen = false;

  private doorMesh!: THREE.Mesh;
  private doorCollider!: THREE.Box3;
  private doorClosedY = 0;
  private doorOpen = false;

  private plateMaterial!: THREE.MeshLambertMaterial;
  private platePressed = false;

  private lavaMaterial!: THREE.MeshBasicMaterial;
  private lavaTime = 0;

  constructor() {
    this.buildStructure();
    this.buildChasm();
    this.buildGate();
    this.buildPlate();
    this.buildDoor();
    this.buildMurals();
    this.buildTorches();
    this.buildSpawnPoints();
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  private addBox(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    color: string,
    withCollider = true,
  ): THREE.Mesh {
    const material = this.track(new THREE.MeshLambertMaterial({ color }));
    const mesh = new THREE.Mesh(this.boxGeometry, material);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    if (withCollider) {
      this.colliders.push(
        new THREE.Box3(
          new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
          new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2),
        ),
      );
    }
    return mesh;
  }

  private buildStructure(): void {
    // Stone floor texture (checker + grid, cool dungeon tones).
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    const cells = 8;
    const cell = canvas.width / cells;
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        ctx.fillStyle = (i + j) % 2 === 0 ? PALETTE.floor : PALETTE.floorB;
        ctx.fillRect(i * cell, j * cell, cell, cell);
      }
    }
    ctx.strokeStyle = PALETTE.gridLine;
    ctx.lineWidth = 3;
    for (let i = 0; i <= cells; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, canvas.height);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(canvas.width, i * cell);
      ctx.stroke();
    }
    const floorTexture = this.track(new THREE.CanvasTexture(canvas));
    floorTexture.colorSpace = THREE.SRGBColorSpace;
    floorTexture.wrapS = THREE.RepeatWrapping;
    floorTexture.wrapT = THREE.RepeatWrapping;

    const floorMaterial = this.track(new THREE.MeshLambertMaterial({ map: floorTexture }));

    // West ledge (spawn side) and the long east floor; the gap between is the chasm.
    const westGeometry = this.track(new THREE.PlaneGeometry(12, 16));
    const west = new THREE.Mesh(westGeometry, floorMaterial);
    west.rotation.x = -Math.PI / 2;
    west.position.set(-22, 0.001, 0);
    this.group.add(west);
    this.addBox(12, 4, 16, -22, -2, 0, PALETTE.wallDark).visible = true;

    const eastGeometry = this.track(new THREE.PlaneGeometry(36, 16));
    const east = new THREE.Mesh(eastGeometry, floorMaterial);
    east.rotation.x = -Math.PI / 2;
    east.position.set(10, 0.001, 0);
    this.group.add(east);
    this.addBox(36, 4, 16, 10, -2, 0, PALETTE.wallDark).visible = true;

    floorTexture.repeat.set(3, 2);

    // Perimeter walls (12m — no drawing your way over these) + dark ceiling.
    this.addBox(58, 12, 1, 0, 6, -8.5, PALETTE.wall);
    this.addBox(58, 12, 1, 0, 6, 8.5, PALETTE.wall);
    this.addBox(1, 12, 18, -28.5, 6, 0, PALETTE.wallDark);
    this.addBox(1, 12, 18, 28.5, 6, 0, PALETTE.wallDark);
    this.addBox(58, 1, 18, 0, 12.5, 0, PALETTE.ceiling);

    // Full-height decorative pillars (with colliders — cover and parkour).
    this.addBox(1.2, 12, 1.2, -4, 6, 5.5, PALETTE.pillar);
    this.addBox(1.2, 12, 1.2, -4, 6, -5.5, PALETTE.pillar);
    this.addBox(1.2, 12, 1.2, 17, 6, 5.5, PALETTE.pillar);
    this.addBox(1.2, 12, 1.2, 17, 6, -5.5, PALETTE.pillar);
  }

  private buildChasm(): void {
    // Glowing ink-lava at the bottom of the chasm (visual only, no collider).
    this.lavaMaterial = this.track(
      new THREE.MeshBasicMaterial({ color: PALETTE.lava, fog: false }),
    );
    const geometry = this.track(new THREE.PlaneGeometry(8, 16));
    const lava = new THREE.Mesh(geometry, this.lavaMaterial);
    lava.rotation.x = -Math.PI / 2;
    lava.position.set(-12, -5.2, 0);
    this.group.add(lava);

    // Chasm inner faces so the pit doesn't show the void.
    this.addBox(0.4, 6, 16, -16.2, -3, 0, PALETTE.wallDark, false);
    this.addBox(0.4, 6, 16, -7.8, -3, 0, PALETTE.wallDark, false);
    this.addBox(8, 6, 0.4, -12, -3, -8.2, PALETTE.wallDark, false);
    this.addBox(8, 6, 0.4, -12, -3, 8.2, PALETTE.wallDark, false);
  }

  private buildGate(): void {
    // Barrier fence at x=12 with a central gate that slides up once the
    // plate is triggered. The 4m side fences are intentionally climbable
    // with enough ink — creative bypasses are part of the fun.
    this.addBox(1, 4, 5, 12, 2, -5.5, PALETTE.wall);
    this.addBox(1, 4, 5, 12, 2, 5.5, PALETTE.wall);
    this.addBox(1.2, 8, 1.0, 12, 4, -3, PALETTE.pillar);
    this.addBox(1.2, 8, 1.0, 12, 4, 3, PALETTE.pillar);

    const material = this.track(new THREE.MeshLambertMaterial({ color: PALETTE.gate }));
    this.gateMesh = new THREE.Mesh(this.boxGeometry, material);
    this.gateMesh.scale.set(0.6, 4, 6);
    this.gateMesh.position.set(12, 2, 0);
    this.gateClosedY = 2;
    this.group.add(this.gateMesh);
    this.gateCollider = new THREE.Box3(
      new THREE.Vector3(12 - 0.3, 0, -3),
      new THREE.Vector3(12 + 0.3, 4, 3),
    );
    this.colliders.push(this.gateCollider);
  }

  private buildPlate(): void {
    // 3m pillar with the pressure plate on top — out of double-jump reach,
    // so it takes drawn steps (or drawing straight onto the plate).
    this.addBox(1.4, 3, 1.4, 2, 1.5, -4, PALETTE.pillar);
    this.plateMaterial = this.track(
      new THREE.MeshLambertMaterial({ color: PALETTE.plate }),
    );
    this.plateMaterial.emissive = new THREE.Color(PALETTE.plateOn);
    this.plateMaterial.emissiveIntensity = 0.08;
    const plate = new THREE.Mesh(this.boxGeometry, this.plateMaterial);
    plate.scale.set(1.6, 0.12, 1.6);
    plate.position.set(2, 3.06, -4);
    this.group.add(plate);
  }

  private buildDoor(): void {
    // Interior door wall at x=24 with the sealed key door; the exit corridor
    // glows behind it.
    this.addBox(1, 12, 6, 24, 6, -5, PALETTE.wall);
    this.addBox(1, 12, 6, 24, 6, 5, PALETTE.wall);
    this.addBox(1, 7, 4, 24, 8.5, 0, PALETTE.wallDark);
    this.addBox(1.2, 6, 0.8, 24, 3, -2.2, PALETTE.doorFrame);
    this.addBox(1.2, 6, 0.8, 24, 3, 2.2, PALETTE.doorFrame);

    const material = this.track(new THREE.MeshLambertMaterial({ color: PALETTE.door }));
    material.emissive = new THREE.Color('#c9a24a');
    material.emissiveIntensity = 0.06;
    this.doorMesh = new THREE.Mesh(this.boxGeometry, material);
    this.doorMesh.scale.set(0.5, 5, 4);
    this.doorMesh.position.set(24, 2.5, 0);
    this.doorClosedY = 2.5;
    this.group.add(this.doorMesh);
    this.doorCollider = new THREE.Box3(
      new THREE.Vector3(24 - 0.25, 0, -2),
      new THREE.Vector3(24 + 0.25, 5, 2),
    );
    this.colliders.push(this.doorCollider);

    // Keyhole marker on the door.
    const keyholeMaterial = this.track(
      new THREE.MeshBasicMaterial({ color: '#ffe9a8', fog: false }),
    );
    const keyhole = new THREE.Mesh(this.boxGeometry, keyholeMaterial);
    keyhole.scale.set(0.12, 0.5, 0.3);
    keyhole.position.set(23.7, 2.6, 0);
    this.group.add(keyhole);

    // Exit corridor glow strip.
    const exitMaterial = this.track(
      new THREE.MeshBasicMaterial({ color: PALETTE.exit, fog: false }),
    );
    const exitGeometry = this.track(new THREE.PlaneGeometry(3.6, 3.6));
    const exitGlow = new THREE.Mesh(exitGeometry, exitMaterial);
    exitGlow.rotation.x = -Math.PI / 2;
    exitGlow.position.set(26.3, 0.02, 0);
    this.group.add(exitGlow);
  }

  /** Parchment mural rendering the exact key template players must copy. */
  private makeMuralTexture(): THREE.CanvasTexture {
    const w = 512;
    const h = 336;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#241f38';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(94, 234, 212, 0.35)';
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, w - 16, h - 16);

    // Template extents: x in [-1, 3.4], y in [-1, 1]. Fit with padding.
    const scale = 84;
    const offsetX = 130;
    const offsetY = h / 2 - 30;
    ctx.strokeStyle = '#5eead4';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = '#5eead4';
    ctx.shadowBlur = 22;
    for (const stroke of KEY_TEMPLATE_STROKES) {
      ctx.beginPath();
      stroke.forEach((p, i) => {
        const x = offsetX + p.x * scale;
        const y = offsetY - p.y * scale; // canvas y grows downward
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(232, 234, 239, 0.75)';
    ctx.font = '700 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('DRAW ME AT THE DOOR', w / 2, h - 36);
    return new THREE.CanvasTexture(canvas);
  }

  private buildMurals(): void {
    const texture = this.track(this.makeMuralTexture());
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = this.track(
      new THREE.MeshBasicMaterial({ map: texture, fog: false }),
    );

    const geometryLarge = this.track(new THREE.PlaneGeometry(3.6, 2.36));
    const mural = new THREE.Mesh(geometryLarge, material);
    mural.position.set(6, 3.4, -7.95);
    this.group.add(mural);

    const geometrySmall = this.track(new THREE.PlaneGeometry(2.6, 1.7));
    const muralSmall = new THREE.Mesh(geometrySmall, material);
    muralSmall.position.set(20.5, 3.0, -7.95);
    this.group.add(muralSmall);
  }

  private buildTorches(): void {
    const torchMaterial = this.track(
      new THREE.MeshBasicMaterial({ color: PALETTE.torch, fog: false }),
    );
    const positions: Array<[number, number]> = [
      [-24, -8.1], [-24, 8.1],
      [-2, -8.1], [-2, 8.1],
      [8, -8.1], [8, 8.1],
      [19, -8.1], [19, 8.1],
      [26, -8.1], [26, 8.1],
    ];
    for (const [x, z] of positions) {
      const torch = new THREE.Mesh(this.boxGeometry, torchMaterial);
      torch.scale.set(0.24, 0.6, 0.24);
      torch.position.set(x, 4.6, z);
      this.group.add(torch);
    }

    // A few warm point lights carry the dungeon mood (Lambert-friendly).
    const west = new THREE.PointLight(0xffb45e, 60, 30, 1.8);
    west.position.set(-21, 6, 0);
    const mid = new THREE.PointLight(0xffb45e, 60, 30, 1.8);
    mid.position.set(4, 6, 0);
    const east = new THREE.PointLight(0xffcf8a, 55, 26, 1.8);
    east.position.set(21, 5, 0);
    this.group.add(west, mid, east);
  }

  private buildSpawnPoints(): void {
    const points: Array<[number, number]> = [
      [-26, -5], [-26, 0], [-26, 5],
      [-23, -3], [-23, 3],
      [-20, -6], [-20, 0], [-20, 6],
      [-25, -1.5], [-25, 1.5],
    ];
    for (const [x, z] of points) this.spawnPoints.push(new THREE.Vector3(x, 0, z));
  }

  /** Apply completed stages (idempotent; also used for late-join catch-up). */
  setStagesDone(stages: ReadonlySet<EscapeStage>): void {
    if (stages.has('plate') && !this.platePressed) {
      this.platePressed = true;
      this.plateMaterial.emissiveIntensity = 0.9;
      this.openGate();
    }
    if (stages.has('key') && !this.doorOpen) {
      this.doorOpen = true;
      const index = this.colliders.indexOf(this.doorCollider);
      if (index !== -1) this.colliders.splice(index, 1);
    }
  }

  private openGate(): void {
    if (this.gateOpen) return;
    this.gateOpen = true;
    const index = this.colliders.indexOf(this.gateCollider);
    if (index !== -1) this.colliders.splice(index, 1);
  }

  /** Animates the gate/door slides and the lava pulse. Call once per frame. */
  update(dt: number): void {
    if (this.gateOpen) {
      const target = this.gateClosedY + GATE_OPEN_Y;
      if (this.gateMesh.position.y < target) {
        this.gateMesh.position.y = Math.min(target, this.gateMesh.position.y + dt * 4);
      }
    }
    if (this.doorOpen) {
      const target = this.doorClosedY + DOOR_OPEN_Y;
      if (this.doorMesh.position.y < target) {
        this.doorMesh.position.y = Math.min(target, this.doorMesh.position.y + dt * 3.2);
      }
    }
    this.lavaTime += dt;
    const pulse = 0.85 + 0.15 * Math.sin(this.lavaTime * 2.2);
    this.lavaMaterial.color.setRGB(1 * pulse, 0.37 * pulse, 0.17 * pulse);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.boxGeometry.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
