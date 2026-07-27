import { MAX_PLAYERS_PER_ROOM } from '../../../shared/constants';
import type { MatchMode, RoomSnapshot } from '../../../shared/types';

export interface LobbyScreen {
  el: HTMLElement;
  update(room: RoomSnapshot, selfId: string): void;
}

const MODES: ReadonlyArray<{ mode: MatchMode; label: string; hint?: string }> = [
  { mode: 'endless', label: 'ENDLESS' },
  { mode: 'kills', label: 'FIRST TO 10' },
  { mode: 'timed', label: 'TIMED 5:00' },
  { mode: 'escape', label: 'ESCAPE ROOM', hint: 'CO-OP' },
  { mode: 'party', label: 'DOODLE ROYALE', hint: '5 ROUNDS' },
];

export function createLobby(opts: {
  onStart(mode: MatchMode): void;
  onLeave(): void;
}): LobbyScreen {
  const el = document.createElement('div');
  el.className = 'screen screen-lobby';
  el.innerHTML = `
    <div class="card panel lobby-card">
      <div class="share-label label">SHARE CODE</div>
      <div class="room-code" data-code></div>

      <div class="lobby-players-header">
        <span class="label">SQUAD</span>
        <span class="player-count" data-count></span>
      </div>
      <ul class="player-list" data-players></ul>

      <div class="lobby-actions" data-actions></div>
      <button class="btn btn-ghost" data-action="leave">LEAVE</button>
    </div>
  `;

  const codeEl = el.querySelector<HTMLElement>('[data-code]')!;
  const countEl = el.querySelector<HTMLElement>('[data-count]')!;
  const listEl = el.querySelector<HTMLUListElement>('[data-players]')!;
  const actionsEl = el.querySelector<HTMLElement>('[data-actions]')!;

  el.querySelector<HTMLButtonElement>('[data-action="leave"]')!.addEventListener(
    'click',
    () => opts.onLeave(),
  );

  // The host's pick survives roster updates (update() rebuilds the actions area).
  let selectedMode: MatchMode = 'endless';

  function buildModeSelector(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'mode-select';

    const label = document.createElement('div');
    label.className = 'label mode-label';
    label.textContent = 'MODE';
    wrap.appendChild(label);

    const row = document.createElement('div');
    row.className = 'mode-row';
    for (const { mode, label: text, hint } of MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mode-btn';
      btn.dataset['mode'] = mode;
      btn.textContent = text;
      if (hint) {
        const badge = document.createElement('span');
        badge.className = 'mode-hint';
        badge.textContent = hint;
        btn.appendChild(badge);
      }
      btn.setAttribute('aria-pressed', String(mode === selectedMode));
      btn.classList.toggle('mode-active', mode === selectedMode);
      btn.addEventListener('click', () => {
        selectedMode = mode;
        for (const other of row.children) {
          const b = other as HTMLButtonElement;
          const active = b.dataset['mode'] === mode;
          b.classList.toggle('mode-active', active);
          b.setAttribute('aria-pressed', String(active));
        }
      });
      row.appendChild(btn);
    }
    wrap.appendChild(row);
    return wrap;
  }

  function update(room: RoomSnapshot, selfId: string): void {
    codeEl.textContent = room.code;
    countEl.textContent = `${room.players.length}/${MAX_PLAYERS_PER_ROOM}`;

    listEl.replaceChildren(
      ...room.players.map((p) => {
        const li = document.createElement('li');
        li.className = 'player-row';

        const dot = document.createElement('span');
        dot.className = 'player-dot';
        dot.style.background = p.color;

        const name = document.createElement('span');
        name.className = 'player-name';
        name.textContent = p.name;

        li.append(dot, name);

        if (p.id === room.hostId) {
          const tag = document.createElement('span');
          tag.className = 'player-tag player-tag-host';
          tag.textContent = 'HOST';
          li.appendChild(tag);
        }
        if (p.id === selfId) {
          const tag = document.createElement('span');
          tag.className = 'player-tag';
          tag.textContent = 'YOU';
          li.appendChild(tag);
        }
        return li;
      }),
    );

    actionsEl.replaceChildren();
    if (selfId === room.hostId) {
      actionsEl.appendChild(buildModeSelector());

      const startBtn = document.createElement('button');
      startBtn.className = 'btn btn-primary';
      startBtn.textContent = 'START GAME';
      startBtn.addEventListener('click', () => {
        startBtn.disabled = true;
        opts.onStart(selectedMode);
      });
      actionsEl.appendChild(startBtn);
    } else {
      const waiting = document.createElement('div');
      waiting.className = 'waiting-note';
      waiting.innerHTML = '<span class="pulse-dot"></span> WAITING FOR HOST…';
      actionsEl.appendChild(waiting);
    }
  }

  return { el, update };
}
