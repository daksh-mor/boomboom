/**
 * Shared mutable input state, written by KeyboardMouse / TouchControls and
 * read by the PlayerController at each fixed physics step.
 */
export interface InputState {
  /** Strafe axis, right is +. Magnitude <= 1. */
  moveX: number;
  /** Forward axis, forward is +. Magnitude <= 1. */
  moveY: number;
  /** performance.now() of the last jump press, or -Infinity when none. */
  jumpQueuedAt: number;
  /** True while the fire input (mouse button / FIRE touch button) is held. */
  firePressed: boolean;
  /** One-shot reload request (R key / RELOAD button); consumed by the weapon. */
  reloadQueued: boolean;
  /** One-shot sketch toggle (Q key / DRAW button); consumed by the game. */
  sketchToggleQueued: boolean;
  /** True while the erase input (G key / ERASE button) is held. */
  erasePressed: boolean;
}

export function createInputState(): InputState {
  return {
    moveX: 0,
    moveY: 0,
    jumpQueuedAt: -Infinity,
    firePressed: false,
    reloadQueued: false,
    sketchToggleQueued: false,
    erasePressed: false,
  };
}
