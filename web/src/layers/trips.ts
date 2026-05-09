// Trips: one TripsLayer per (hour chunk, render group — see decode.ts), fed straight
// from binary attributes. Layer ids are stable and `data` objects are reused,
// so GPU buffers upload once per group; per-frame updates only touch uniforms.

import type { Layer } from '@deck.gl/core';
import { DAY_SECONDS, HALO, PEAK_DIM, TRAIL_LENGTH, TRAIL_WIDTH_PX } from '../config';
import type { ChunkStore } from '../data/loader';
import type { TripGroup } from '../data/types';
import { TripsLayer } from '@deck.gl/geo-layers';
import { CulledTripsLayer } from './culled-trips-layer';

/** `?nocull` swaps in the stock TripsLayer, for before/after perf measurements. */
let TripsClass: typeof CulledTripsLayer = CulledTripsLayer;
export function setVertexCulling(on: boolean): void {
  TripsClass = on ? CulledTripsLayer : (TripsLayer as unknown as typeof CulledTripsLayer);
}

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
  /** Draw the faint wide glow pass under the trails. */
  halo?: boolean;
}

const dimCache = new WeakMap<number[], Float32Array>();

/**
 * Trail opacity for sim time `t` (see PEAK_DIM): a function of how busy the
 * city is right now, from the manifest's 5-min histogram (±10 min window),
 * interpolated between bins so it never steps.
 */
export function peakDim(histogram: number[], t: number): number {
  let table = dimCache.get(histogram);
  if (!table) {
    const n = histogram.length;
    const rate = new Float32Array(n);
    let peak = 1;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += histogram[(i + k + n) % n] ?? 0;
      rate[i] = sum;
      peak = Math.max(peak, sum);
    }
    table = rate.map((r) => {
      const u = r / peak;
      return u <= PEAK_DIM.knee ? 1 : Math.max(PEAK_DIM.floor, (PEAK_DIM.knee / u) ** PEAK_DIM.gamma);
    });
    dimCache.set(histogram, table);
  }
  const n = table.length;
  if (!n) return 1;
  const x = (t / DAY_SECONDS) * n - 0.5;
  const i0 = Math.floor(x);
  const f = x - i0;
  return table[((i0 % n) + n) % n] * (1 - f) + table[(((i0 + 1) % n) + n) % n] * f;
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
  const dim = peakDim(store.src.manifest.histogram, time);
  const opacity = (opts.opacity ?? 1) * dim;
  // The glow stacks up fastest where trails overlap, so it fades out harder than the cores at rush hour.
  const haloOpacity = opacity * dim * HALO.opacity;
  const halos: Layer[] = [];
  const layers: Layer[] = [];
  for (const chunk of store.chunks) {
    if (!chunk) continue;
    for (const g of chunk.groups) {
      const t = groupTime(g, time, trail);
      if (t === null) continue;
      if (opts.halo) {
        halos.push(
          new TripsClass({
            id: `halo-${g.id}`,
            data: g.data as never,
            _pathType: 'open',
            currentTime: t,
            trailLength: trail,
            fadeTrail: true,
            widthUnits: 'pixels',
            getWidth: HALO.widthPx,
            capRounded: true,
            jointRounded: false,
            opacity: haloOpacity,
            pickable: false,
            parameters: ADDITIVE_BLEND,
          }),
        );
      }
      layers.push(
        new TripsClass({
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
          opacity,
          pickable: false,
          parameters: ADDITIVE_BLEND,
        }),
      );
    }
  }
  return halos.length ? [...halos, ...layers] : layers;
}
