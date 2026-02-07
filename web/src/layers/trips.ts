// Trips: one TripsLayer per (hour chunk, render group — see decode.ts), fed straight
// from binary attributes. Layer ids are stable and `data` objects are reused,
// so GPU buffers upload once per group; per-frame updates only touch uniforms.

import type { Layer } from '@deck.gl/core';
import { DAY_SECONDS, TRAIL_LENGTH, TRAIL_WIDTH_PX } from '../config';
import type { ChunkStore } from '../data/loader';
import type { TripGroup } from '../data/types';
import { CulledTripsLayer } from './culled-trips-layer';

/** Additive blending: overlapping trails brighten toward white, like light. */
export const ADDITIVE_BLEND = {
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one-minus-src-alpha',
  depthWriteEnabled: false,
  depthCompare: 'always',
} as const;

export interface TripsLayerOptions {
  trailLength?: number;
  widthPx?: number;
  /** Multiply every trail's opacity (e.g. to dim trips while a station is selected). */
  opacity?: number;
}

/**
 * The currentTime a group should be drawn at, or null if nothing in it is on
 * screen at `time`. Trips from late hours that run past midnight are also shown
 * at the start of the (looping) day.
 */
export function groupTime(g: TripGroup, time: number, trail = TRAIL_LENGTH): number | null {
  if (time >= g.tMin && time <= g.tMax + trail) return time;
  const wrapped = time + DAY_SECONDS;
  if (g.tMax > DAY_SECONDS && wrapped >= g.tMin && wrapped <= g.tMax + trail) return wrapped;
  return null;
}

/** Build the visible trip layers for `time`. Cheap: layers are descriptors; deck diffs by id. */
export function buildTripsLayers(store: ChunkStore, time: number, opts: TripsLayerOptions = {}): Layer[] {
  const trail = opts.trailLength ?? TRAIL_LENGTH;
  const layers: Layer[] = [];
  for (const chunk of store.chunks) {
    if (!chunk) continue;
    for (const g of chunk.groups) {
      const t = groupTime(g, time, trail);
      if (t === null) continue;
      layers.push(
        new CulledTripsLayer({
          id: `trips-${g.id}`,
          // Binary data: deck reads attributes straight from the typed arrays.
          data: g.data as never,
          _pathType: 'open',
          currentTime: t,
          trailLength: trail,
          fadeTrail: true,
          widthUnits: 'pixels',
          getWidth: opts.widthPx ?? TRAIL_WIDTH_PX,
          widthMinPixels: 1,
          capRounded: true,
          jointRounded: true,
          opacity: opts.opacity ?? 1,
          pickable: false,
          parameters: ADDITIVE_BLEND,
        }),
      );
    }
  }
  return layers;
}
