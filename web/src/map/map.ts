// MapLibre basemap + deck.gl overlay.
//
// deck.gl runs in *overlaid* mode (its own canvas stacked on top of MapLibre's,
// camera-synced by MapboxOverlay) rather than interleaved. During playback the
// camera is still, so MapLibre renders nothing per frame and deck redraws only
// the trails. Interleaved mode would force a full basemap repaint on every
// animation frame. We don't need trails under labels, so that cost buys nothing.

import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 derives its worker URL from import.meta.url at runtime, which the
// bundler can't see. Hand it an explicitly bundled worker instead.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { BASEMAP_STYLE, POSTER_SIZE, VIEW } from '../config';

export interface MapHandle {
  map: MapLibreMap;
  overlay: MapboxOverlay;
  /** Resolves when the basemap has drawn its first complete frame (tiles loaded). */
  basemapReady: Promise<void>;
}

/**
 * Zoom that makes the map cover the viewport exactly like the poster image does
 * with `background-size: cover`, so the cross-fade lines up pixel for pixel.
 */
export function coverZoom(width: number, height: number): number {
  const scale = Math.max(width / POSTER_SIZE.width, height / POSTER_SIZE.height);
  return VIEW.zoom + Math.log2(scale);
}

setWorkerUrl(maplibreWorkerUrl);

export function createMap(container: HTMLElement): MapHandle {
  const { clientWidth: w, clientHeight: h } = container;
  const map = new MapLibreMap({
    container,
    style: BASEMAP_STYLE,
    center: [VIEW.longitude, VIEW.latitude],
    zoom: coverZoom(w, h),
    pitch: VIEW.pitch,
    bearing: VIEW.bearing,
    attributionControl: { compact: true },
    maplibreLogo: false,
    fadeDuration: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    minZoom: 9,
    maxZoom: 17,
  });
  map.touchZoomRotate.disableRotation();

  map.on('style.load', () => {
    performance.mark('circ:style');
    dimBasemap(map);
  });
  map.once('load', () => performance.mark('circ:map-load'));

  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay);

  const basemapReady = new Promise<void>((resolve) => {
    map.once('idle', () => resolve());
  });

  return { map, overlay, basemapReady };
}

/**
 * Push CARTO Dark Matter darker and quieter so the trails carry the image:
 * near-black land, blacker water (the island silhouettes still read), streets
 * as a faint etched grid, place labels subdued, street names off.
 */
const LAND = '#08090c';
const WATER = '#020304';

function dimBasemap(map: MapLibreMap): void {
  const style = map.getStyle();
  const set = (id: string, prop: string, value: unknown) => {
    try {
      map.setPaintProperty(id, prop as never, value as never);
    } catch {
      /* property not applicable to this layer */
    }
  };
  for (const layer of style.layers ?? []) {
    const id = layer.id;
    if (layer.type === 'background') set(id, 'background-color', LAND);
    else if (layer.type === 'fill') {
      if (id === 'water') set(id, 'fill-color', WATER);
      else if (/^(landcover|landuse|park)/.test(id)) set(id, 'fill-color', LAND);
      else if (id.startsWith('building')) set(id, 'fill-opacity', 0.25);
    } else if (layer.type === 'line') {
      if (/^(road|bridge|tunnel)_/.test(id)) set(id, 'line-opacity', /_case/.test(id) ? 0.28 : 0.34);
      else if (id === 'waterway') set(id, 'line-color', WATER);
      else set(id, 'line-opacity', 0.3);
    } else if (layer.type === 'symbol') {
      if (/^(roadname|housenumber|poi)/.test(id)) map.setLayoutProperty(id, 'visibility', 'none');
      else {
        set(id, 'text-opacity', 0.5);
        set(id, 'icon-opacity', 0.35);
      }
    }
  }
}
