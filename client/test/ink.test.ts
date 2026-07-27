/**
 * Magic-ink unit tests: RDP stroke simplification and the $P key recognizer.
 * Run via `npm run test:ink` (tsx, no renderer required).
 */
import type { InkPoint } from '../../shared/types';
import {
  KEY_MATCH_THRESHOLD,
  KEY_TEMPLATE_STROKES,
  isKey,
  keyConfidence,
} from '../src/game/ink/recognizer';
import { simplifyStroke, strokesLength } from '../src/game/ink/rdp';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- RDP

{
  // Collinear points collapse to the two endpoints.
  const line: InkPoint[] = Array.from({ length: 50 }, (_, i) => ({ x: i * 0.1, y: 0 }));
  const simplified = simplifyStroke(line, 0.04);
  assert('rdp: collinear stroke collapses to endpoints', simplified.length === 2, `${simplified.length}`);
  assert(
    'rdp: endpoints preserved exactly',
    simplified[0]!.x === 0 && simplified[simplified.length - 1]!.x === 4.9,
  );
}

{
  // A right-angle corner must survive simplification.
  const corner: InkPoint[] = [
    ...Array.from({ length: 20 }, (_, i) => ({ x: i * 0.1, y: 0 })),
    ...Array.from({ length: 20 }, (_, i) => ({ x: 2, y: (i + 1) * 0.1 })),
  ];
  const simplified = simplifyStroke(corner, 0.04);
  assert('rdp: corner point survives', simplified.some((p) => Math.abs(p.x - 2) < 0.11 && Math.abs(p.y) < 0.11));
  assert('rdp: corner stroke stays small', simplified.length <= 5, `${simplified.length}`);
}

{
  const length = strokesLength([
    [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
    ],
  ]);
  assert('strokesLength: 3-4-5 triangle', Math.abs(length - 5) < 1e-9, `${length}`);
}

// ---------------------------------------------------------------- recognizer

function jitter(strokes: readonly (readonly InkPoint[])[], amount: number, seedShift = 0): InkPoint[][] {
  // Deterministic pseudo-jitter so the test never flakes.
  let seed = 42 + seedShift;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  return strokes.map((stroke) => stroke.map((p) => ({ x: p.x + rand() * amount, y: p.y + rand() * amount })));
}

{
  const clean = keyConfidence(KEY_TEMPLATE_STROKES);
  assert('key: the template itself matches ~perfectly', clean > 0.95, `${clean.toFixed(3)}`);
}

{
  for (const [label, amount, shift] of [
    ['light jitter', 0.08, 0],
    ['medium jitter', 0.16, 7],
  ] as const) {
    const confidence = keyConfidence(jitter(KEY_TEMPLATE_STROKES, amount, shift));
    assert(
      `key: ${label} still recognized (>= ${KEY_MATCH_THRESHOLD})`,
      confidence >= KEY_MATCH_THRESHOLD,
      `${confidence.toFixed(3)}`,
    );
  }
}

{
  // A hand-drawn-ish key: sloppy ellipse head, sloped shaft, two teeth.
  const ellipse: InkPoint[] = Array.from({ length: 13 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    return { x: Math.cos(a) * 1.1, y: Math.sin(a) * 0.85 };
  });
  const sketchy: InkPoint[][] = [
    ellipse,
    [
      { x: 1.05, y: 0.05 },
      { x: 3.3, y: -0.12 },
    ],
    [
      { x: 2.4, y: -0.05 },
      { x: 2.45, y: -0.85 },
    ],
    [
      { x: 3.2, y: -0.1 },
      { x: 3.25, y: -1.0 },
    ],
  ];
  assert('key: sketchy hand-drawn key accepted', isKey(sketchy), `${keyConfidence(sketchy).toFixed(3)}`);
}

{
  // Non-keys must be rejected: circle, square, straight line, scribble.
  const circleOnly: InkPoint[][] = [
    Array.from({ length: 17 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      return { x: Math.cos(a), y: Math.sin(a) };
    }),
  ];
  assert('key: plain circle rejected', !isKey(circleOnly), `${keyConfidence(circleOnly).toFixed(3)}`);

  const square: InkPoint[][] = [
    [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 0 },
    ],
  ];
  assert('key: square rejected', !isKey(square), `${keyConfidence(square).toFixed(3)}`);

  const line: InkPoint[][] = [
    [
      { x: 0, y: 0 },
      { x: 3, y: 0.2 },
    ],
  ];
  assert('key: straight line rejected', !isKey(line), `${keyConfidence(line).toFixed(3)}`);

  let seed = 1234;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const scribble: InkPoint[][] = [
    Array.from({ length: 40 }, () => ({ x: rand() * 4 - 2, y: rand() * 3 - 1.5 })),
  ];
  assert('key: random scribble rejected', !isKey(scribble), `${keyConfidence(scribble).toFixed(3)}`);
}

{
  assert('key: empty input safe', keyConfidence([]) === 0);
  assert('key: tiny input safe', keyConfidence([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]) < KEY_MATCH_THRESHOLD);
}

console.log(`\n${passed + failed} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
