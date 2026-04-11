// Station ↔ trip index, built incrementally as hour chunks land.
//
// Trips carry no station ids, but the contract guarantees each path starts and
// ends exactly on a station's (snapped) coordinate, modulo the chunk's uint16
// quantization. The decoder turns a quantized cell q into
// Float32(minLng + q·sx) — and Float32 near lng −74 is *coarser* than the grid
// (ulp ≈ 0.6 m), so re-quantizing a decoded position is lossy. Instead we
// predict, for every station, the exact Float32 pair the decoder produces for
// its cell and the 8 neighbouring cells (encoder rounding may differ by one),
// and look endpoints up by those bit patterns: an exact hash hit. The rare miss
// falls back to a nearest-station search on a coarse grid.
//
// Per chunk we keep two Uint16Arrays (origin / destination station per trip, in
// the chunk's decoded order), so "trips leaving station s" is a linear scan over
// ≤ 200k shorts — well under a millisecond — and needs no inverted lists. Per
// station we also accumulate departures + arrivals per 15-min bin: that is the
// activity measure the tide layer sizes its dots by.

import type { Manifest, Station, TripChunk } from '../data/types';

export const NO_STATION = 0xffff;
export const TIDE_BINS = 96;
const BIN_S = 900;

/** Fallback search radius when the exact grid lookup misses (metres). */
const FALLBACK_M = 40;

export interface ChunkStations {
  hour: number;
  /** Origin / destination station index per trip (chunk order); NO_STATION if unmatched. */
  from: Uint16Array;
  to: Uint16Array;
}

export interface IndexStats {
  trips: number;
  exact: number;
  fallback: number;
  missed: number;
  ms: number;
}

export class StationIndex {
  readonly n: number;
  /** lng,lat per station (Float32), for layers. */
  readonly positions: Float32Array;
  /** Per station × 15-min bin: trips departing / arriving (from decoded trips). */
  readonly departures: Float32Array;
  readonly arrivals: Float32Array;
  readonly chunks: (ChunkStations | undefined)[] = new Array(24).fill(undefined);
  readonly stats: IndexStats = { trips: 0, exact: 0, fallback: 0, missed: 0, ms: 0 };
  /** Bumped on every ingest; cheap change detection. */
  version = 0;

  /** Float32 bits of decoded lng → (Float32 bits of lat → station). */
  private readonly cells = new Map<number, Map<number, number>>();
  private readonly coarse = new Map<number, number[]>();
  private readonly f32 = new Float32Array(2);
  private readonly u32 = new Uint32Array(this.f32.buffer);
  private readonly mPerDegLng: number;
  private readonly listeners = new Set<(hour: number) => void>();

  constructor(
    readonly stations: Station[],
    manifest: Manifest,
  ) {
    this.n = stations.length;
    if (this.n >= NO_STATION) throw new Error(`too many stations: ${this.n}`);
    const [minLng, minLat, maxLng, maxLat] = manifest.bbox;
    this.mPerDegLng = 111_320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);

    this.positions = new Float32Array(this.n * 2);
    this.departures = new Float32Array(this.n * TIDE_BINS);
    this.arrivals = new Float32Array(this.n * TIDE_BINS);
    const sx = (maxLng - minLng) / 65535;
    const sy = (maxLat - minLat) / 65535;
    const qx = 1 / sx;
    const qy = 1 / sy;
    // Own cell first for every station, then neighbours where still free.
    for (const ring of [false, true]) {
      stations.forEach((s, i) => {
        const x = Math.round((s.lng - minLng) * qx);
        const y = Math.round((s.lat - minLat) * qy);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if ((dx !== 0 || dy !== 0) !== ring) continue;
            // Same arithmetic as decode.ts, stored through a Float32Array.
            this.f32[0] = minLng + (x + dx) * sx;
            this.f32[1] = minLat + (y + dy) * sy;
            let inner = this.cells.get(this.u32[0]);
            if (!inner) this.cells.set(this.u32[0], (inner = new Map()));
            if (!inner.has(this.u32[1])) inner.set(this.u32[1], i);
          }
        }
      });
    }
    stations.forEach((s, i) => {
      this.positions[2 * i] = s.lng;
      this.positions[2 * i + 1] = s.lat;
      const ck = this.coarseKey(s.lng, s.lat);
      const list = this.coarse.get(ck);
      if (list) list.push(i);
      else this.coarse.set(ck, [i]);
    });
  }

  /** Called after each chunk is ingested. Returns an unsubscribe function. */
  onChange(fn: (hour: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve every trip's origin/destination station and accumulate activity. Idempotent per hour. */
  ingest(chunk: TripChunk): void {
    if (this.chunks[chunk.hour]) return;
    const t0 = performance.now();
    const { tripCount, startIndices, positions, tripStart, tripEnd } = chunk;
    const from = new Uint16Array(tripCount);
    const to = new Uint16Array(tripCount);
    for (let j = 0; j < tripCount; j++) {
      const v0 = startIndices[j];
      const v1 = startIndices[j + 1] - 1;
      const a = this.match(positions[2 * v0], positions[2 * v0 + 1]);
      const b = this.match(positions[2 * v1], positions[2 * v1 + 1]);
      from[j] = a;
      to[j] = b;
      if (a !== NO_STATION) this.departures[a * TIDE_BINS + binOf(tripStart[j])]++;
      if (b !== NO_STATION) this.arrivals[b * TIDE_BINS + binOf(tripEnd[j])]++;
    }
    this.chunks[chunk.hour] = { hour: chunk.hour, from, to };
    this.stats.trips += tripCount;
    this.stats.ms += performance.now() - t0;
    this.version++;
    this.listeners.forEach((fn) => fn(chunk.hour));
  }

  get hoursIndexed(): number {
    return this.chunks.reduce((k, c) => k + (c ? 1 : 0), 0);
  }

  /** Nearest station index for a trip endpoint, or NO_STATION. */
  /** Station index for a decoded trip endpoint (Float32 values), or NO_STATION. */
  match(lng: number, lat: number): number {
    this.f32[0] = lng;
    this.f32[1] = lat;
    const hit = this.cells.get(this.u32[0])?.get(this.u32[1]);
    if (hit !== undefined) {
      this.stats.exact++;
      return hit;
    }
    const best = this.nearest(lng, lat, FALLBACK_M);
    if (best === NO_STATION) this.stats.missed++;
    else this.stats.fallback++;
    return best;
  }

  /** Nearest station within `maxM` metres (coarse ~100 m grid), or NO_STATION. */
  nearest(lng: number, lat: number, maxM: number): number {
    const cx = Math.floor((lng * this.mPerDegLng) / 100);
    const cy = Math.floor((lat * 111_320) / 100);
    const r = Math.ceil(maxM / 100);
    let best = NO_STATION;
    let bestD = maxM * maxM;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const list = this.coarse.get((cx + dx) * 1_000_000 + (cy + dy));
        if (!list) continue;
        for (const i of list) {
          const ex = (this.positions[2 * i] - lng) * this.mPerDegLng;
          const ey = (this.positions[2 * i + 1] - lat) * 111_320;
          const d = ex * ex + ey * ey;
          if (d <= bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  }

  private coarseKey(lng: number, lat: number): number {
    return Math.floor((lng * this.mPerDegLng) / 100) * 1_000_000 + Math.floor((lat * 111_320) / 100);
  }
}

function binOf(t: number): number {
  return Math.floor(t / BIN_S) % TIDE_BINS;
}
