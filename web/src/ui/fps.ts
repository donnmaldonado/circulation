// `?debug` frame-rate meter. Counts animation frames (deck renders on the same
// rAF cadence) and logs the running average to the console every 5 s.

export interface FpsStats {
  /** fps over the last ~0.5 s */
  current: number;
  /** average since start() / reset() */
  average: number;
  frames: number;
  worstFrameMs: number;
  reset(): void;
}

export function startFpsMeter(show: boolean, extra?: () => string): FpsStats {
  const el = document.createElement('div');
  el.className = 'fps';
  if (show) document.body.appendChild(el);

  let t0 = performance.now();
  let frames = 0;
  let winStart = t0;
  let winFrames = 0;
  let last = t0;
  let lastLog = t0;
  const stats: FpsStats = {
    current: 0,
    average: 0,
    frames: 0,
    worstFrameMs: 0,
    reset() {
      t0 = performance.now();
      frames = 0;
      stats.worstFrameMs = 0;
      lastLog = t0;
    },
  };

  const loop = (now: number) => {
    frames++;
    winFrames++;
    stats.worstFrameMs = Math.max(stats.worstFrameMs, now - last);
    last = now;
    if (now - winStart >= 500) {
      stats.current = (winFrames * 1000) / (now - winStart);
      winStart = now;
      winFrames = 0;
      if (show) el.textContent = `${stats.current.toFixed(0)} fps${extra ? ` · ${extra()}` : ''}`;
    }
    stats.frames = frames;
    stats.average = (frames * 1000) / Math.max(1, now - t0);
    if (show && now - lastLog >= 5000) {
      lastLog = now;
      console.info(`[fps] avg ${stats.average.toFixed(1)} over ${((now - t0) / 1000).toFixed(0)}s`);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return stats;
}
