import type { InkPoint } from '../../../../shared/types';

/**
 * $P point-cloud recognizer (Vatavu, Anthony & Wobbrock, ICMI 2012),
 * implemented from the published pseudocode. Gestures are unordered point
 * clouds, so stroke count/order/direction don't matter — ideal for letting
 * players draw the magic key however they like.
 */

const CLOUD_SIZE = 32;

interface CloudPoint {
  x: number;
  y: number;
  strokeId: number;
}

function pathLength(points: readonly CloudPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.strokeId !== points[i - 1]!.strokeId) continue;
    length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return length;
}

/** Resample to `n` points, evenly spaced along the path (per stroke). */
function resample(input: readonly CloudPoint[], n: number): CloudPoint[] {
  const interval = pathLength(input) / (n - 1);
  if (interval <= 0) {
    return Array.from({ length: n }, () => ({ ...input[0]! }));
  }
  const points = input.map((p) => ({ ...p }));
  const out: CloudPoint[] = [{ ...points[0]! }];
  let accumulated = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    if (curr.strokeId !== prev.strokeId) continue;
    const d = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    if (accumulated + d >= interval && d > 0) {
      const t = (interval - accumulated) / d;
      const q: CloudPoint = {
        x: prev.x + t * (curr.x - prev.x),
        y: prev.y + t * (curr.y - prev.y),
        strokeId: curr.strokeId,
      };
      out.push(q);
      points.splice(i, 0, q); // q becomes the next segment start
      accumulated = 0;
    } else {
      accumulated += d;
    }
  }
  while (out.length < n) out.push({ ...out[out.length - 1]! });
  return out.slice(0, n);
}

/** Uniformly scale into the unit box (preserving aspect), keyed on the larger side. */
function scale(points: CloudPoint[]): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  for (const p of points) {
    p.x = (p.x - minX) / size;
    p.y = (p.y - minY) / size;
  }
}

/** Translate the centroid to the origin. */
function translateToOrigin(points: CloudPoint[]): void {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;
  for (const p of points) {
    p.x -= cx;
    p.y -= cy;
  }
}

function normalize(strokes: readonly (readonly InkPoint[])[]): CloudPoint[] {
  const raw: CloudPoint[] = [];
  strokes.forEach((stroke, strokeId) => {
    for (const p of stroke) raw.push({ x: p.x, y: p.y, strokeId });
  });
  if (raw.length === 0) return [];
  const points = resample(raw, CLOUD_SIZE);
  scale(points);
  translateToOrigin(points);
  return points;
}

/** Greedy weighted cloud distance from `a` to `b`, starting the match at `start`. */
function cloudDistance(a: readonly CloudPoint[], b: readonly CloudPoint[], start: number): number {
  const n = a.length;
  const matched = new Uint8Array(n);
  let sum = 0;
  let i = start;
  do {
    let index = -1;
    let min = Infinity;
    for (let j = 0; j < n; j++) {
      if (matched[j]) continue;
      const d = Math.hypot(a[i]!.x - b[j]!.x, a[i]!.y - b[j]!.y);
      if (d < min) {
        min = d;
        index = j;
      }
    }
    matched[index] = 1;
    const weight = 1 - ((i - start + n) % n) / n;
    sum += weight * min;
    i = (i + 1) % n;
  } while (i !== start);
  return sum;
}

/** Minimum cloud distance over both match directions and several start points. */
function greedyCloudMatch(a: readonly CloudPoint[], b: readonly CloudPoint[]): number {
  const n = a.length;
  const step = Math.floor(Math.pow(n, 0.5));
  let min = Infinity;
  for (let i = 0; i < n; i += step) {
    min = Math.min(min, cloudDistance(a, b, i), cloudDistance(b, a, i));
  }
  return min;
}

// ---------------------------------------------------------------- templates

function circle(cx: number, cy: number, r: number, segments: number): InkPoint[] {
  const points: InkPoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  }
  return points;
}

/**
 * Canonical magic-key shapes (round head, straight shaft, teeth hanging down),
 * plus a mirrored variant so the key can face either way. The dungeon mural
 * renders the first template, so players can copy exactly what they see.
 */
export const KEY_TEMPLATE_STROKES: readonly (readonly InkPoint[])[] = [
  circle(0, 0, 1, 14),
  [
    { x: 1, y: 0 },
    { x: 3.4, y: 0 },
  ],
  [
    { x: 2.5, y: 0 },
    { x: 2.5, y: -0.8 },
  ],
  [
    { x: 3.3, y: 0 },
    { x: 3.3, y: -1.0 },
  ],
];

function mirror(strokes: readonly (readonly InkPoint[])[]): InkPoint[][] {
  return strokes.map((stroke) => stroke.map((p) => ({ x: -p.x, y: p.y })));
}

const SIMPLE_KEY: readonly (readonly InkPoint[])[] = [
  circle(0, 0, 1, 14),
  [
    { x: 1, y: 0 },
    { x: 3.2, y: 0 },
    { x: 3.2, y: -0.9 },
  ],
];

const TEMPLATES: CloudPoint[][] = [
  normalize(KEY_TEMPLATE_STROKES),
  normalize(mirror(KEY_TEMPLATE_STROKES)),
  normalize(SIMPLE_KEY),
  normalize(mirror(SIMPLE_KEY)),
];

/** Confidence threshold for accepting a drawing as the key. */
export const KEY_MATCH_THRESHOLD = 0.72;

/**
 * Confidence (0..1) that the strokes depict the magic key. $P always returns
 * some nearest match, so callers must gate on KEY_MATCH_THRESHOLD.
 */
export function keyConfidence(strokes: readonly (readonly InkPoint[])[]): number {
  const totalPoints = strokes.reduce((sum, s) => sum + s.length, 0);
  if (totalPoints < 6) return 0;
  const cloud = normalize(strokes);
  if (cloud.length === 0) return 0;

  let best = Infinity;
  for (const template of TEMPLATES) {
    best = Math.min(best, greedyCloudMatch(cloud, template));
  }
  // Standard $P score mapping: distance 0 -> 1.0 confidence, >= 2 -> 0.
  return Math.max(0, (2 - best) / 2);
}

export function isKey(strokes: readonly (readonly InkPoint[])[]): boolean {
  return keyConfidence(strokes) >= KEY_MATCH_THRESHOLD;
}
