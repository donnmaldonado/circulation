// The handle other modules (tide, scrubber, panels) build on. Available as
// `await app` from main.ts, and as `window.circ` for debugging.

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapboxOverlay } from '@deck.gl/mapbox';
import type { ChunkStore, DataSource } from './data/loader';
import type { Scene } from './map/scene';
import type { Clock } from './playback/clock';
import type { ControlsHandle } from './ui/controls';
import type { FpsStats } from './ui/fps';

export interface App {
  clock: Clock;
  store: ChunkStore;
  scene: Scene;
  map: MapLibreMap;
  overlay: MapboxOverlay;
  source: DataSource;
  /** null in ?poster mode. */
  hud: ControlsHandle | null;
  params: URLSearchParams;
  fps?: FpsStats;
}
