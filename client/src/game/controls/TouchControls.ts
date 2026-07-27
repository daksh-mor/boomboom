import type { InputState } from './InputState';

const STICK_RADIUS = 48; // px the knob may travel from the base center
const DEAD_ZONE = 0.15;

interface MovePointer {
  kind: 'move';
  baseX: number;
  baseY: number;
}

interface LookPointer {
  kind: 'look';
  lastX: number;
  lastY: number;
}

/**
 * Multi-touch controls: a floating virtual joystick for any touch starting on
 * the left half, look-drag for the right half, and fixed jump/fire/reload
 * buttons. Every pointer is tracked by pointerId so move + look + fire + jump
 * work at once.
 *
 * Pointer handlers only write input/UI state — no DOM or style access on the
 * hot pointermove path. The buffered UI state is flushed to the DOM once per
 * frame by update(), called from the game's rAF loop.
 */
export class TouchControls {
  private readonly pointers = new Map<number, MovePointer | LookPointer>();
  private readonly layer: HTMLDivElement;
  private readonly stickBase: HTMLDivElement;
  private readonly stickKnob: HTMLDivElement;
  private readonly jumpButton: HTMLButtonElement;
  private readonly fireButton: HTMLButtonElement;
  private readonly reloadButton: HTMLButtonElement;
  private readonly drawButton: HTMLButtonElement;
  private readonly eraseButton: HTMLButtonElement;
  private attached = false;

  // Desired UI state, written by pointer handlers.
  private stickActive = false;
  private stickBaseX = 0;
  private stickBaseY = 0;
  private knobX = 0;
  private knobY = 0;
  private jumpPressed = false;
  private firePressed = false;
  private reloadPressed = false;
  private erasePressed = false;

  // Last state flushed to the DOM (NaN forces the first flush).
  private appliedStickActive = false;
  private appliedBaseX = NaN;
  private appliedBaseY = NaN;
  private appliedKnobX = NaN;
  private appliedKnobY = NaN;
  private appliedJumpPressed = false;
  private appliedFirePressed = false;
  private appliedReloadPressed = false;
  private appliedErasePressed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    uiParent: HTMLElement,
    private readonly input: InputState,
    /** RAW pixel deltas — the game applies touch look sensitivity. */
    private readonly onLookDelta: (dxPx: number, dyPx: number) => void,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'touch-controls';

    this.stickBase = document.createElement('div');
    this.stickBase.className = 'joystick-base';
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'joystick-knob';
    this.stickBase.appendChild(this.stickKnob);

    // Icon-only (CSS chevron); the label keeps it accessible.
    this.jumpButton = document.createElement('button');
    this.jumpButton.className = 'jump-btn';
    this.jumpButton.type = 'button';
    this.jumpButton.setAttribute('aria-label', 'Jump');

    // Icon-only crosshair glyph, drawn in CSS.
    this.fireButton = document.createElement('button');
    this.fireButton.className = 'fire-btn';
    this.fireButton.type = 'button';
    this.fireButton.setAttribute('aria-label', 'Fire');

    this.reloadButton = document.createElement('button');
    this.reloadButton.className = 'reload-btn';
    this.reloadButton.type = 'button';
    this.reloadButton.setAttribute('aria-label', 'Reload');
    this.reloadButton.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
      '<path d="M12 5a7 7 0 1 1-6.4 4.2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/>' +
      '<path d="M5.2 3.4v6h6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/></svg>';

    // Magic-ink controls: DRAW toggles sketch mode, ERASE is hold-to-erase.
    this.drawButton = document.createElement('button');
    this.drawButton.className = 'draw-btn';
    this.drawButton.type = 'button';
    this.drawButton.setAttribute('aria-label', 'Draw');
    this.drawButton.textContent = '✎';

    this.eraseButton = document.createElement('button');
    this.eraseButton.className = 'erase-btn';
    this.eraseButton.type = 'button';
    this.eraseButton.setAttribute('aria-label', 'Erase');
    this.eraseButton.textContent = '⌫';

    this.layer.append(
      this.stickBase,
      this.jumpButton,
      this.fireButton,
      this.reloadButton,
      this.drawButton,
      this.eraseButton,
    );
    uiParent.appendChild(this.layer);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerEnd);
    this.canvas.addEventListener('pointercancel', this.handlePointerEnd);
    this.jumpButton.addEventListener('pointerdown', this.handleJumpDown);
    this.jumpButton.addEventListener('pointerup', this.handleJumpUp);
    this.jumpButton.addEventListener('pointercancel', this.handleJumpUp);
    this.fireButton.addEventListener('pointerdown', this.handleFireDown);
    this.fireButton.addEventListener('pointerup', this.handleFireUp);
    this.fireButton.addEventListener('pointercancel', this.handleFireUp);
    this.reloadButton.addEventListener('pointerdown', this.handleReloadDown);
    this.reloadButton.addEventListener('pointerup', this.handleReloadUp);
    this.reloadButton.addEventListener('pointercancel', this.handleReloadUp);
    this.drawButton.addEventListener('pointerdown', this.handleDrawDown);
    this.eraseButton.addEventListener('pointerdown', this.handleEraseDown);
    this.eraseButton.addEventListener('pointerup', this.handleEraseUp);
    this.eraseButton.addEventListener('pointercancel', this.handleEraseUp);
    document.addEventListener('contextmenu', this.suppressContextMenu);
  }

  dispose(): void {
    if (this.attached) {
      this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
      this.canvas.removeEventListener('pointermove', this.handlePointerMove);
      this.canvas.removeEventListener('pointerup', this.handlePointerEnd);
      this.canvas.removeEventListener('pointercancel', this.handlePointerEnd);
      this.jumpButton.removeEventListener('pointerdown', this.handleJumpDown);
      this.jumpButton.removeEventListener('pointerup', this.handleJumpUp);
      this.jumpButton.removeEventListener('pointercancel', this.handleJumpUp);
      this.fireButton.removeEventListener('pointerdown', this.handleFireDown);
      this.fireButton.removeEventListener('pointerup', this.handleFireUp);
      this.fireButton.removeEventListener('pointercancel', this.handleFireUp);
      this.reloadButton.removeEventListener('pointerdown', this.handleReloadDown);
      this.reloadButton.removeEventListener('pointerup', this.handleReloadUp);
      this.reloadButton.removeEventListener('pointercancel', this.handleReloadUp);
      this.drawButton.removeEventListener('pointerdown', this.handleDrawDown);
      this.eraseButton.removeEventListener('pointerdown', this.handleEraseDown);
      this.eraseButton.removeEventListener('pointerup', this.handleEraseUp);
      this.eraseButton.removeEventListener('pointercancel', this.handleEraseUp);
      document.removeEventListener('contextmenu', this.suppressContextMenu);
      this.attached = false;
    }
    this.pointers.clear();
    this.input.firePressed = false;
    this.input.erasePressed = false;
    this.layer.remove();
  }

  /** Flush buffered UI state to the DOM. Call once per frame from the rAF loop. */
  update(): void {
    if (this.stickActive !== this.appliedStickActive) {
      this.appliedStickActive = this.stickActive;
      this.stickBase.classList.toggle('joystick-active', this.stickActive);
    }
    if (this.stickActive) {
      if (this.stickBaseX !== this.appliedBaseX || this.stickBaseY !== this.appliedBaseY) {
        this.appliedBaseX = this.stickBaseX;
        this.appliedBaseY = this.stickBaseY;
        this.stickBase.style.left = `${this.stickBaseX}px`;
        this.stickBase.style.top = `${this.stickBaseY}px`;
      }
      if (this.knobX !== this.appliedKnobX || this.knobY !== this.appliedKnobY) {
        this.appliedKnobX = this.knobX;
        this.appliedKnobY = this.knobY;
        this.stickKnob.style.transform = `translate(-50%, -50%) translate(${this.knobX}px, ${this.knobY}px)`;
      }
    }
    if (this.jumpPressed !== this.appliedJumpPressed) {
      this.appliedJumpPressed = this.jumpPressed;
      this.jumpButton.classList.toggle('jump-pressed', this.jumpPressed);
    }
    if (this.firePressed !== this.appliedFirePressed) {
      this.appliedFirePressed = this.firePressed;
      this.fireButton.classList.toggle('fire-pressed', this.firePressed);
    }
    if (this.reloadPressed !== this.appliedReloadPressed) {
      this.appliedReloadPressed = this.reloadPressed;
      this.reloadButton.classList.toggle('reload-pressed', this.reloadPressed);
    }
    if (this.erasePressed !== this.appliedErasePressed) {
      this.appliedErasePressed = this.erasePressed;
      this.eraseButton.classList.toggle('erase-pressed', this.erasePressed);
    }
  }

  /** Combat-only buttons are pointless in escape mode (no shooting). */
  setCombatButtonsVisible(visible: boolean): void {
    this.fireButton.hidden = !visible;
    this.reloadButton.hidden = !visible;
  }

  private suppressContextMenu = (e: Event): void => e.preventDefault();

  private hasPointerOfKind(kind: 'move' | 'look'): boolean {
    for (const p of this.pointers.values()) if (p.kind === kind) return true;
    return false;
  }

  private handlePointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture can fail if the pointer already ended; tracking still works.
    }

    const leftHalf = e.clientX < window.innerWidth / 2;
    if (leftHalf && !this.hasPointerOfKind('move')) {
      // Clamp the base so the whole joystick stays on screen near edges.
      const margin = STICK_RADIUS + 24;
      const baseX = Math.min(Math.max(e.clientX, margin), window.innerWidth - margin);
      const baseY = Math.min(Math.max(e.clientY, margin), window.innerHeight - margin);
      this.pointers.set(e.pointerId, { kind: 'move', baseX, baseY });
      this.stickActive = true;
      this.stickBaseX = baseX;
      this.stickBaseY = baseY;
      this.updateStick(e.clientX, e.clientY, baseX, baseY);
    } else if (!this.hasPointerOfKind('look')) {
      this.pointers.set(e.pointerId, { kind: 'look', lastX: e.clientX, lastY: e.clientY });
    }
  };

  private handlePointerMove = (e: PointerEvent): void => {
    const pointer = this.pointers.get(e.pointerId);
    if (!pointer) return;
    e.preventDefault();

    if (pointer.kind === 'move') {
      this.updateStick(e.clientX, e.clientY, pointer.baseX, pointer.baseY);
    } else {
      const dx = e.clientX - pointer.lastX;
      const dy = e.clientY - pointer.lastY;
      pointer.lastX = e.clientX;
      pointer.lastY = e.clientY;
      this.onLookDelta(dx, dy);
    }
  };

  private handlePointerEnd = (e: PointerEvent): void => {
    const pointer = this.pointers.get(e.pointerId);
    if (!pointer) return;
    e.preventDefault();
    this.pointers.delete(e.pointerId);
    if (pointer.kind === 'move') {
      this.input.moveX = 0;
      this.input.moveY = 0;
      this.stickActive = false;
    }
  };

  private updateStick(x: number, y: number, baseX: number, baseY: number): void {
    let dx = x - baseX;
    let dy = y - baseY;
    const dist = Math.hypot(dx, dy);
    if (dist > STICK_RADIUS) {
      dx *= STICK_RADIUS / dist;
      dy *= STICK_RADIUS / dist;
    }
    this.knobX = dx;
    this.knobY = dy;

    let nx = dx / STICK_RADIUS;
    let ny = dy / STICK_RADIUS;
    const len = Math.hypot(nx, ny);
    if (len < DEAD_ZONE) {
      nx = 0;
      ny = 0;
    } else {
      // Rescale so movement ramps smoothly from 0 just outside the dead zone.
      const scale = (len - DEAD_ZONE) / (1 - DEAD_ZONE) / len;
      nx *= scale;
      ny *= scale;
    }
    this.input.moveX = nx;
    this.input.moveY = -ny; // screen-up = forward
  }

  private handleJumpDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.input.jumpQueuedAt = performance.now();
    this.jumpPressed = true;
  };

  private handleJumpUp = (e: PointerEvent): void => {
    e.preventDefault();
    this.jumpPressed = false;
  };

  private handleFireDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.input.firePressed = true;
    this.firePressed = true;
  };

  private handleFireUp = (e: PointerEvent): void => {
    e.preventDefault();
    this.input.firePressed = false;
    this.firePressed = false;
  };

  private handleReloadDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.input.reloadQueued = true;
    this.reloadPressed = true;
  };

  private handleReloadUp = (e: PointerEvent): void => {
    e.preventDefault();
    this.reloadPressed = false;
  };

  private handleDrawDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.input.sketchToggleQueued = true;
  };

  private handleEraseDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.input.erasePressed = true;
    this.erasePressed = true;
  };

  private handleEraseUp = (e: PointerEvent): void => {
    e.preventDefault();
    this.input.erasePressed = false;
    this.erasePressed = false;
  };
}
