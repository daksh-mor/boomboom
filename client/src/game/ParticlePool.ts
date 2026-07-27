import * as THREE from 'three';

const GRAVITY = 18; // m/s^2 pulling particles down
const FLOOR_Y = 0.02; // particles never sink below the arena floor

// Square points on purpose — they read as tiny cubes, matching the boxy world.
const VERTEX_SHADER = /* glsl */ `
  attribute float size;
  attribute float alpha;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (uScale / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    gl_FragColor = vec4(vColor, vAlpha);
    #include <colorspace_fragment>
  }
`;

/**
 * Fixed-capacity particle system rendered as a single THREE.Points draw call.
 * Every buffer is preallocated; spawn() and update() only mutate typed arrays,
 * so steady-state runtime allocation is zero. Alive particles occupy slots
 * [0, count) — dead ones are swap-removed from the end.
 *
 * Reusable: spawn() takes scalar position/velocity/color, a world-space size
 * and a lifetime, so other systems (e.g. weapon ink splats) can share a pool
 * or create their own.
 */
export class ParticlePool {
  readonly points: THREE.Points;

  private readonly capacity: number;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly scaleUniform = { value: 700 };

  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;

  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;

  // CPU-side simulation state, never uploaded.
  private readonly velocities: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseSize: Float32Array;

  private count = 0;

  constructor(capacity = 128) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.velocities = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);

    this.positionAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('color', this.colorAttr);
    this.geometry.setAttribute('size', this.sizeAttr);
    this.geometry.setAttribute('alpha', this.alphaAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: this.scaleUniform },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    // Positions mutate in place and bounds are never recomputed; draw always.
    this.points.frustumCulled = false;
    this.points.renderOrder = 2; // after blob shadows in the transparent pass
  }

  /**
   * Perspective size attenuation so `size` behaves as world-space meters.
   * Call at startup and whenever the drawing buffer height changes.
   */
  setPerspective(drawingBufferHeight: number, fovDeg: number): void {
    this.scaleUniform.value = (drawingBufferHeight * 0.5) / Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5);
  }

  /**
   * Spawn one particle (scalar args only — never allocates). Color components
   * are working-color-space (linear) values, e.g. from a THREE.Color.
   * Silently dropped when the pool is full.
   */
  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    size: number,
    lifeSec: number,
  ): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    const i3 = i * 3;
    this.positions[i3] = x;
    this.positions[i3 + 1] = y;
    this.positions[i3 + 2] = z;
    this.velocities[i3] = vx;
    this.velocities[i3 + 1] = vy;
    this.velocities[i3 + 2] = vz;
    this.colors[i3] = r;
    this.colors[i3 + 1] = g;
    this.colors[i3 + 2] = b;
    this.baseSize[i] = size;
    this.sizes[i] = size;
    this.alphas[i] = 1;
    this.life[i] = lifeSec;
    this.maxLife[i] = lifeSec;
  }

  /** Integrate, fade and compact all alive particles. Call once per frame. */
  update(dt: number): void {
    const pos = this.positions;
    const vel = this.velocities;
    let count = this.count;

    for (let i = count - 1; i >= 0; i--) {
      const remaining = this.life[i]! - dt;
      if (remaining <= 0) {
        count--;
        if (i !== count) this.copySlot(count, i);
        continue;
      }
      this.life[i] = remaining;

      const i3 = i * 3;
      vel[i3 + 1] = vel[i3 + 1]! - GRAVITY * dt;
      pos[i3] = pos[i3]! + vel[i3]! * dt;
      pos[i3 + 1] = pos[i3 + 1]! + vel[i3 + 1]! * dt;
      pos[i3 + 2] = pos[i3 + 2]! + vel[i3 + 2]! * dt;
      if (pos[i3 + 1]! < FLOOR_Y) pos[i3 + 1] = FLOOR_Y;

      const t = remaining / this.maxLife[i]!;
      this.sizes[i] = this.baseSize[i]! * t;
      this.alphas[i] = t;
    }

    this.count = count;
    this.geometry.setDrawRange(0, count);
    if (count > 0) {
      this.positionAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
    }
  }

  private copySlot(from: number, to: number): void {
    const f3 = from * 3;
    const t3 = to * 3;
    this.positions[t3] = this.positions[f3]!;
    this.positions[t3 + 1] = this.positions[f3 + 1]!;
    this.positions[t3 + 2] = this.positions[f3 + 2]!;
    this.velocities[t3] = this.velocities[f3]!;
    this.velocities[t3 + 1] = this.velocities[f3 + 1]!;
    this.velocities[t3 + 2] = this.velocities[f3 + 2]!;
    this.colors[t3] = this.colors[f3]!;
    this.colors[t3 + 1] = this.colors[f3 + 1]!;
    this.colors[t3 + 2] = this.colors[f3 + 2]!;
    this.sizes[to] = this.sizes[from]!;
    this.alphas[to] = this.alphas[from]!;
    this.life[to] = this.life[from]!;
    this.maxLife[to] = this.maxLife[from]!;
    this.baseSize[to] = this.baseSize[from]!;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
