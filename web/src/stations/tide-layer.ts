// The tide: one dot per station, coloured by its net bike flow right now.
//
// Colour  = stations.json `tide` (arrivals − departures per 15 min), lightly
//           smoothed over neighbouring bins ([1 2 1]/4, a ~45 min kernel: raw
//           15-min counts are small integers and flicker sink↔source), then
//           interpolated between bin centres by the fractional clock so nothing
//           strobes at 2880×. Normalised symmetrically: clamp at the 99th
//           percentile of |smoothed flow| over all stations × bins, then sqrt, so
//           a few huge hubs don't flatten everyone else to grey.
// Radius  = activity (departures + arrivals) in the hour centred on the clock,
//           counted from the decoded trips themselves (StationIndex), in metres:
//           R0 + R1·sqrt(A / A_ref), with A_ref a "busy station at peak hour"
//           derived from the manifest histogram so it is stable while chunks
//           stream in. Pixel min/max keep dots visible zoomed out and modest
//           zoomed in.

import type { Layer, PickingInfo } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Manifest } from '../data/types';
import { StationIndex, TIDE_BINS } from './station-index';
import { TIDE_LUT, lutIndex } from './tide-scale';

const BIN_S = 900;
/** Recompute dot colours/sizes when sim time moved this much (s) — well below one bin. */
const RECOMPUTE_S = 8;
const R0_M = 12;
const R1_M = 46;
/** Busy-station factor over the citywide mean at the peak hour (see aRef). */
const HUB_FACTOR = 4;
const FADE_IN_MS = 700;

export interface TideSample {
  /** Smoothed, interpolated net flow per 15 min at time t. */
  flow: number;
  /** Normalised to [-1, 1]. */
  v: number;
}

export class TideModel {
  /** Smoothed tide per station × bin. */
  readonly smooth: Float32Array;
  /** |flow| that maps to full colour. */
  readonly clamp: number;
  /** Activity (trips/hour) that maps to R0 + R1. */
  readonly aRef: number;
  visible = true;

  private data: object | null = null;
  private lastT = -1e9;
  private lastVersion = -1;
  private readonly bornAt = performance.now();

  constructor(
    readonly index: StationIndex,
    manifest: Manifest,
    private readonly requestRender: () => void,
  ) {
    const { n, stations } = index;
    this.smooth = new Float32Array(n * TIDE_BINS);
    const mags: number[] = [];
    for (let s = 0; s < n; s++) {
      const raw = stations[s].tide;
      for (let i = 0; i < TIDE_BINS; i++) {
        const prev = raw[(i + TIDE_BINS - 1) % TIDE_BINS] ?? 0;
        const next = raw[(i + 1) % TIDE_BINS] ?? 0;
        const v = 0.25 * prev + 0.5 * (raw[i] ?? 0) + 0.25 * next;
        this.smooth[s * TIDE_BINS + i] = v;
        if (v !== 0) mags.push(Math.abs(v));
      }
    }
    mags.sort((a, b) => a - b);
    this.clamp = Math.max(1.5, mags[Math.floor(mags.length * 0.99)] ?? 1);

    // Peak citywide trips/hour from the 5-min histogram; each trip is one
    // departure and one arrival, spread over n stations.
    const h = manifest.histogram;
    let peak = 0;
    for (let i = 0; i < h.length; i++) {
      let sum = 0;
      for (let k = 0; k < 12; k++) sum += h[(i + k) % h.length] ?? 0;
      peak = Math.max(peak, sum);
    }
    this.aRef = Math.max(4, ((2 * peak) / Math.max(1, n)) * HUB_FACTOR);
  }

  /** Net flow sample for station `s` at time `t`. */
  sample(s: number, t: number): TideSample {
    const { i0, i1, f } = binLerp(t);
    const o = s * TIDE_BINS;
    const flow = this.smooth[o + i0] * (1 - f) + this.smooth[o + i1] * f;
    return { flow, v: normalise(flow, this.clamp) };
  }

  /** Departures + arrivals in the hour centred on `t` (from decoded trips). */
  activity(s: number, t: number): number {
    const { i0, i1, f } = binLerp(t);
    return hourWindow(this.index, s, i0) * (1 - f) + hourWindow(this.index, s, i1) * f;
  }

  /** `emphasis` multiplies opacity (dims the dots while a station is selected). */
  layers(t: number, emphasis = 1): Layer[] {
    if (!this.visible) return [];
    const data = this.compute(t);
    const age = performance.now() - this.bornAt;
    const opacity = Math.min(1, age / FADE_IN_MS);
    if (opacity < 1) this.requestRender();
    return [
      new ScatterplotLayer({
        id: 'tide',
        data: data as never,
        radiusUnits: 'meters',
        radiusMinPixels: 1.8,
        radiusMaxPixels: 7,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 0.8,
        getLineColor: [4, 5, 8, 190],
        opacity: opacity * emphasis,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        parameters: { depthWriteEnabled: false, depthCompare: 'always' },
      }),
    ];
  }

  private compute(t: number): object {
    const idx = this.index;
    if (this.data && Math.abs(t - this.lastT) < RECOMPUTE_S && idx.version === this.lastVersion) return this.data;
    this.lastT = t;
    this.lastVersion = idx.version;
    const n = idx.n;
    const colors = new Uint8Array(n * 4);
    const radii = new Float32Array(n);
    const { i0, i1, f } = binLerp(t);
    for (let s = 0; s < n; s++) {
      const o = s * TIDE_BINS;
      const flow = this.smooth[o + i0] * (1 - f) + this.smooth[o + i1] * f;
      const k = lutIndex(normalise(flow, this.clamp)) * 4;
      colors[4 * s] = TIDE_LUT[k];
      colors[4 * s + 1] = TIDE_LUT[k + 1];
      colors[4 * s + 2] = TIDE_LUT[k + 2];
      colors[4 * s + 3] = TIDE_LUT[k + 3];
      const a = hourWindow(idx, s, i0) * (1 - f) + hourWindow(idx, s, i1) * f;
      radii[s] = R0_M + R1_M * Math.sqrt(a / this.aRef);
    }
    this.data = {
      length: n,
      attributes: {
        getPosition: { value: idx.positions, size: 2 },
        getFillColor: { value: colors, size: 4, normalized: true },
        getRadius: { value: radii, size: 1 },
      },
    };
    return this.data;
  }
}

/** Station index behind a picked tide dot, or -1. */
export function pickedStation(info: PickingInfo): number {
  return info.picked && info.layer?.id === 'tide' ? info.index : -1;
}

function normalise(flow: number, clamp: number): number {
  const u = Math.min(1, Math.abs(flow) / clamp);
  return Math.sign(flow) * Math.sqrt(u);
}

/** Interpolate between 15-min bin centres (bin i is centred on i·900 + 450). */
function binLerp(t: number): { i0: number; i1: number; f: number } {
  const u = t / BIN_S - 0.5;
  const b = Math.floor(u);
  const f = u - b;
  const i0 = ((b % TIDE_BINS) + TIDE_BINS) % TIDE_BINS;
  return { i0, i1: (i0 + 1) % TIDE_BINS, f };
}

/** Departures + arrivals over the hour centred on bin i's centre (edge bins half-weighted). */
function hourWindow(idx: StationIndex, s: number, i: number): number {
  const o = s * TIDE_BINS;
  const at = (k: number) => {
    const j = o + ((i + k + TIDE_BINS) % TIDE_BINS);
    return idx.departures[j] + idx.arrivals[j];
  };
  return 0.5 * at(-2) + at(-1) + at(0) + at(1) + 0.5 * at(2);
}
