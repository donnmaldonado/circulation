// Day scrubber: the manifest's 288-bin "trips started per 5 min" histogram as a
// filled sparkline, a playhead, hour ticks and a hover readout. Drag (mouse,
// pen or touch) seeks live; a click jumps. Playback pauses while the thumb is
// held and resumes on release if it was playing. Keyboard: it is a
// role="slider" — ←/→ ±5 min (Shift: ±1 h), PageUp/PageDown ±1 h, Home/End.
//
// The histogram is drawn once per resize into two stacked canvases (dim = the
// rest of the day, bright = already played); the playhead only moves a
// transform and a clip-path, so ticking costs no canvas repaint.

import { DAY_SECONDS } from '../config';
import { formatClock, type Clock } from '../playback/clock';

const TICKS = [
  [0, '12a'],
  [6, '6a'],
  [12, '12p'],
  [18, '6p'],
] as const;

export interface ScrubberHandle {
  root: HTMLElement;
  /** Redraw the sparkline (e.g. after the histogram changes). */
  redraw(): void;
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
      <div class="scrub-head" aria-hidden="true"></div>
      <div class="scrub-hover" aria-hidden="true"><span></span></div>
    </div>
    <div class="scrub-ticks" aria-hidden="true">
      ${TICKS.map(([h, label]) => `<span style="left:${((h / 24) * 100).toFixed(4)}%">${label}</span>`).join('')}
    </div>`;
  slot.appendChild(root);

  const track = root.querySelector<HTMLElement>('.scrub-track')!;
  const dim = root.querySelector<HTMLCanvasElement>('.scrub-dim')!;
  const lit = root.querySelector<HTMLCanvasElement>('.scrub-lit')!;
  const head = root.querySelector<HTMLElement>('.scrub-head')!;
  const hover = root.querySelector<HTMLElement>('.scrub-hover')!;
  const hoverText = hover.querySelector('span')!;
  const bins = histogram.length || 288;
  const peak = Math.max(1, ...histogram);

  let width = 0;
  const draw = () => {
    const rect = track.getBoundingClientRect();
    width = rect.width;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const [canvas, fill, top] of [
      [dim, 'rgba(255,255,255,0.20)', 'rgba(255,255,255,0.34)'],
      [lit, 'rgba(255,255,255,0.55)', 'rgba(255,255,255,0.95)'],
    ] as const) {
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const h = rect.height;
      const x = (i: number) => (i / bins) * rect.width;
      const y = (i: number) => h - 1 - ((histogram[i] ?? 0) / peak) * (h - 4);
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
    const n = histogram[Math.min(bins - 1, Math.floor((t / DAY_SECONDS) * bins))] ?? 0;
    hoverText.textContent = `${formatClock(t)} · ${n.toLocaleString('en-US')} rides / 5 min`;
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

  return { root, redraw: draw };
}
