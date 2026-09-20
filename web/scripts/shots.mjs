// Screenshots of named states on real data, for review and for docs/.
//
//   npm run shots                                   # desktop set, dev server -> $TMPDIR/circulation-shots
//   npm run shots -- --preview --mobile             # 390x844 @3x set, production build
//   npm run shots -- --only=peak-am,peak-pm --out=/tmp/shots
//
// Each shot opens a fresh page at ?t=HH:MM&paused (so the frame is exact), waits
// for the live map, the tide dots and every chunk, runs its steps, then shoots.
// With no ?place the page opens on its default filter (rides leaving Central
// Park); the city-wide shots pass place=all.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { arg, launch, startServer } from './lib.mjs';

const MOBILE = !!arg('mobile');
const W = Number(arg('width', MOBILE ? 390 : 1440));
const H = Number(arg('height', MOBILE ? 844 : 900));
const DPR = Number(arg('dpr', MOBILE ? 3 : 2));
const OUT = resolve(arg('out', resolve(process.env.TMPDIR ?? '/tmp', 'circulation-shots')));
const ONLY = arg('only') ? String(arg('only')).split(',') : null;
const EXTRA = arg('query', '');
mkdirSync(OUT, { recursive: true });

/** Click the busiest station dot near the map centre (via the page's own index). */
async function clickStation(page, name) {
  const pt = await page.evaluate((name) => {
    const { tide, map } = window.circ;
    const i = tide.index.stations.findIndex((s) => s.name === name);
    const p = map.project([tide.index.stations[i].lng, tide.index.stations[i].lat]);
    return { x: p.x, y: p.y };
  }, name);
  await page.mouse.click(pt.x, pt.y);
}

const SHOTS = [
  { name: 'default', query: 't=07:30&paused' },
  { name: 'arriving-pm', query: 't=17:30&paused&dir=in' },
  { name: 'penn-station', query: 't=08:30&paused&place=penn-station&dir=in' },
  {
    name: 'details',
    query: 't=08:30&paused',
    steps: async (page) => {
      await page.click('.fb-details');
      await page.waitForTimeout(300);
    },
  },
  { name: 'peak-am', query: 't=08:30&paused&place=all' },
  { name: 'peak-pm', query: 't=17:30&paused&place=all' },
  { name: 'night', query: 't=23:10&paused&place=all' },
  {
    name: 'station',
    query: 't=08:40&paused',
    steps: async (page) => {
      await clickStation(page, 'W 21 St & 6 Ave');
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'scrub',
    query: 't=07:30&paused',
    steps: async (page) => {
      const box = await page.locator('.scrub-track').boundingBox();
      const x = (h) => box.x + (h / 24) * box.width;
      await page.mouse.move(x(9), box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(x(15), box.y + box.height / 2, { steps: 8 });
      await page.mouse.move(x(18.1), box.y + box.height / 2, { steps: 8 });
      await page.waitForTimeout(300);
    },
    release: true,
  },
  {
    name: 'about',
    query: 't=08:30&paused',
    steps: async (page) => {
      await page.click('[data-open="about"]');
      await page.waitForTimeout(500);
    },
  },
];

const server = await startServer(arg('preview') ? 'preview' : 'dev');
const browser = await launch({ headed: !!arg('headed') });
const errors = [];
try {
  for (const shot of SHOTS) {
    if (ONLY && !ONLY.includes(shot.name)) continue;
    const page = await browser.newPage({
      viewport: { width: W, height: H },
      deviceScaleFactor: DPR,
      isMobile: MOBILE,
      hasTouch: MOBILE,
    });
    page.on('console', (m) => m.type() === 'error' && errors.push(`${shot.name}: ${m.text()}`));
    page.on('pageerror', (e) => errors.push(`${shot.name}: ${e}`));
    const q = [shot.query, EXTRA].filter(Boolean).join('&');
    await page.goto(`${server.url}?${q}`);
    await page.waitForFunction(
      () => document.documentElement.classList.contains('live') && window.circ?.tide && window.circ.store.stats.loaded === 24,
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(1200); // poster cross-fade + tide fade-in
    if (shot.steps) await shot.steps(page);
    const path = `${OUT}/${MOBILE ? 'm-' : ''}${shot.name}.png`;
    await page.screenshot({ path });
    if (shot.release) await page.mouse.up();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`${path}${overflow ? '  (HORIZONTAL OVERFLOW)' : ''}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
