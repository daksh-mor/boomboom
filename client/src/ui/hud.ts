import { MAG_SIZE, MAX_HEALTH } from '../../../shared/constants';
import type { MatchEndReason, MatchMode } from '../../../shared/types';
import {
  isFullscreenActive,
  isFullscreenSupported,
  toggleFullscreen,
} from './mobileExperience';

const TICK_MS = 200; // drives timer / countdowns / kill-feed pruning
const KILL_FEED_TTL_MS = 4000;
const KILL_FEED_FADE_MS = 350;
const KILL_FEED_MAX = 5;
const HIT_MARKER_MS = 120;
/** Server returns the room to the lobby ~7s after match:ended (cosmetic countdown). */
const LOBBY_RETURN_MS = 7000;

export interface ScoreRow {
  id: string;
  name: string;
  color: string;
  kills: number;
  deaths: number;
  isSelf: boolean;
}

interface KillEntry {
  el: HTMLElement;
  expiresAt: number;
  removeAt: number; // 0 until the fade-out started
}

export interface HudScreen {
  el: HTMLElement;
  /** Layer touch controls mount into (sits above the canvas, below HUD chrome). */
  touchLayer: HTMLElement;
  /** Layer the sketch-mode overlay mounts into (above the touch controls). */
  sketchLayer: HTMLElement;
  setRoomInfo(code: string, playerCount: number): void;
  setLockHintVisible(visible: boolean): void;
  /** Smoothly updates the bar width and its green -> yellow -> red color. */
  setHealth(health: number): void;
  /** Ammo counter + reload progress; progress is 0..1 while reloading. */
  setAmmo(mag: number, reloading: boolean, progress: number): void;
  /** Predicted ink meter (meters of stroke remaining). */
  setInk(ink: number, cap: number): void;
  /** Escape objective line (top center); null hides it. */
  setObjective(text: string | null): void;
  /** White crosshair tick flash on an own confirmed hit (~120ms). */
  flashHitMarker(): void;
  /** Red vignette pulse when the local player takes damage. */
  flashDamage(): void;
  addKill(killerName: string, killerColor: string, victimName: string, victimColor: string): void;
  setMatchInfo(
    mode: MatchMode | null,
    endsAt: number | null,
    targetKills: number | null,
    startedAt: number | null,
  ): void;
  /** Latest scoreboard rows, already joined with names/colors and sorted. */
  setScores(rows: readonly ScoreRow[]): void;
  /** Pin the scoreboard open with a match-end title and lobby countdown. */
  showMatchEnd(reason: MatchEndReason, escapeTimeMs: number | null): void;
  /**
   * Pin the scoreboard as a round card: title over live standings, with
   * "{subLabel} {n}" counting down to `until` and an optional announcer line.
   */
  showRoundCard(title: string, subLabel: string, until: number, announcer?: string | null): void;
  hideRoundCard(): void;
  /** Party in-round countdown for the timer chip; null hides it. */
  setRoundTimer(endsAt: number | null): void;
  /** Big top-center floor-check warning pulse; auto-clears, no timers leaked. */
  flashKlaxon(seconds: number): void;
  /** "The Critic" announcer line in the kill-feed lane (same TTL mechanics). */
  addQuip(text: string): void;
  /** Party podium: pinned board with champion title, announcer sub and SAVE THE ART. */
  showPodium(rows: readonly ScoreRow[], championName: string, announcer: string): void;
  showDeathOverlay(killerName: string, respawnAt: number): void;
  /** Party variant of the death overlay: ELIMINATED + "NEXT ROUND IN n". */
  showEliminated(roundEndsAt: number): void;
  hideDeathOverlay(): void;
  /** FPS (rolling average, ~2x/s) and ping RTT (every ~2s); null = unknown yet. */
  setPerf(fps: number | null, rttMs: number | null): void;
  dispose(): void;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Up-counting variant (escape timer): floors so it ticks forward. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function createHud(opts: { onLeave(): void; onSaveArt?(): void }): HudScreen {
  const el = document.createElement('div');
  el.className = 'screen screen-hud';
  el.innerHTML = `
    <div class="damage-vignette" data-vignette aria-hidden="true"></div>
    <div class="hud-top">
      <button type="button" class="hud-badge chip" data-badge aria-label="Toggle scoreboard">
        <span class="hud-code" data-code></span>
        <span class="hud-count" data-count></span>
      </button>
      <div class="hud-timer chip" data-timer hidden></div>
      <div class="hud-objective chip" data-objective hidden></div>
      <div class="hud-actions">
        <div class="hud-perf chip" data-perf>-- FPS · -- MS</div>
        <button class="hud-btn hud-fullscreen" data-action="fullscreen" hidden aria-label="Toggle fullscreen">⛶</button>
        <button class="hud-btn hud-leave" data-action="leave">LEAVE</button>
      </div>
    </div>
    <div class="kill-feed" data-kill-feed></div>
    <div class="hud-klaxon" data-klaxon hidden aria-live="assertive"></div>
    <div class="crosshair" aria-hidden="true">
      <div class="hit-marker" data-hit-marker></div>
    </div>
    <div class="lock-hint chip" data-hint hidden>CLICK TO PLAY</div>
    <div class="hud-bl">
      <div class="hud-kd chip" data-kd>K 0 · D 0</div>
      <div class="ink-row" data-ink-row>
        <span class="ink-label">INK</span>
        <div class="ink-bar"><div class="ink-fill" data-ink-fill></div></div>
        <span class="ink-value" data-ink-value></span>
      </div>
      <div class="health-bar" data-health-bar>
        <div class="health-fill" data-health-fill></div>
      </div>
    </div>
    <div class="hud-ammo" data-ammo>
      <div class="ammo-line">
        <span class="ammo-mag" data-ammo-mag>${MAG_SIZE}</span><span class="ammo-cap">/ ${MAG_SIZE}</span>
      </div>
      <div class="reload-bar" data-reload-bar hidden>
        <div class="reload-fill" data-reload-fill></div>
        <span class="reload-label">RELOADING</span>
      </div>
    </div>
    <div class="touch-layer" data-touch-layer></div>
    <div class="sketch-layer" data-sketch-layer></div>
    <div class="death-overlay" data-death hidden>
      <div class="death-inner">
        <div class="death-label" data-death-label>SPLATTED BY</div>
        <div class="death-killer" data-death-killer></div>
        <div class="death-count" data-death-count></div>
      </div>
    </div>
    <div class="scoreboard" data-scoreboard hidden>
      <div class="scoreboard-panel panel">
        <div class="scoreboard-title" data-sb-title>SCOREBOARD</div>
        <div class="scoreboard-sub" data-sb-sub hidden></div>
        <div class="scoreboard-announcer" data-sb-announcer hidden></div>
        <div class="scoreboard-head"><span>PLAYER</span><span data-sb-col-k>K</span><span data-sb-col-d>D</span></div>
        <ul class="scoreboard-rows" data-sb-rows></ul>
        <button type="button" class="btn btn-primary podium-save" data-save-art hidden>SAVE THE ART</button>
      </div>
    </div>
  `;

  const q = <T extends HTMLElement>(sel: string): T => el.querySelector<T>(sel)!;
  const codeEl = q('[data-code]');
  const countEl = q('[data-count]');
  const hintEl = q('[data-hint]');
  const touchLayer = q('[data-touch-layer]');
  const sketchLayer = q('[data-sketch-layer]');
  const objectiveEl = q('[data-objective]');
  const inkFillEl = q('[data-ink-fill]');
  const inkValueEl = q('[data-ink-value]');
  const fullscreenBtn = q<HTMLButtonElement>('[data-action="fullscreen"]');
  const badgeEl = q<HTMLButtonElement>('[data-badge]');
  const timerEl = q('[data-timer]');
  const perfEl = q('[data-perf]');
  const vignetteEl = q('[data-vignette]');
  const hitMarkerEl = q('[data-hit-marker]');
  const kdEl = q('[data-kd]');
  const healthFillEl = q('[data-health-fill]');
  const ammoMagEl = q('[data-ammo-mag]');
  const reloadBarEl = q('[data-reload-bar]');
  const reloadFillEl = q('[data-reload-fill]');
  const killFeedEl = q('[data-kill-feed]');
  const klaxonEl = q('[data-klaxon]');
  const deathEl = q('[data-death]');
  const deathLabelEl = q('[data-death-label]');
  const deathKillerEl = q('[data-death-killer]');
  const deathCountEl = q('[data-death-count]');
  const scoreboardEl = q('[data-scoreboard]');
  const sbTitleEl = q('[data-sb-title]');
  const sbSubEl = q('[data-sb-sub]');
  const sbAnnouncerEl = q('[data-sb-announcer]');
  const sbColKEl = q('[data-sb-col-k]');
  const sbColDEl = q('[data-sb-col-d]');
  const sbRowsEl = q<HTMLUListElement>('[data-sb-rows]');
  const saveArtBtn = q<HTMLButtonElement>('[data-save-art]');

  saveArtBtn.addEventListener('click', () => opts.onSaveArt?.());

  // ------------------------------------------------------------ fullscreen
  const updateFullscreenBtn = (): void => {
    if (!isFullscreenSupported()) {
      fullscreenBtn.hidden = true;
      return;
    }
    fullscreenBtn.hidden = false;
    fullscreenBtn.setAttribute('aria-label', isFullscreenActive() ? 'Exit fullscreen' : 'Enter fullscreen');
    fullscreenBtn.classList.toggle('hud-fullscreen-active', isFullscreenActive());
  };

  if (isFullscreenSupported()) {
    fullscreenBtn.hidden = false;
    document.addEventListener('fullscreenchange', updateFullscreenBtn);
    document.addEventListener('webkitfullscreenchange', updateFullscreenBtn);
    fullscreenBtn.addEventListener('click', () => {
      void toggleFullscreen().then(updateFullscreenBtn).catch(() => {});
    });
  }

  q<HTMLButtonElement>('[data-action="leave"]').addEventListener('click', () => opts.onLeave());

  // ------------------------------------------------------------ hud state
  let mode: MatchMode | null = null;
  let endsAt: number | null = null;
  let targetKills: number | null = null;
  let startedAt: number | null = null;
  let leaderKills = 0;
  let lastTimerText = '';
  let lastInkText = '';

  let lastMag = MAG_SIZE;
  let lastReloading = false;
  let lastHealthPct = 100;
  let lastKd = 'K 0 · D 0';
  let lastFps: number | null = null;
  let lastRtt: number | null = null;
  let hitMarkerTimer = 0;

  const killEntries: KillEntry[] = [];

  let scores: readonly ScoreRow[] = [];
  let sbTabHeld = false;
  let sbToggled = false;
  let sbPinned = false;
  let sbVisible = false;
  let deathRespawnAt: number | null = null;
  let deathCountLabel = 'RESPAWNING IN';
  let deathZeroText = 'RESPAWNING…';
  /** Pinned-card countdown: sub reads "{label} {n}" until this epoch ms. */
  let cardCountdownLabel = '';
  let cardCountdownUntil: number | null = null;
  /** Party in-round countdown for the timer chip. */
  let roundEndsAt: number | null = null;
  /** Klaxon auto-clear deadline, handled by the shared tick (no extra timers). */
  let klaxonHideAt: number | null = null;

  function renderScores(): void {
    sbRowsEl.replaceChildren(
      ...scores.map((row) => {
        const li = document.createElement('li');
        li.className = row.isSelf ? 'sb-row sb-self' : 'sb-row';

        const dot = document.createElement('span');
        dot.className = 'sb-dot';
        dot.style.background = row.color;

        const name = document.createElement('span');
        name.className = 'sb-name';
        name.textContent = row.name;

        const kills = document.createElement('span');
        kills.className = 'sb-kills';
        kills.textContent = String(row.kills);

        const deaths = document.createElement('span');
        deaths.className = 'sb-deaths';
        deaths.textContent = String(row.deaths);

        li.append(dot, name, kills, deaths);
        return li;
      }),
    );
  }

  function syncScoreboard(): void {
    const visible = sbPinned || sbTabHeld || sbToggled;
    if (visible === sbVisible) return;
    sbVisible = visible;
    scoreboardEl.hidden = !visible;
    if (visible) renderScores();
  }

  function updateTimerChip(): void {
    if (mode === 'timed' && endsAt !== null) {
      const text = formatClock(endsAt - Date.now());
      if (text !== lastTimerText) {
        lastTimerText = text;
        timerEl.textContent = text;
      }
      timerEl.hidden = false;
    } else if (mode === 'party') {
      if (roundEndsAt !== null) {
        const text = formatClock(roundEndsAt - Date.now());
        if (text !== lastTimerText) {
          lastTimerText = text;
          timerEl.textContent = text;
        }
        timerEl.hidden = false;
      } else {
        timerEl.hidden = true;
      }
    } else if (mode === 'escape' && startedAt !== null) {
      const text = formatElapsed(Date.now() - startedAt);
      if (text !== lastTimerText) {
        lastTimerText = text;
        timerEl.textContent = text;
      }
      timerEl.hidden = false;
    } else if (mode === 'kills') {
      const text = `BEST ${leaderKills}/${targetKills ?? 0}`;
      if (text !== lastTimerText) {
        lastTimerText = text;
        timerEl.textContent = text;
      }
      timerEl.hidden = false;
    } else {
      timerEl.hidden = true;
    }
  }

  // Hold Tab for the scoreboard (desktop). preventDefault keeps focus in place.
  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    if (!e.repeat) {
      sbTabHeld = true;
      syncScoreboard();
    }
  };
  const handleKeyUp = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    sbTabHeld = false;
    syncScoreboard();
  };
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

  // Tap the room badge to toggle it (mobile has no Tab key).
  badgeEl.addEventListener('click', () => {
    sbToggled = !sbToggled;
    syncScoreboard();
  });

  const tick = (): void => {
    const now = Date.now();
    updateTimerChip();

    if (deathRespawnAt !== null) {
      const remaining = Math.max(0, Math.ceil((deathRespawnAt - now) / 1000));
      deathCountEl.textContent = remaining > 0 ? `${deathCountLabel} ${remaining}` : deathZeroText;
    }

    if (cardCountdownUntil !== null) {
      const remaining = Math.max(0, Math.ceil((cardCountdownUntil - now) / 1000));
      sbSubEl.textContent = `${cardCountdownLabel} ${remaining}`;
    }

    if (klaxonHideAt !== null && now >= klaxonHideAt) {
      klaxonHideAt = null;
      klaxonEl.hidden = true;
    }

    // Kill feed pruning: fade out, then drop.
    const perfNow = performance.now();
    for (let i = killEntries.length - 1; i >= 0; i--) {
      const entry = killEntries[i]!;
      if (entry.removeAt !== 0) {
        if (perfNow >= entry.removeAt) {
          entry.el.remove();
          killEntries.splice(i, 1);
        }
      } else if (perfNow >= entry.expiresAt) {
        entry.el.classList.add('kill-out');
        entry.removeAt = perfNow + KILL_FEED_FADE_MS;
      }
    }
  };
  const tickTimer = window.setInterval(tick, TICK_MS);

  function showRoundCardImpl(
    title: string,
    subLabel: string,
    until: number | null,
    announcer?: string | null,
  ): void {
    sbTitleEl.textContent = title;
    cardCountdownLabel = subLabel;
    cardCountdownUntil = until;
    if (until === null) sbSubEl.textContent = subLabel; // static sub line
    sbSubEl.hidden = false;
    if (announcer) {
      sbAnnouncerEl.textContent = `“${announcer}”`;
      sbAnnouncerEl.hidden = false;
    } else {
      sbAnnouncerEl.hidden = true;
    }
    saveArtBtn.hidden = true;
    sbPinned = true;
    syncScoreboard();
    tick();
  }

  function hideRoundCardImpl(): void {
    cardCountdownUntil = null;
    sbSubEl.hidden = true;
    sbAnnouncerEl.hidden = true;
    saveArtBtn.hidden = true;
    sbTitleEl.textContent = 'SCOREBOARD'; // Tab mid-round shows the plain board
    sbPinned = false;
    syncScoreboard();
  }

  return {
    el,
    touchLayer,
    sketchLayer,

    setRoomInfo(code, playerCount) {
      codeEl.textContent = code;
      countEl.textContent = `${playerCount}P`;
    },

    setLockHintVisible(visible) {
      hintEl.hidden = !visible;
    },

    setHealth(health) {
      const pct = Math.max(0, Math.min(100, (health / MAX_HEALTH) * 100));
      if (pct === lastHealthPct) return;
      lastHealthPct = pct;
      healthFillEl.style.width = `${pct}%`;
      // Green (120) -> yellow (60) -> red (0) as health drops.
      healthFillEl.style.background = `hsl(${Math.round(pct * 1.2)}, 85%, 52%)`;
    },

    setAmmo(mag, reloading, progress) {
      if (mag !== lastMag) {
        lastMag = mag;
        ammoMagEl.textContent = String(mag);
        ammoMagEl.classList.toggle('ammo-low', mag <= 2);
      }
      if (reloading !== lastReloading) {
        lastReloading = reloading;
        reloadBarEl.hidden = !reloading;
      }
      if (reloading) {
        reloadFillEl.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
      }
    },

    setInk(ink, cap) {
      const text = `${ink.toFixed(1)}m`;
      if (text !== lastInkText) {
        lastInkText = text;
        inkValueEl.textContent = text;
        const pct = Math.max(0, Math.min(100, (ink / cap) * 100));
        inkFillEl.style.width = `${pct}%`;
        inkFillEl.classList.toggle('ink-low', pct < 20);
      }
    },

    setObjective(text) {
      if (text === null) {
        objectiveEl.hidden = true;
      } else {
        objectiveEl.textContent = text;
        objectiveEl.hidden = false;
      }
    },

    flashHitMarker() {
      hitMarkerEl.classList.add('hit-show');
      window.clearTimeout(hitMarkerTimer);
      hitMarkerTimer = window.setTimeout(() => hitMarkerEl.classList.remove('hit-show'), HIT_MARKER_MS);
    },

    flashDamage() {
      vignetteEl.style.transition = 'none';
      vignetteEl.style.opacity = '0.9';
      requestAnimationFrame(() => {
        vignetteEl.style.transition = 'opacity 0.55s ease-out';
        vignetteEl.style.opacity = '0';
      });
    },

    addKill(killerName, killerColor, victimName, victimColor) {
      const entry = document.createElement('div');
      entry.className = 'kill-entry chip';

      const killer = document.createElement('span');
      killer.className = 'kill-name';
      killer.style.color = killerColor;
      killer.textContent = killerName;

      const glyph = document.createElement('span');
      glyph.className = 'kill-glyph';
      glyph.textContent = '✏';

      const victim = document.createElement('span');
      victim.className = 'kill-name';
      victim.style.color = victimColor;
      victim.textContent = victimName;

      entry.append(killer, glyph, victim);
      killFeedEl.prepend(entry);
      killEntries.push({ el: entry, expiresAt: performance.now() + KILL_FEED_TTL_MS, removeAt: 0 });

      // Cap the feed: drop the oldest (they are at the end of the container).
      while (killEntries.length > KILL_FEED_MAX) {
        const oldest = killEntries.shift()!;
        oldest.el.remove();
      }
    },

    setMatchInfo(newMode, newEndsAt, newTargetKills, newStartedAt) {
      mode = newMode;
      endsAt = newEndsAt;
      targetKills = newTargetKills;
      startedAt = newStartedAt;
      lastTimerText = '';
      // Party scores points, not kills — relabel the board columns.
      sbColKEl.textContent = mode === 'party' ? 'PTS' : 'K';
      sbColDEl.textContent = mode === 'party' ? 'OUT' : 'D';
      updateTimerChip();
    },

    setScores(rows) {
      scores = rows;
      leaderKills = 0;
      for (const row of rows) {
        if (row.kills > leaderKills) leaderKills = row.kills;
        if (row.isSelf) {
          const kd =
            mode === 'party' ? `PTS ${row.kills}` : `K ${row.kills} · D ${row.deaths}`;
          if (kd !== lastKd) {
            lastKd = kd;
            kdEl.textContent = kd;
          }
        }
      }
      if (mode === 'kills') updateTimerChip();
      if (sbVisible) renderScores();
    },

    showMatchEnd(reason, escapeTimeMs) {
      // Party ends on the podium card (party:round phase 'podium') — don't
      // stomp the champion title with a re-pin.
      if (reason === 'party') return;
      let title: string;
      if (reason === 'escape') {
        title = escapeTimeMs !== null ? `ESCAPED IN ${formatElapsed(escapeTimeMs)}` : 'ESCAPED!';
      } else if (reason === 'kills') {
        title = `FIRST TO ${targetKills ?? 10}`;
      } else {
        title = "TIME'S UP";
      }
      showRoundCardImpl(title, 'BACK TO LOBBY IN', Date.now() + LOBBY_RETURN_MS);
    },

    showRoundCard(title, subLabel, until, announcer) {
      showRoundCardImpl(title, subLabel, until, announcer);
    },

    hideRoundCard() {
      hideRoundCardImpl();
    },

    setRoundTimer(newRoundEndsAt) {
      roundEndsAt = newRoundEndsAt;
      lastTimerText = '';
      updateTimerChip();
    },

    flashKlaxon(seconds) {
      klaxonEl.textContent = `FLOOR CHECK IN ${seconds}!`;
      klaxonEl.hidden = false;
      klaxonHideAt = Date.now() + 950; // cleared by the shared tick
      klaxonEl.classList.remove('klaxon-flash');
      void klaxonEl.offsetWidth; // reflow restarts the CSS animation
      klaxonEl.classList.add('klaxon-flash');
      // Soft red edge flash (same pattern as flashDamage, gentler).
      vignetteEl.style.transition = 'none';
      vignetteEl.style.opacity = '0.4';
      requestAnimationFrame(() => {
        vignetteEl.style.transition = 'opacity 0.5s ease-out';
        vignetteEl.style.opacity = '0';
      });
    },

    addQuip(text) {
      const entry = document.createElement('div');
      entry.className = 'kill-entry quip-entry chip';
      entry.textContent = text;
      killFeedEl.prepend(entry);
      killEntries.push({ el: entry, expiresAt: performance.now() + KILL_FEED_TTL_MS, removeAt: 0 });
      while (killEntries.length > KILL_FEED_MAX) {
        const oldest = killEntries.shift()!;
        oldest.el.remove();
      }
    },

    showPodium(rows, championName, announcer) {
      scores = rows;
      el.classList.add('hud-podium');
      sbTitleEl.textContent = `CHAMPION: ${championName}`;
      cardCountdownUntil = null;
      sbSubEl.textContent = announcer;
      sbSubEl.hidden = false;
      sbAnnouncerEl.hidden = true;
      saveArtBtn.hidden = false;
      sbPinned = true;
      syncScoreboard();
      renderScores();
    },

    showDeathOverlay(killerName, respawnAt) {
      deathLabelEl.hidden = false;
      deathLabelEl.textContent = 'SPLATTED BY';
      deathKillerEl.textContent = killerName;
      deathCountLabel = 'RESPAWNING IN';
      deathZeroText = 'RESPAWNING…';
      deathRespawnAt = respawnAt;
      deathEl.hidden = false;
      tick();
    },

    showEliminated(until) {
      deathLabelEl.hidden = true;
      deathKillerEl.textContent = 'ELIMINATED';
      deathCountLabel = 'NEXT ROUND IN';
      deathZeroText = 'ROUND OVER';
      deathRespawnAt = until;
      deathEl.hidden = false;
      tick();
    },

    hideDeathOverlay() {
      deathRespawnAt = null;
      deathEl.hidden = true;
    },

    setPerf(fps, rttMs) {
      if (fps === lastFps && rttMs === lastRtt) return;
      lastFps = fps;
      lastRtt = rttMs;
      const fpsText = fps === null ? '--' : String(fps);
      const rttText = rttMs === null ? '--' : String(rttMs);
      perfEl.textContent = `${fpsText} FPS · ${rttText} MS`;
    },

    dispose() {
      window.clearInterval(tickTimer);
      window.clearTimeout(hitMarkerTimer);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('fullscreenchange', updateFullscreenBtn);
      document.removeEventListener('webkitfullscreenchange', updateFullscreenBtn);
    },
  };
}
