// Play/pause, clock readout (with the day), speed selector, legend. Keyboard: space toggles
// play, ←/→ seek ∓/± 15 min, 1/2/3 pick a speed.

import { COLORS, SPEEDS } from '../config';
import { formatClock, type Clock } from '../playback/clock';
import { formatDay } from './day';

const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z"/></svg>';
const PAUSE =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>';

const rgb = (c: readonly number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

export interface ControlsHandle {
  /** The bottom HUD container; E mounts the scrubber into `slot`. */
  root: HTMLElement;
  slot: HTMLElement;
  /** Right-hand end of the controls row, for the panel entry buttons. */
  navSlot: HTMLElement;
}

export function mountControls(parent: HTMLElement, clock: Clock, date: string): ControlsHandle {
  const root = document.createElement('div');
  root.className = 'hud';
  root.innerHTML = `
    <div class="hud-key" aria-hidden="true">
      <span><i style="--c:${rgb(COLORS.ebike)}"></i>e-bike</span>
      <span><i style="--c:${rgb(COLORS.classic)}"></i>classic</span>
      <span class="hk-tide">stations: <b class="dot sink"></b>filling <b class="dot source"></b>emptying</span>
    </div>
    <div class="hud-slot" data-slot="scrubber"></div>
    <div class="hud-row">
      <div class="controls">
        <button class="btn play" type="button" aria-label="Play"></button>
        <div class="clock" aria-live="off"><span class="clock-day">${formatDay(date, 'short')}</span><span class="clock-time">--:--</span></div>
        <div class="speeds" role="radiogroup" aria-label="Playback speed">
          ${SPEEDS.map((s) => `<button type="button" role="radio" data-speed="${s}">${s}×</button>`).join('')}
        </div>
        <button type="button" class="speed-cycle" aria-label="Playback speed (tap to change)"></button>
        <div class="legend" aria-label="Legend">
          <span><i style="--c:${rgb(COLORS.ebike)}"></i>e-bike</span>
          <span><i style="--c:${rgb(COLORS.classic)}"></i>classic</span>
          <span class="legend-note">casual riders dimmer</span>
        </div>
      </div>
      <div class="hud-nav" data-slot="nav"></div>
    </div>`;
  parent.appendChild(root);

  const playBtn = root.querySelector<HTMLButtonElement>('.play')!;
  const timeEl = root.querySelector<HTMLElement>('.clock-time')!;
  const speedBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-speed]')];
  const cycleBtn = root.querySelector<HTMLButtonElement>('.speed-cycle')!;
  cycleBtn.addEventListener('click', () => {
    const i = SPEEDS.indexOf(clock.speed as (typeof SPEEDS)[number]);
    clock.setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
  });

  playBtn.addEventListener('click', () => clock.toggle());
  speedBtns.forEach((b) => b.addEventListener('click', () => clock.setSpeed(Number(b.dataset.speed))));

  let lastMinute = -1;
  const sync = () => {
    const minute = Math.floor(clock.time / 60);
    if (minute !== lastMinute) {
      lastMinute = minute;
      timeEl.textContent = formatClock(clock.time);
    }
    playBtn.innerHTML = clock.playing ? PAUSE : PLAY;
    playBtn.setAttribute('aria-label', clock.playing ? 'Pause' : 'Play');
    cycleBtn.textContent = `${clock.speed}×`;
    for (const b of speedBtns) {
      const on = Number(b.dataset.speed) === clock.speed;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  };
  sync();
  clock.subscribe((_, ev) => {
    if (ev === 'tick') {
      const minute = Math.floor(clock.time / 60);
      if (minute !== lastMinute) {
        lastMinute = minute;
        timeEl.textContent = formatClock(clock.time);
      }
    } else sync();
  });

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (e.code === 'Space') {
      e.preventDefault();
      clock.toggle();
    } else if (e.code === 'ArrowRight') {
      clock.seek(clock.time + 900);
    } else if (e.code === 'ArrowLeft') {
      clock.seek(clock.time - 900);
    } else if (/^Digit[1-3]$/.test(e.code)) {
      clock.setSpeed(SPEEDS[Number(e.code.slice(5)) - 1]);
    }
  });

  return {
    root,
    slot: root.querySelector<HTMLElement>('[data-slot="scrubber"]')!,
    navSlot: root.querySelector<HTMLElement>('[data-slot="nav"]')!,
  };
}
