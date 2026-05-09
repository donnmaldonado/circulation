// End-to-end check: first frame is the poster, no console errors, trails
// animate, and fps over ~5 s.
//
//   npm run verify                     # dev server, new-headless Chromium w/ GPU flags
//   npm run verify -- --headed         # real window (most honest fps)
//   npm run verify -- --preview        # against the production build (run `npm run build` first)
//   npm run verify -- --query="data=fixture&t=18:00"

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { arg, glRenderer, launch, startServer } from './lib.mjs';

const OUT = resolve(arg('out', resolve(process.env.TMPDIR ?? '/tmp', 'circulation-verify')));
mkdirSync(OUT, { recursive: true });
const W = Number(arg('width', 1440));
const H = Number(arg('height', 900));
const DPR = Number(arg('dpr', 2));
const SECONDS = Number(arg('seconds', 5));

const server = await startServer(arg('preview') ? 'preview' : 'dev');
const browser = await launch({ headed: !!arg('headed') });
const report = { url: '', errors: [], warnings: [] };
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(m.text());
    if (m.type() === 'warning') report.warnings.push(m.text());
    if (m.type() === 'info' || m.type() === 'log') console.log('[page]', m.text());
  });
  page.on('pageerror', (e) => report.errors.push(String(e)));

  const query = arg('query', '');
  report.url = `${server.url}?debug${query ? `&${query}` : ''}`;
  const t0 = Date.now();
  await page.goto(report.url, { waitUntil: 'commit' });
  await page.waitForTimeout(50);
  await page.screenshot({ path: `${OUT}/01-first-50ms.png` });
  report.firstShotAtMs = Date.now() - t0;
  report.posterVisibleAt50ms = await page.evaluate(() => {
    const el = document.querySelector('#poster .full');
    if (!el) return 'no poster element';
    const img = new Image();
    img.src = './poster.webp';
    return img.complete ? 'poster decoded' : 'poster still loading';
  });

  await page.waitForFunction(() => window.circ?.clock?.playing === true, null, { timeout: 20_000 });
  report.playingAfterMs = Date.now() - t0;
  report.timings = await page.evaluate(() =>
    Object.fromEntries(
      performance
        .getEntriesByType('mark')
        .filter((m) => m.name.startsWith('circ:'))
        .map((m) => [m.name.slice(5), Math.round(m.startTime)]),
    ),
  );
  // First paint (the inline poster placeholder + intro text) and when the full poster image arrived.
  report.paint = await page.evaluate(() => {
    const out = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]));
    const poster = performance.getEntriesByType('resource').find((r) => r.name.endsWith('poster.webp'));
    if (poster) out['poster.webp loaded'] = Math.round(poster.responseEnd);
    return out;
  });
  report.renderer = await glRenderer(page);

  await page.waitForTimeout(1000); // let the cross-fade finish
  const a = await page.screenshot({ path: `${OUT}/02-playing-a.png` });
  await page.waitForTimeout(1000);
  const b = await page.screenshot({ path: `${OUT}/03-playing-b.png` });
  report.framesDiffer = !a.equals(b);

  // fps over N seconds, measured in-page with rAF
  report.fps = await page.evaluate(async (secs) => {
    window.circ.fps?.reset();
    const times = [];
    await new Promise((done) => {
      const start = performance.now();
      const loop = (now) => {
        times.push(now);
        if (now - start < secs * 1000) requestAnimationFrame(loop);
        else done();
      };
      requestAnimationFrame(loop);
    });
    const dts = times.slice(1).map((t, i) => t - times[i]).sort((x, y) => x - y);
    const total = times[times.length - 1] - times[0];
    return {
      avg: +((dts.length * 1000) / total).toFixed(1),
      p50FrameMs: +dts[Math.floor(dts.length * 0.5)].toFixed(2),
      p95FrameMs: +dts[Math.floor(dts.length * 0.95)].toFixed(2),
      worstFrameMs: +dts[dts.length - 1].toFixed(2),
      deckFrames: window.circ.scene.frames,
      chunks: window.circ.store.stats,
      simTime: window.circ.clock.time,
    };
  }, SECONDS);
  await page.screenshot({ path: `${OUT}/04-after-fps.png` });
  report.screenshots = OUT;
} finally {
  await browser.close();
  await server.close();
}
console.log(JSON.stringify(report, null, 2));
if (report.errors.length || !report.framesDiffer) process.exitCode = 1;
