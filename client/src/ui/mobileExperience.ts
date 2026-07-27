const PORTRAIT_DISMISS_KEY = 'boomboom:portrait-dismissed';

function isCoarsePointer(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

function isPortrait(): boolean {
  return window.matchMedia('(orientation: portrait)').matches;
}

function wasDismissed(): boolean {
  try {
    return sessionStorage.getItem(PORTRAIT_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function setDismissed(): void {
  try {
    sessionStorage.setItem(PORTRAIT_DISMISS_KEY, '1');
  } catch {
    // Session storage may be unavailable.
  }
}

/** True when the Fullscreen API is available on the document element. */
export function isFullscreenSupported(): boolean {
  const doc = document.documentElement as HTMLElement & {
    requestFullscreen?: () => Promise<void>;
    webkitRequestFullscreen?: () => Promise<void>;
  };
  return typeof doc.requestFullscreen === 'function' || typeof doc.webkitRequestFullscreen === 'function';
}

export function isFullscreenActive(): boolean {
  return !!(
    document.fullscreenElement ||
    (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement
  );
}

export async function toggleFullscreen(): Promise<void> {
  if (!isFullscreenSupported()) return;

  if (isFullscreenActive()) {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
    return;
  }

  const el = document.documentElement as HTMLElement & {
    requestFullscreen?: () => Promise<void>;
    webkitRequestFullscreen?: () => Promise<void>;
  };
  if (el.requestFullscreen) await el.requestFullscreen();
  else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
}

export interface MobileExperience {
  /** Call once at boot; wires orientation listeners. */
  init(): void;
  /** True when the rotate overlay should be visible right now. */
  shouldShowRotateOverlay(): boolean;
  /** Create the rotate overlay element (caller appends to DOM). */
  createRotateOverlay(onDismiss: () => void): HTMLElement;
}

export function createMobileExperience(): MobileExperience {
  let dismissed = wasDismissed();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const fn of listeners) fn();
  }

  function shouldShow(): boolean {
    return isCoarsePointer() && isPortrait() && !dismissed;
  }

  return {
    init() {
      const onOrientation = (): void => {
        // Re-show recommendation when rotating back to portrait unless dismissed.
        if (!isPortrait()) return;
        notify();
      };
      window.addEventListener('orientationchange', onOrientation);
      window.addEventListener('resize', onOrientation);
    },

    shouldShowRotateOverlay: shouldShow,

    createRotateOverlay(onDismiss) {
      const el = document.createElement('div');
      el.className = 'rotate-overlay';
      el.innerHTML = `
        <div class="rotate-card panel">
          <div class="rotate-icon" aria-hidden="true">↻</div>
          <h2 class="rotate-title">ROTATE YOUR PHONE</h2>
          <p class="rotate-copy">BoomBoom plays best in landscape. Turn your device sideways for the full experience.</p>
          <button class="btn btn-secondary" data-action="dismiss">PLAY ANYWAY</button>
        </div>
      `;

      el.querySelector<HTMLButtonElement>('[data-action="dismiss"]')!.addEventListener('click', () => {
        dismissed = true;
        setDismissed();
        el.remove();
        onDismiss();
      });

      return el;
    },
  };
}

/** Subscribe to orientation/dismiss changes (for overlay re-show logic). */
export function onMobileExperienceChange(
  mobile: MobileExperience,
  cb: () => void,
): () => void {
  const handler = (): void => cb();
  window.addEventListener('orientationchange', handler);
  window.addEventListener('resize', handler);
  return () => {
    window.removeEventListener('orientationchange', handler);
    window.removeEventListener('resize', handler);
  };
}
