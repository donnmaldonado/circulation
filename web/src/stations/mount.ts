// Wires the tide layer, the station↔trip index and station selection into the
// app: scene providers, deck pointer handlers, and the legend entry.

import type { MapboxOverlay } from '@deck.gl/mapbox';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { ChunkStore } from '../data/loader';
import type { Station } from '../data/types';
import type { Scene } from '../map/scene';
import type { Clock } from '../playback/clock';
import { placeCenter } from './places';
import { DIMMED_TIDE, StationSelection } from './selection';
import { StationIndex } from './station-index';
import { TideModel } from './tide-layer';
import { NEUTRAL_CSS, SINK_CSS, SOURCE_CSS } from './tide-scale';

/** Layer order (trips are 0). `?tide=under` draws the dots beneath the trails instead. */
const ORDER = { selectionTrails: 5, tideOver: 10, tideUnder: -10, selectionMarks: 20 };

export interface TideHandle {
  index: StationIndex;
  model: TideModel;
  /** null when not interactive (poster mode). */
  selection: StationSelection | null;
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
  interactive: boolean;
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

  let selection: StationSelection | null = null;
  scene.addProvider(
    'tide',
    (t) => model.layers(t, selection?.active ? DIMMED_TIDE : 1),
    o.under ? ORDER.tideUnder : ORDER.tideOver,
  );

  if (o.interactive) {
    selection = new StationSelection(index, store, clock, () => scene.requestRender(), o.root);
    const sel = selection;
    scene.addProvider('selection-trails', (t) => sel.trailLayers(t), ORDER.selectionTrails);
    scene.addProvider('selection-marks', () => sel.markLayers(), ORDER.selectionMarks);
    const canvas = o.map.getCanvas();
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    o.overlay.setProps({
      pickingRadius: coarse ? 14 : 6,
      onClick: sel.handleClick,
      onHover: (info) => sel.handleHover(info, canvas),
    });
    // A place off screen (Prospect Park, Columbia from the opening view): bring it into view.
    sel.onChange((active) => {
      const place = active ? sel.place : null;
      if (!place) return;
      const [lng, lat] = placeCenter(place);
      if (!o.map.getBounds().contains([lng, lat])) o.map.easeTo({ center: [lng, lat], duration: 900 });
    });
  }

  if (o.legend) {
    const key = document.createElement('span');
    key.className = 'tide-key';
    key.title = 'Station dots: net bikes arriving (warm) vs leaving (cool) this 15 minutes';
    key.innerHTML = '<em>filling</em><i></i><em>emptying</em>';
    o.legend.appendChild(key);
  }

  return { index, model, selection };
}
