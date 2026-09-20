import './style.css';
import { DEFAULT_FILTER, DEFAULT_SPEED, REVEAL_DEADLINE_MS, START_TIME, THIN_MEDIA } from './config';
import { ChunkStore, loadStations, resolveDataSource } from './data/loader';
import { buildTripsLayers, setVertexCulling } from './layers/trips';
import { createMap } from './map/map';
import { Scene } from './map/scene';
import { Clock, parseClock } from './playback/clock';
import { mountTide } from './stations/mount';
import { placeById } from './stations/places';
import type { StationSelection } from './stations/selection';
import { mountControls } from './ui/controls';
import { mountFilter } from './ui/filter';
import { startFpsMeter } from './ui/fps';
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
  // The title line names the day; inlined at build time, refilled here for whichever manifest loaded.
  const brandDate = document.querySelector('[data-brand-date]');
  if (brandDate) brandDate.textContent = formatDay(source.manifest.date);
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

  const app: App = { clock, store, scene, map, overlay, source, hud, scrubber, tide: null, params, panels, thin: THIN };
  (window as unknown as { circ: App }).circ = app;

  // Tide dots, station selection and the opening filter, once stations.json is in (preloaded; the reveal waits for it).
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
      dir: params.get('dir') === 'in' ? 'in' : params.get('dir') === 'out' ? 'out' : DEFAULT_FILTER.dir,
      // Desktop opens with the details beside the map; phones keep the map clear (the bar's Details button opens them).
      details: !THIN,
      under: params.get('tide') === 'under',
    });
    const sel = app.tide.selection;
    applyFilterFromUrl(sel, stations);
    const slot = document.querySelector<HTMLElement>('[data-slot="filter"]');
    if (slot && !POSTER_MODE) mountFilter(slot, sel, stations, panels);
    sel.onChange(() => syncUrl(sel, stations));
    mark('tide');
  });

  if (DEBUG) {
    const fps = startFpsMeter(true, () => `${store.stats.loaded}/24 chunks`);
    app.fps = fps;
  }

  // ---- first frame: wait for the trips that are on screen now, the filter + the basemap.
  const h = clock.hour;
  const needed = POSTER_MODE ? [h, (h + 23) % 24, (h + 22) % 24, (h + 21) % 24] : [h, (h + 23) % 24];
  await Promise.all([store.whenLoaded(needed), tideReady]);
  mark('first-chunk');
  // Wait for the basemap, but never past REVEAL_DEADLINE_MS after navigation: late tiles
  // fill in under the poster's cross-fade; a late start would miss the reviewer's glance.
  await Promise.race([basemapReady, delay(POSTER_MODE ? 15000 : Math.max(0, REVEAL_DEADLINE_MS - performance.now()))]);
  mark('basemap');
  scene.render();
  await nextDeckFrame(scene);
  await nextDeckFrame(scene);

  if (POSTER_MODE) {
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

/**
 * The opening filter: `?station=<id>`, else `?place=<id>` (`all` for no
 * filter), else DEFAULT_FILTER. The direction (`?dir=`) was set on the selection.
 */
function applyFilterFromUrl(sel: StationSelection, stations: { id: string }[]) {
  const stationId = params.get('station');
  const s = stationId ? stations.findIndex((st) => st.id === stationId) : -1;
  if (s >= 0) return sel.select(s);
  const placeId = params.get('place') ?? DEFAULT_FILTER.place;
  if (placeId === 'all') return;
  const place = placeById(placeId) ?? placeById(DEFAULT_FILTER.place);
  if (place) sel.selectPlace(place);
}

/** Keep the address bar on the current filter so it can be shared; the default filter leaves it clean. */
function syncUrl(sel: StationSelection, stations: { id: string }[]) {
  const url = new URL(location.href);
  const q = url.searchParams;
  q.delete('place');
  q.delete('station');
  q.delete('dir');
  const place = sel.place?.id ?? null;
  if (sel.station >= 0) q.set('station', stations[sel.station].id);
  else if (!sel.active) q.set('place', 'all');
  else if (place !== DEFAULT_FILTER.place) q.set('place', place!);
  if (sel.active && sel.dir !== DEFAULT_FILTER.dir) q.set('dir', sel.dir);
  if (url.href !== location.href) history.replaceState(null, '', url);
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
