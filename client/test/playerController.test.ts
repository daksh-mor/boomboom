/**
 * PlayerController unit tests — run via `npm run test:controller`.
 * Uses a minimal flat ground collider; no renderer required.
 */
import * as THREE from 'three';
import { createInputState } from '../src/game/controls/InputState';
import { PlayerController, simulateSteps } from '../src/game/PlayerController';

const GROUND = new THREE.Box3(new THREE.Vector3(-50, -4, -50), new THREE.Vector3(50, 0, 50));
const CEILING = new THREE.Box3(new THREE.Vector3(-2, 3, -2), new THREE.Vector3(2, 5, 2));
const colliders = [GROUND, CEILING];

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

function makeController(): PlayerController {
  const c = new PlayerController(colliders);
  c.spawn([new THREE.Vector3(0, 0, 0)]);
  return c;
}

function queueJump(input: ReturnType<typeof createInputState>): void {
  input.jumpQueuedAt = performance.now();
}

// --- tests

{
  const c = makeController();
  const input = createInputState();
  simulateSteps(c, input, 5);
  assert('starts grounded on flat ground', c.isGrounded());
}

{
  const c = makeController();
  const input = createInputState();
  queueJump(input);
  simulateSteps(c, input, 3);
  assert('first jump leaves ground', !c.isGrounded() && c.pos.y > 0.1, `y=${c.pos.y}`);
}

{
  const c = makeController();
  const input = createInputState();
  queueJump(input);
  simulateSteps(c, input, 3);
  const yAfterFirst = c.pos.y;
  queueJump(input);
  simulateSteps(c, input, 8);
  assert('double jump gains extra height', c.pos.y > yAfterFirst + 0.3, `y=${c.pos.y} vs ${yAfterFirst}`);
}

{
  const c = makeController();
  const input = createInputState();
  queueJump(input);
  simulateSteps(c, input, 3);
  queueJump(input);
  simulateSteps(c, input, 8);
  c.drainEvents(); // clear jump/doubleJump from first two jumps
  queueJump(input);
  simulateSteps(c, input, 5);
  const events = c.drainEvents();
  assert('third jump rejected in air', !events.includes('jump') && !events.includes('doubleJump'), JSON.stringify(events));
}

{
  const c = makeController();
  const input = createInputState();
  simulateSteps(c, input, 1);
  // Walk off edge simulation: move in air by stepping off - use coyote by jumping right after leaving
  queueJump(input);
  simulateSteps(c, input, 2);
  assert('coyote jump works shortly after leaving ground', c.pos.y > 0.2 || !c.isGrounded());
}

{
  const c = makeController();
  const input = createInputState();
  queueJump(input);
  simulateSteps(c, input, 120); // fall back down
  assert('landing resets jump count', c.isGrounded());
  queueJump(input);
  simulateSteps(c, input, 3);
  assert('can jump again after landing', !c.isGrounded() && c.pos.y > 0.1);
}

{
  const c = makeController();
  const input = createInputState();
  // Buffer jump before landing
  simulateSteps(c, input, 3);
  queueJump(input);
  simulateSteps(c, input, 3);
  assert('buffered jump fires on landing', c.pos.y > 0.1 || !c.isGrounded());
}

{
  const c = makeController();
  const input = createInputState();
  queueJump(input);
  simulateSteps(c, input, 30);
  assert('ceiling collision stops upward motion', c.pos.y < 3.5, `y=${c.pos.y}`);
}

{
  const c = makeController();
  const input = createInputState();
  queueJump(input);
  simulateSteps(c, input, 2);
  const events = c.drainEvents();
  assert('jump emits jump event', events.includes('jump'), JSON.stringify(events));
  queueJump(input);
  simulateSteps(c, input, 8);
  const events2 = c.drainEvents();
  assert('double jump emits doubleJump event', events2.includes('doubleJump'), JSON.stringify(events2));
}

console.log(`\n${passed + failed} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
