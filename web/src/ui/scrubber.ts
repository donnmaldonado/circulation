// Day scrubber: a filled sparkline of the day, a playhead, hour ticks, a
// caption and a hover readout. It draws the manifest's 288-bin "trips started
// per 5 min" histogram, or while a filter is on, that filter's rides per
// 15 min in the selection colour (setSeries). Drag (mouse,
// pen or touch) seeks live; a click jumps. Playback pauses while the thumb is
// held and resumes on release if it was playing. Keyboard: it is a
// role="slider" — ←/→ ±5 min (Shift: ±1 h), PageUp/PageDown ±1 h, Home/End.
//
// The sparkline is drawn once per resize or series into two stacked canvases (dim = the
// rest of the day, bright = already played); the playhead only moves a
// transform and a clip-path, so ticking costs no canvas repaint.

import { DAY_SECONDS, SELECTION_COLOR } from '../config';
import { formatClock, type Clock } from '../playback/clock';

/** Labelled every 3 hours; a minor tick on every other hour. */
const TICKS = ['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p'];

const WHITE = '255,255,255';
const SEL = SELECTION_COLOR.join(',');

/** What the sparkline draws: counts per equal bin across the day. */
interface Series {
  values: ArrayLike<number>;
  caption: string;
  /** "r,g,b" of the fill and ridge line. */
  rgb: string;
}

export interface ScrubberHandle {
  root: HTMLElement;
  /** Redraw the sparkline (e.g. after a resize). */
  redraw(): void;
  /** Draw these counts (equal bins across the day) instead of every trip; null goes back to every trip. */
  setSeries(values: ArrayLike<number> | null, caption?: string): void;
}

export function mountScrubber(slot: HTMLElement, clock: Clock, histogram: number[]): ScrubberHandle {
  const root = document.createElement('div');
  root.className = 'scrubber';
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', 'Time of day');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', String(DAY_SECONDS - 60));
  root.innerHTML = `
    <div class="scrub-track">
      <canvas class="scrub-dim" aria-hidden="true"></canvas>
      <canvas class="scrub-lit" aria-hidden="true"></canvas>
      <div class="scrub-cap" aria-hidden="true"></div>
      <div class="scrub-head" aria-hidden="true"></div>
      <div class="scrub-hover" aria-hidden="true"><span></span></div>
    </div>
    <div class="scrub-ticks" aria-hidden="true">
      ${Array.from({ length: 24 }, (_, h) => {
        const left = `left:${((h / 24) * 100).toFixed(4)}%`;
        return h % 3 ? `<i style="${left}"></i>` : `<span style="${left}">${TICKS[h / 3]}</span>`;
      }).join('')}
    </div>`;
  slot.appendChild(root);

  const track = root.querySelector<HTMLElement>('.scrub-track')!;
  const dim = root.querySelector<HTMLCanvasElement>('.scrub-dim')!;
  const lit = root.querySelector<HTMLCanvasElement>('.scrub-lit')!;
  const head = root.querySelector<HTMLElement>('.scrub-head')!;
  const hover = root.querySelector<HTMLElement>('.scrub-hover')!;
  const hoverText = hover.querySelector('span')!;
  const cap = root.querySelector<HTMLElement>('.scrub-cap')!;
  const everyTrip: Series = { values: histogram, caption: 'All trips', rgb: WHITE };
  let series = everyTrip;
  let bins = 0;
  let peak = 1;
  let binMinutes = 5;
  const setCaption = () => {
    cap.innerHTML = `${series.caption}<em> · per ${binMinutes} min</em>`;
    cap.style.setProperty('--c', `rgb(${series.rgb})`);
  };

  let width = 0;
  const draw = () => {
    const values = series.values;
    bins = values.length || 288;
    binMinutes = Math.round(DAY_SECONDS / 60 / bins);
    peak = Math.max(1, ...Array.from(values));
    setCaption();
    const rect = track.getBoundingClientRect();
    width = rect.width;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const c = series.rgb;
    // Yellow at low alpha reads as olive on the dark panel; give it a little more.
    const dimFill = c === WHITE ? 0.16 : 0.24;
    for (const [canvas, fill, top] of [
      [dim, `rgba(${c},${dimFill})`, `rgba(${c},0.36)`],
      [lit, `rgba(${c},0.55)`, `rgba(${c},0.95)`],
    ] as const) {
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const h = rect.height;
      const x = (i: number) => (i / bins) * rect.width;
      const y = (i: number) => h - 1 - ((values[i] ?? 0) / peak) * (h - 4);
      // Filled area through bin centres, then a 1px ridge line on top.
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, y(0));
      for (let i = 0; i < bins; i++) ctx.lineTo(x(i + 0.5), y(i));
      ctx.lineTo(rect.width, y(bins - 1));
      ctx.lineTo(rect.width, h);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, y(0));
      for (let i = 0; i < bins; i++) ctx.lineTo(x(i + 0.5), y(i));
      ctx.lineTo(rect.width, y(bins - 1));
      ctx.lineWidth = 1;
      ctx.strokeStyle = top;
      ctx.stroke();
    }
    place();
  };

  let lastMinute = -1;
  const place = () => {
    const frac = clock.time / DAY_SECONDS;
    head.style.transform = `translateX(${(frac * width).toFixed(1)}px)`;
    lit.style.clipPath = `inset(0 ${((1 - frac) * 100).toFixed(3)}% 0 0)`;
    const minute = Math.floor(clock.time / 60);
    if (minute !== lastMinute) {
      lastMinute = minute;
      root.setAttribute('aria-valuenow', String(minute * 60));
      root.setAttribute('aria-valuetext', formatClock(clock.time));
    }
  };

  new ResizeObserver(draw).observe(track);
  clock.subscribe(place);

  // ---------------------------------------------------------------- pointer
  const timeAt = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(DAY_SECONDS - 1, f * DAY_SECONDS);
  };
  const showHover = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    const t = timeAt(clientX);
    const n = series.values[Math.min(bins - 1, Math.floor((t / DAY_SECONDS) * bins))] ?? 0;
    hoverText.textContent = `${formatClock(t)} · ${n.toLocaleString('en-US')} rides / ${binMinutes} min`;
    // Keep the bubble inside the track.
    const x = clientX - rect.left;
    const half = hoverText.offsetWidth / 2;
    hover.style.transform = `translateX(${x.toFixed(1)}px)`;
    hoverText.style.transform = `translateX(${(Math.min(Math.max(x, half), rect.width - half) - x - half).toFixed(1)}px)`;
    root.classList.add('hovering');
  };

  let dragging: number | null = null;
  let wasPlaying = false;
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    root.focus({ preventScroll: true });
    root.setPointerCapture(e.pointerId);
    dragging = e.pointerId;
    wasPlaying = clock.playing;
    clock.pause();
    root.classList.add('dragging');
    clock.seek(timeAt(e.clientX));
    showHover(e.clientX);
  });
  root.addEventListener('pointermove', (e) => {
    if (dragging === e.pointerId) clock.seek(timeAt(e.clientX));
    if (dragging === e.pointerId || e.pointerType === 'mouse') showHover(e.clientX);
  });
  const release = (e: PointerEvent) => {
    if (dragging !== e.pointerId) return;
    dragging = null;
    root.classList.remove('dragging');
    if (e.pointerType !== 'mouse') root.classList.remove('hovering');
    if (wasPlaying) clock.play();
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  root.addEventListener('pointerleave', (e) => {
    if (dragging === null && e.pointerType === 'mouse') root.classList.remove('hovering');
  });

  // ---------------------------------------------------------------- keyboard
  root.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 3600 : 300;
    let t: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = clock.time + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = clock.time - step;
    else if (e.key === 'PageUp') t = clock.time + 3600;
    else if (e.key === 'PageDown') t = clock.time - 3600;
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = DAY_SECONDS - 300;
    if (t === null) return;
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the global ±15 min shortcut
    // Snap to the 5-min grid so repeated presses land on round times.
    clock.seek(Math.round(t / 300) * 300);
  });

  return {
    root,
    redraw: draw,
    setSeries(values, caption = '') {
      series = values ? { values, caption, rgb: SEL } : everyTrip;
      draw();
    },
  };
}
