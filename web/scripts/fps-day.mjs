// Frame rate across a whole simulated day at the default speed (720x: 24 h in
// 2 min), bucketed by sim hour. Real data, production build by default.
//
//   npm run build && node scripts/fps-day.mjs                 # 1440x900 @2x
//   node scripts/fps-day.mjs --mobile                         # 390x844 @3x, touch (half density)
//   node scripts/fps-day.mjs --headed

import { arg, glRenderer, launch, startServer } from './lib.mjs';

const MOBILE = !!arg('mobile');
const W = Number(arg('width', MOBILE ? 390 : 1440));
const H = Number(arg('height', MOBILE ? 844 : 900));
const DPR = Number(arg('dpr', MOBILE ? 3 : 2));

const server = await startServer(arg('dev') ? 'dev' : 'preview');
const browser = await launch({ headed: !!arg('headed') });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, isMobile: MOBILE, hasTouch: MOBILE });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${server.url}?nointro&t=00:00&paused${arg('query') ? `&${arg('query')}` : ''}`);
  await page.waitForFunction(() => window.circ?.tide && window.circ.store.stats.loaded === 24, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const res = await page.evaluate(async () => {
    const { clock } = window.circ;
    clock.seek(0);
    const perHour = Array.from({ length: 24 }, () => []);
    const deck = window.circ.overlay._deck;
    const cpu = Array.from({ length: 24 }, () => []);
    const gpu = Array.from({ length: 24 }, () => []);
    let last = 0;
    await new Promise((done) => {
      let prevT = -1;
      const loop = (now) => {
        const t = clock.time;
        if (last && prevT >= 0) {
          const hh = Math.floor(prevT / 3600);
          perHour[hh].push(now - last);
          const m = deck?.metrics;
          if (m) {
            cpu[hh].push(m.cpuTimePerFrame);
            if (m.gpuTimePerFrame) gpu[hh].push(m.gpuTimePerFrame);
          }
        }
        if (prevT > 86000 && t < 1000) return done(); // wrapped: one full day
        last = now;
        prevT = t;
        requestAnimationFrame(loop);
      };
      clock.play();
      requestAnimationFrame(loop);
    });
    clock.pause();
    return perHour.map((dts, h) => {
      if (!dts.length) return { h, fps: 0, p95: 0, worst: 0, n: 0 };
      const s = [...dts].sort((a, b) => a - b);
      const total = dts.reduce((a, b) => a + b, 0);
      return {
        h,
        fps: +((dts.length * 1000) / total).toFixed(1),
        p95: +s[Math.floor(s.length * 0.95)].toFixed(1),
        worst: +s[s.length - 1].toFixed(1),
        n: dts.length,
        cpu: cpu[h].length ? +(cpu[h].reduce((a, b) => a + b, 0) / cpu[h].length).toFixed(2) : null,
        gpu: gpu[h].length ? +(gpu[h].reduce((a, b) => a + b, 0) / gpu[h].length).toFixed(2) : null,
      };
    });
  });
  const all = res.reduce((a, r) => a + r.n, 0);
  const secs = res.reduce((a, r) => a + (r.n ? r.n / r.fps : 0), 0);
  console.log(`renderer: ${await glRenderer(page)} · ${W}x${H}@${DPR}${MOBILE ? ' mobile' : ''}`);
  console.log('hour  fps   p95ms  worstms  deck-cpu-ms  deck-gpu-ms');
  for (const r of res)
    console.log(
      `${String(r.h).padStart(2, '0')}   ${r.fps.toFixed(1).padStart(5)}  ${String(r.p95).padStart(5)}  ${String(r.worst).padStart(6)}  ${String(r.cpu ?? '-').padStart(10)}  ${String(r.gpu ?? '-').padStart(10)}`,
    );
  const min = res.reduce((m, r) => (r.fps < m.fps ? r : m));
  console.log(`day: avg ${(all / secs).toFixed(1)} fps over ${secs.toFixed(0)} s · min hour ${String(min.h).padStart(2, '0')}:00 ${min.fps} fps${errors.length ? ` · ERRORS: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  await server.close();
}
