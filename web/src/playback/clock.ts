// The single source of simulated time. Everything that animates reads `clock.time`
// (seconds since midnight, [0, 86400)) and re-renders from `subscribe`.

import { DAY_SECONDS, DEFAULT_SPEED } from '../config';

export type ClockEvent = 'tick' | 'seek' | 'play' | 'pause' | 'speed';

export interface ClockState {
  /** Sim seconds since midnight, [0, 86400). */
  time: number;
  playing: boolean;
  /** Sim seconds per real second. */
  speed: number;
}

export type ClockListener = (state: Readonly<ClockState>, event: ClockEvent) => void;

/** Longest real-time step applied per frame (avoids jumps after a background tab). */
const MAX_FRAME_MS = 100;

export class Clock {
  private state: ClockState;
  private listeners = new Set<ClockListener>();
  private raf = 0;
  private last = 0;

  constructor(time = 0, speed = DEFAULT_SPEED) {
    this.state = { time: wrap(time), playing: false, speed };
  }

  get time(): number {
    return this.state.time;
  }
  get playing(): boolean {
    return this.state.playing;
  }
  get speed(): number {
    return this.state.speed;
  }
  /** Current 15-minute tide bin (0..95). */
  get bin15(): number {
    return Math.floor(this.state.time / 900);
  }
  /** Current 5-minute histogram bin (0..287). */
  get bin5(): number {
    return Math.floor(this.state.time / 300);
  }
  get hour(): number {
    return Math.floor(this.state.time / 3600);
  }
  getState(): Readonly<ClockState> {
    return this.state;
  }

  play(): void {
    if (this.state.playing) return;
    this.state = { ...this.state, playing: true };
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.emit('play');
  }

  pause(): void {
    if (!this.state.playing) return;
    cancelAnimationFrame(this.raf);
    this.state = { ...this.state, playing: false };
    this.emit('pause');
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number): void {
    if (speed === this.state.speed) return;
    this.state = { ...this.state, speed };
    this.emit('speed');
  }

  /** Jump to `time` (seconds since midnight; wrapped into the day). Works while playing or paused. */
  seek(time: number): void {
    this.state = { ...this.state, time: wrap(time) };
    this.emit('seek');
  }

  /**
   * Listen to every tick (each animation frame while playing) plus seek/play/
   * pause/speed events. Returns an unsubscribe function.
   */
  subscribe(fn: ClockListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private frame = (now: number): void => {
    const dt = Math.min(now - this.last, MAX_FRAME_MS) / 1000;
    this.last = now;
    this.state = { ...this.state, time: wrap(this.state.time + dt * this.state.speed) };
    this.emit('tick');
    if (this.state.playing) this.raf = requestAnimationFrame(this.frame);
  };

  private emit(event: ClockEvent): void {
    for (const fn of this.listeners) fn(this.state, event);
  }
}

function wrap(t: number): number {
  return ((t % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
}

/** "07:30" for a time in seconds since midnight. */
export function formatClock(t: number): string {
  const m = Math.floor(t / 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Parse "7:30" / "07:30" / "18" into seconds since midnight, or null. */
export function parseClock(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return h * 3600 + min * 60;
}
