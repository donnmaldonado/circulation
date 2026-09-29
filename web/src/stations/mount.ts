// Wires the tide layer, the station↔trip index and station selection into the
// app: scene providers, deck pointer handlers, and the legend entry.

import type { MapboxOverlay } from '@deck.gl/mapbox';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { ChunkStore } from '../data/loader';
import type { Station } from '../data/types';
import type { Scene } from '../map/scene';
import type { Clock } from '../playback/clock';
import { placeCenter } from './places';
import { type Dir, DIMMED_TIDE, ROUTE_COLOR, StationSelection } from './selection';
import { StationIndex } from './station-index';
import { TideModel } from './tide-layer';
import { NEUTRAL_CSS, SINK_CSS, SOURCE_CSS } from './tide-scale';
import { SELECTION_COLOR } from '../config';

/** Layer order (trips are 0). `?tide=under` draws the dots beneath the trails instead. */
const ORDER = { selectionTrails: 5, tideOver: 10, tideUnder: -10, selectionMarks: 20 };

export interface TideHandle {
  index: StationIndex;
  model: TideModel;
  selection: StationSelection;
}

export interface TideOptions {
  stations: Station[];
  store: ChunkStore;
  scene: Scene;
  clock: Clock;
  overlay: MapboxOverlay;
  map: MapLibreMap;
  /** Where the station panel and tooltip mount. */
  root: HTMLElement;
  /** Legend container to add the tide key to (optional). */
  legend?: HTMLElement | null;
  /** Pointer handlers (click a dot, hover tooltip); off in poster mode, where the default filter is still drawn. */
  interactive: boolean;
  /** Direction for the first selection, and whether the details panel starts open. */
  dir: Dir;
  details: boolean;
  under?: boolean;
}

export function mountTide(o: TideOptions): TideHandle {
  const { store, scene, clock } = o;
  const manifest = store.src.manifest;
  const index = new StationIndex(o.stations, manifest);
  const model = new TideModel(index, manifest, () => scene.requestRender());

  // Index what is already decoded, then every chunk as it lands.
  for (const c of store.loaded()) index.ingest(c);
  store.onLoad((c) => index.ingest(c));
  index.onChange(() => scene.requestRender());

  const root = document.documentElement.style;
  root.setProperty('--tide-sink', SINK_CSS);
  root.setProperty('--tide-source', SOURCE_CSS);
  root.setProperty('--tide-neutral', NEUTRAL_CSS);
  root.setProperty('--sel', `rgb(${SELECTION_COLOR.join(', ')})`);
  root.setProperty('--route', `rgb(${ROUTE_COLOR.join(', ')})`);

  const sel = new StationSelection(index, store, clock, () => scene.requestRender(), o.root, {
    dir: o.dir,
    details: o.details,
  });
  scene.addProvider('tide', (t) => model.layers(t, sel.active ? DIMMED_TIDE : 1), o.under ? ORDER.tideUnder : ORDER.tideOver);
  scene.addProvider('selection-trails', (t) => sel.trailLayers(t), ORDER.selectionTrails);
  scene.addProvider('selection-marks', () => sel.markLayers(), ORDER.selectionMarks);

  if (o.interactive) {
    const canvas = o.map.getCanvas();
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    o.overlay.setProps({
      pickingRadius: coarse ? 14 : 6,
      onClick: sel.handleClick,
      onHover: (info) => sel.handleHover(info, canvas),
    });
    // A newly picked place or station off screen, or hidden under the filter bar, the details
    // panel or the HUD (Prospect Park from the opening view, a top destination clicked in the
    // list): bring it into view. Only on a new pick, not on every rebuild as hours load, so a
    // pan away sticks.
    let shown: string | null = null;
    sel.onChange(() => {
      const place = sel.place;
      const key = place ? `p:${place.id}` : sel.station >= 0 ? `s:${sel.station}` : null;
      if (key === shown) return;
      shown = key;
      if (!key) return;
      const st = o.stations[sel.station];
      const lngLat: [number, number] = place ? placeCenter(place) : [st.lng, st.lat];
      if (!inClearView(o.map, lngLat)) o.map.easeTo({ center: lngLat, duration: 900 });
    });
  }

  if (o.legend) {
    const key = document.createElement('span');
    key.className = 'lg-group tide-key';
    key.title = 'One dot per station. Bigger = more rides there this hour. Colour = net bikes arriving (filling) or leaving (emptying) this 15 minutes.';
    key.innerHTML =
      '<em class="lg-label">Stations</em><span class="tk-size"><b class="tk-dots" aria-hidden="true"><b></b><b></b></b>busier</span><span><em>filling</em><i></i><em>emptying</em></span>';
    o.legend.appendChild(key);

    // While something is selected: the faint full-day routes, brighter where more of its rides share a street.
    const routes = document.createElement('span');
    routes.className = 'lg-group route-key';
    routes.innerHTML = '<em class="lg-label">Routes</em><span><em>few</em><i></i><em>many rides</em></span>';
    const syncRoutes = (active: boolean) => {
      routes.hidden = !active;
      routes.title = `Every ride ${sel.dir === 'out' ? 'leaving' : 'arriving at'} the selection today, drawn along its route. Brighter streets carry more of those rides.`;
    };
    syncRoutes(sel.active);
    sel.onChange(syncRoutes);
    o.legend.appendChild(routes);
  }

  return { index, model, selection: sel };
}

/** Whether a point is on screen and clear of the filter bar, the details panel and the HUD. */
function inClearView(map: MapLibreMap, lngLat: [number, number]): boolean {
  const { x, y } = map.project(lngLat);
  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const hud = document.querySelector<HTMLElement>('.hud')?.offsetHeight ?? 0;
  const panel = document.querySelector<HTMLElement>('.station-panel:not([hidden])');
  const right = panel && panel.offsetWidth < w * 0.6 ? panel.offsetWidth + 40 : 30;
  return x > 30 && x < w - right && y > 130 && y < h - hud - 30;
}
