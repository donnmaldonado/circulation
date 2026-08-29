import './style.css';
import { DEFAULT_SPEED, REVEAL_DEADLINE_MS, START_TIME, THIN_MEDIA } from './config';
import { ChunkStore, loadStations, resolveDataSource } from './data/loader';
import { buildTripsLayers, setVertexCulling } from './layers/trips';
import { createMap } from './map/map';
import { Scene } from './map/scene';
import { Clock, parseClock } from './playback/clock';
import { mountTide } from './stations/mount';
import { placeById } from './stations/places';
import { mountControls } from './ui/controls';
import { startFpsMeter } from './ui/fps';
import { mountIntro } from './ui/intro';
import { mountPanels } from './ui/panels';
import { revealLive } from './ui/poster';
import { formatDay } from './ui/day';
import { mountScrubber } from './ui/scrubber';
import type { App } from './app';

const params = new URLSearchParams(location.search);
const POSTER_MODE = params.has('poster'); // UI hidden, paused at START_TIME, for scripts/poster.mjs
const DEBUG = params.has('debug');
/** Phones draw half the trails (decode.ts) and skip the glow pass. `?density=full|half` overrides. */
const THIN = params.has('density') ? params.get('density') === 'half' : !POSTER_MODE && matchMedia(THIN_MEDIA).matches;
const HALO = !THIN && params.get('halo') !== '0';
if (params.has('nocull')) setVertexCulling(false);

const mark = (name: string) => performance.mark(`circ:${name}`);

async function boot(): Promise<App> {
  const root = document.getElementById('app')!;
  const mapEl = document.getElementById('map')!;

  // Map and data requests start in parallel.
  const { map, overlay, basemapReady } = createMap(mapEl);
  const source = await resolveDataSource(params);
  mark('manifest');
  // The brand line names the day; inlined at build time, refilled here for whichever manifest loaded.
  const brandDate = document.querySelector('[data-brand-date]');
  if (brandDate) brandDate.textContent = formatDay(source.manifest.date);
  // The intro is static markup (first paint); fill it from the manifest and arm dismissal.
  const intro = POSTER_MODE || params.has('nointro') ? null : mountIntro(source.manifest);
  if (!intro) {
    document.getElementById('intro')?.remove();
    document.documentElement.classList.remove('intro-open');
  }
  const stationsReady = loadStations(source).catch((err) => {
    console.error('[circulation] stations.json failed; tide layer off', err);
    return null;
  });

  const startTime = parseClock(params.get('t')) ?? START_TIME;
  const speed = Number(params.get('speed')) || DEFAULT_SPEED;
  const clock = new Clock(startTime, speed);
  const store = new ChunkStore(source, { thin: THIN });
  store.prioritize(clock.hour);

  const scene = new Scene(overlay, () => clock.time);
  // Base trails dim while a station is selected (app.tide.selection).
  scene.addProvider('trips', (t) => buildTripsLayers(store, t, { opacity: app.tide?.selection?.baseOpacity ?? 1, halo: HALO }), 0);

  // Keep the fetch queue in playback order after seeks; redraw when data lands.
  clock.subscribe((state, ev) => {
    if (ev === 'seek') store.prioritize(Math.floor(state.time / 3600));
    if (ev === 'tick' || ev === 'seek') scene.render();
  });
  store.onLoad(() => scene.requestRender());

  if (source.isFixture) document.documentElement.classList.add('is-fixture');
  const hud = POSTER_MODE ? null : mountControls(root, clock, source.manifest.date);
  const scrubber = hud ? mountScrubber(hud.slot, clock, source.manifest.histogram) : null;
  const panels = hud
    ? mountPanels({ root, navSlot: hud.navSlot, manifest: source.manifest, isFixture: source.isFixture })
    : null;
  if (hud) {
    // --hud-h: height of the bottom HUD, so panels and the attribution can sit above it.
    const setHudH = () => document.documentElement.style.setProperty('--hud-h', `${hud.root.offsetHeight}px`);
    new ResizeObserver(setHudH).observe(hud.root);
    setHudH();
  }

  const app: App = { clock, store, scene, map, overlay, source, hud, scrubber, tide: null, params, intro, panels, thin: THIN };
  (window as unknown as { circ: App }).circ = app;

  // Tide dots + station selection, once stations.json is in (fades in; never blocks the reveal).
  const tideReady = stationsReady.then((stations) => {
    if (!stations) return;
    app.tide = mountTide({
      stations,
      store,
      scene,
      clock,
      overlay,
      map,
      root,
      legend: hud?.root.querySelector<HTMLElement>('.legend'),
      interactive: !POSTER_MODE,
      under: params.get('tide') === 'under',
    });
    const sel = app.tide.selection;
    if (sel) {
      panels?.attachSelection(sel);
      // ?place=central-park[&dir=out] opens on a place; the URL follows the selection so it can be shared.
      const place = placeById(params.get('place'));
      if (place) sel.selectPlace(place, params.get('dir') === 'out' ? 'out' : 'in');
      sel.onChange(() => {
        const url = new URL(location.href);
        const p = sel.place;
        if (p) url.searchParams.set('place', p.id);
        else url.searchParams.delete('place');
        if (p && sel.dir === 'out') url.searchParams.set('dir', 'out');
        else url.searchParams.delete('dir');
        history.replaceState(null, '', url);
      });
    }
    mark('tide');
  });

  if (DEBUG) {
    const fps = startFpsMeter(true, () => `${store.stats.loaded}/24 chunks`);
    app.fps = fps;
  }

  // ---- first frame: wait for the trips that are on screen now + the basemap.
  const h = clock.hour;
  const needed = POSTER_MODE ? [h, (h + 23) % 24, (h + 22) % 24, (h + 21) % 24] : [h, (h + 23) % 24];
  await store.whenLoaded(needed);
  mark('first-chunk');
  // Wait for the basemap, but never past REVEAL_DEADLINE_MS after navigation: late tiles
  // fill in under the poster's cross-fade; a late start would miss the reviewer's glance.
  await Promise.race([basemapReady, delay(POSTER_MODE ? 15000 : Math.max(0, REVEAL_DEADLINE_MS - performance.now()))]);
  mark('basemap');
  scene.render();
  await nextDeckFrame(scene);
  await nextDeckFrame(scene);

  if (POSTER_MODE) {
    await tideReady;
    await nextDeckFrame(scene);
    await nextDeckFrame(scene);
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
