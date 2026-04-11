// The handle other modules (tide, scrubber, panels) build on. Available as
// `await app` from main.ts, and as `window.circ` for debugging.

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapboxOverlay } from '@deck.gl/mapbox';
import type { ChunkStore, DataSource } from './data/loader';
import type { Scene } from './map/scene';
import type { Clock } from './playback/clock';
import type { TideHandle } from './stations/mount';
import type { ControlsHandle } from './ui/controls';
import type { FpsStats } from './ui/fps';
import type { ScrubberHandle } from './ui/scrubber';

export interface App {
  clock: Clock;
  store: ChunkStore;
  scene: Scene;
  map: MapLibreMap;
  overlay: MapboxOverlay;
  source: DataSource;
  /** null in ?poster mode. */
  hud: ControlsHandle | null;
  /** Day scrubber in the HUD slot; null in ?poster mode. */
  scrubber: ScrubberHandle | null;
  /** Tide dots, station↔trip index and station selection; null until stations.json loads. */
  tide: TideHandle | null;
  params: URLSearchParams;
  fps?: FpsStats;
}
