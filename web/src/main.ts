import './style.css';
import { DEFAULT_SPEED, START_TIME } from './config';
import { ChunkStore, resolveDataSource } from './data/loader';
import { buildTripsLayers } from './layers/trips';
import { createMap } from './map/map';
import { Scene } from './map/scene';
import { Clock, parseClock } from './playback/clock';
import { mountControls } from './ui/controls';
import { startFpsMeter } from './ui/fps';
import { revealLive } from './ui/poster';
import type { App } from './app';

const params = new URLSearchParams(location.search);
const POSTER_MODE = params.has('poster'); // UI hidden, paused at START_TIME, for scripts/poster.mjs
const DEBUG = params.has('debug');

const mark = (name: string) => performance.mark(`circ:${name}`);

async function boot(): Promise<App> {
  const root = document.getElementById('app')!;
  const mapEl = document.getElementById('map')!;

  // Map and data requests start in parallel.
  const { map, overlay, basemapReady } = createMap(mapEl);
  const source = await resolveDataSource(params);
  mark('manifest');

  const startTime = parseClock(params.get('t')) ?? START_TIME;
  const speed = Number(params.get('speed')) || DEFAULT_SPEED;
  const clock = new Clock(startTime, speed);
  const store = new ChunkStore(source);
  store.prioritize(clock.hour);

  const scene = new Scene(overlay, () => clock.time);
  scene.addProvider('trips', (t) => buildTripsLayers(store, t), 0);

  // Keep the fetch queue in playback order after seeks; redraw when data lands.
  clock.subscribe((state, ev) => {
    if (ev === 'seek') store.prioritize(Math.floor(state.time / 3600));
    if (ev === 'tick' || ev === 'seek') scene.render();
  });
  store.onLoad(() => scene.requestRender());

  if (source.isFixture) document.documentElement.classList.add('is-fixture');
  const hud = POSTER_MODE ? null : mountControls(root, clock);

  const app: App = { clock, store, scene, map, overlay, source, hud, params };
  (window as unknown as { circ: App }).circ = app;

  if (DEBUG) {
    const fps = startFpsMeter(true, () => `${store.stats.loaded}/24 chunks`);
    app.fps = fps;
  }

  // ---- first frame: wait for the trips that are on screen now + the basemap.
  const h = clock.hour;
  const needed = POSTER_MODE ? [h, (h + 23) % 24, (h + 22) % 24, (h + 21) % 24] : [h, (h + 23) % 24];
  await store.whenLoaded(needed);
  mark('first-chunk');
  await Promise.race([basemapReady, delay(POSTER_MODE ? 15000 : 1500)]);
  mark('basemap');
  scene.render();
  await nextDeckFrame(scene);
  await nextDeckFrame(scene);

  if (POSTER_MODE) {
    document.documentElement.classList.add('poster-mode');
    await revealLive();
    document.documentElement.dataset.posterReady = '1';
    return app;
  }

  mark('reveal');
  void revealLive();
  if (!params.has('paused')) clock.play();
  mark('playing');
  logTimings();
  return app;
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function nextDeckFrame(scene: Scene): Promise<void> {
  return new Promise((resolve) => {
    const off = scene.onAfterRender(() => {
      off();
      resolve();
    });
    scene.requestRender();
  });
}

function logTimings() {
  const out = performance
    .getEntriesByType('mark')
    .filter((m) => m.name.startsWith('circ:'))
    .map((m) => `${m.name.slice(5)} ${m.startTime.toFixed(0)}ms`);
  console.info(`[circulation] ${out.join(' · ')}`);
}

export const app = boot().catch((err) => {
  console.error('[circulation] boot failed', err);
  document.documentElement.classList.add('boot-failed');
  throw err;
});
