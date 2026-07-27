import type { InputState } from './InputState';

const MOVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export class KeyboardMouse {
  private readonly keys = new Set<string>();
  private attached = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly input: InputState,
    /** RAW pixel deltas — the game applies sensitivity (look vs sketch pen). */
    private readonly onMouseDelta: (dxPx: number, dyPx: number) => void,
    private readonly onLockChange: (locked: boolean) => void,
    /** Pointer lock is only requested on fine-pointer (desktop) devices. */
    private readonly usePointerLock: boolean,
  ) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('mousedown', this.handleMouseDown);
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('pointerlockchange', this.handleLockChange);
    document.addEventListener('pointerlockerror', this.handleLockError);
    if (this.usePointerLock) {
      this.canvas.addEventListener('click', this.handleCanvasClick);
    }
  }

  dispose(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
    document.removeEventListener('pointerlockerror', this.handleLockError);
    this.canvas.removeEventListener('click', this.handleCanvasClick);
    this.keys.clear();
    this.input.firePressed = false;
    if (this.isLocked()) document.exitPointerLock();
  }

  private isLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  private handleCanvasClick = (): void => {
    if (this.isLocked()) return;
    // Some browsers return a promise (which rejects if lock is re-requested
    // too soon after Esc); normalize and swallow — pointerlockerror covers UI.
    try {
      Promise.resolve(
        this.canvas.requestPointerLock() as unknown as Promise<void> | void,
      ).catch(() => {});
    } catch {
      // Older engines throw synchronously when unsupported.
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (MOVE_KEYS.has(e.code) || e.code === 'Space') e.preventDefault();
    if (e.code === 'Space') {
      if (!e.repeat) this.input.jumpQueuedAt = performance.now();
      return;
    }
    if (e.code === 'KeyR') {
      if (!e.repeat) this.input.reloadQueued = true;
      return;
    }
    if (e.code === 'KeyQ') {
      if (!e.repeat) this.input.sketchToggleQueued = true;
      return;
    }
    if (e.code === 'KeyG') {
      this.input.erasePressed = true;
      return;
    }
    if (MOVE_KEYS.has(e.code)) {
      this.keys.add(e.code);
      this.recomputeMove();
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'KeyG') {
      this.input.erasePressed = false;
      return;
    }
    if (this.keys.delete(e.code)) this.recomputeMove();
  };

  private handleBlur = (): void => {
    // Alt-tab must not leave keys (or the trigger/eraser) stuck down.
    this.keys.clear();
    this.input.firePressed = false;
    this.input.erasePressed = false;
    this.recomputeMove();
  };

  private handleMouseDown = (e: MouseEvent): void => {
    // Fire only while pointer-locked: unlocked clicks are for acquiring the
    // lock (canvas) or for HUD buttons, never shots.
    if (e.button === 0 && this.isLocked()) this.input.firePressed = true;
  };

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.input.firePressed = false;
  };

  private recomputeMove(): void {
    const k = this.keys;
    let x = 0;
    let y = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.input.moveX = x;
    this.input.moveY = y;
  }

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.isLocked()) return;
    this.onMouseDelta(e.movementX, e.movementY);
  };

  private handleLockChange = (): void => {
    const locked = this.isLocked();
    if (!locked) this.input.firePressed = false; // Esc mid-burst must stop firing
    this.onLockChange(locked);
  };

  private handleLockError = (): void => {
    this.onLockChange(false);
  };
}
