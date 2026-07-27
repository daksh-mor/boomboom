import type { InkPoint } from '../../../../shared/types';

/** Perpendicular distance from `p` to the segment [a, b]. */
function segmentDistance(p: InkPoint, a: InkPoint, b: InkPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer-Douglas-Peucker polyline simplification (iterative, stack-based).
 * Keeps endpoints; drops points closer than `epsilon` to the local chord.
 */
export function simplifyStroke(points: readonly InkPoint[], epsilon: number): InkPoint[] {
  if (points.length <= 2) return points.map((p) => ({ x: p.x, y: p.y }));

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const d = segmentDistance(points[i]!, points[start]!, points[end]!);
      if (d > maxDist) {
        maxDist = d;
        maxIndex = i;
      }
    }
    if (maxIndex !== -1 && maxDist > epsilon) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }

  const result: InkPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push({ x: points[i]!.x, y: points[i]!.y });
  }
  return result;
}

/** Total polyline length of a set of strokes. */
export function strokesLength(strokes: readonly (readonly InkPoint[])[]): number {
  let total = 0;
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      total += Math.hypot(stroke[i]!.x - stroke[i - 1]!.x, stroke[i]!.y - stroke[i - 1]!.y);
    }
  }
  return total;
}
