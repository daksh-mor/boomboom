import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from '../../../shared/constants';

const NAME_STORAGE_KEY = 'boomboom:name';

export function loadSavedName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Storage may be unavailable (private mode); the game works without it.
  }
}

export interface LandingScreen {
  el: HTMLElement;
  /** Re-enables the action buttons (e.g. after a room:error). */
  setPending(pending: boolean): void;
}

export function createLanding(opts: {
  onCreate(name: string): void;
  onJoin(code: string, name: string): void;
}): LandingScreen {
  const el = document.createElement('div');
  el.className = 'screen screen-landing';
  el.innerHTML = `
    <div class="card panel landing-card">
      <h1 class="logo">BOOM<span class="logo-accent">BOOM</span></h1>
      <p class="tagline">BoomBoom — Doodle Royale. Draw it. Climb it. Survive it.</p>

      <label class="field-label label" for="landing-name">CALLSIGN</label>
      <input id="landing-name" class="text-input" type="text" autocomplete="nickname"
             maxlength="${MAX_NAME_LENGTH}" placeholder="ROCKET" spellcheck="false" />
      <div class="field-error" data-error="name"></div>

      <button class="btn btn-primary" data-action="create">CREATE ROOM</button>

      <div class="divider"><span>OR JOIN</span></div>

      <div class="join-row">
        <input class="text-input code-input" type="text" inputmode="text"
               autocapitalize="characters" autocomplete="off" spellcheck="false"
               maxlength="${ROOM_CODE_LENGTH}" placeholder="CODE" aria-label="Room code" />
        <button class="btn btn-secondary" data-action="join">JOIN</button>
      </div>
      <div class="field-error" data-error="code"></div>
    </div>
  `;

  const nameInput = el.querySelector<HTMLInputElement>('#landing-name')!;
  const codeInput = el.querySelector<HTMLInputElement>('.code-input')!;
  const createBtn = el.querySelector<HTMLButtonElement>('[data-action="create"]')!;
  const joinBtn = el.querySelector<HTMLButtonElement>('[data-action="join"]')!;
  const nameError = el.querySelector<HTMLElement>('[data-error="name"]')!;
  const codeError = el.querySelector<HTMLElement>('[data-error="code"]')!;

  nameInput.value = loadSavedName();

  let pendingResetTimer = 0;

  function setPending(pending: boolean): void {
    createBtn.disabled = pending;
    joinBtn.disabled = pending;
    window.clearTimeout(pendingResetTimer);
    if (pending) {
      pendingResetTimer = window.setTimeout(() => setPending(false), 4000);
    }
  }

  function validatedName(): string | null {
    const name = nameInput.value.trim();
    if (!name) {
      nameError.textContent = 'Pick a name first';
      nameInput.focus();
      return null;
    }
    saveName(name);
    return name;
  }

  nameInput.addEventListener('input', () => {
    nameError.textContent = '';
  });

  codeInput.addEventListener('input', () => {
    codeError.textContent = '';
    const cleaned = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned !== codeInput.value) codeInput.value = cleaned;
  });

  createBtn.addEventListener('click', () => {
    const name = validatedName();
    if (!name) return;
    setPending(true);
    opts.onCreate(name);
  });

  function tryJoin(): void {
    const name = validatedName();
    if (!name) return;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== ROOM_CODE_LENGTH) {
      codeError.textContent = `Enter the ${ROOM_CODE_LENGTH}-character room code`;
      codeInput.focus();
      return;
    }
    setPending(true);
    opts.onJoin(code, name);
  }

  joinBtn.addEventListener('click', tryJoin);
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryJoin();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createBtn.click();
  });

  return { el, setPending };
}
