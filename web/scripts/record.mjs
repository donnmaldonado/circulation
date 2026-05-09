// 15 s screen capture for the README: page load (poster -> live), the intro over
// the already-playing morning rush, the rush itself, then a Midtown station click.
// Playwright's recordVideo writes .webm natively (no ffmpeg needed).
//
//   npm run build && node scripts/record.mjs            # -> ../docs/circulation-15s.webm
//   node scripts/record.mjs --width=960 --height=600     # smaller file

import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { WEB, arg, launch, startServer } from './lib.mjs';

const W = Number(arg('width', 1280));
const H = Number(arg('height', 800));
const SECONDS = Number(arg('seconds', 15));
const OUT = resolve(arg('out', resolve(WEB, '..', 'docs', 'circulation-15s.webm')));
const TMP = resolve(WEB, 'node_modules', '.record-tmp');

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const server = await startServer(arg('dev') ? 'dev' : 'preview');
const browser = await launch({ headed: !!arg('headed') });
try {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: TMP, size: { width: W, height: H } },
  });
  const page = await context.newPage();
  const t0 = Date.now();
  const at = async (s) => {
    const wait = s * 1000 - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
  };
  await page.goto(server.url);
  await page.waitForFunction(() => window.circ?.clock?.playing === true, null, { timeout: 20_000 });

  await at(4.2); // intro over the playing map
  await page.mouse.move(W * 0.62, H * 0.45);
  await page.mouse.wheel(0, 120); // "scroll to explore"

  await at(10.5); // the 08:00-09:00 rush, then click a Midtown station
  const pt = await page.evaluate(() => {
    const { tide, map } = window.circ;
    const i = tide.index.stations.findIndex((s) => s.name === '8 Ave & W 31 St');
    const st = tide.index.stations[i >= 0 ? i : 0];
    const p = map.project([st.lng, st.lat]);
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(pt.x, pt.y, { steps: 12 });
  await page.mouse.click(pt.x, pt.y);

  await at(SECONDS);
  const video = page.video();
  await context.close();
  const src = await video.path();
  mkdirSync(resolve(OUT, '..'), { recursive: true });
  renameSync(src, OUT);
  console.log(`wrote ${OUT} (${(statSync(OUT).size / 1e6).toFixed(2)} MB, ${W}x${H}, ${SECONDS}s)`);
} finally {
  await browser.close();
  await server.close();
  rmSync(TMP, { recursive: true, force: true });
}
