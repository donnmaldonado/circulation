/** manifest.json (Contract). */
export interface Manifest {
  date: string;
  bbox: [number, number, number, number];
  chunks: string[];
  /** 288 ints: trips started per 5-minute bin. */
  histogram: number[];
  totals: { trips: number; ebike: number; member: number };
  headline: string;
  /** Other honest tide ratios the encoder considered (c_encode.py), best first. */
  runner_ups?: string[];
  /** UTC time the pipeline wrote this day (absent on the fixture); versions every data URL. */
  generated_at?: string;
  /** Present (true) only on the synthetic fixture. */
  fixture?: boolean;
}

/** stations.json entry (Contract). */
export interface Station {
  id: string;
  name: string;
  lng: number;
  lat: number;
  /** 96 ints: arrivals − departures per 15-minute bin. */
  tide: number[];
}

export const FLAG_EBIKE = 1;
export const FLAG_MEMBER = 2;

/**
 * A group of trips from one hour chunk, contiguous in the chunk's arrays, whose
 * visibility window is [tMin, tMax] (absolute seconds since midnight). Each
 * group becomes one TripsLayer with a stable id; groups let the renderer skip
 * vertices of trips that have long finished.
 */
export interface TripGroup {
  /** Stable id, e.g. "08-3" (hour-groupKey). */
  id: string;
  /** Trip index range [tripFrom, tripTo) within the chunk. When thinned, `data` draws only a prefix of it. */
  tripFrom: number;
  tripTo: number;
  /** Earliest start / latest end of any trip in the group (abs seconds). */
  tMin: number;
  tMax: number;
  /** deck.gl binary data for this group (views into the chunk's arrays). */
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: {
      getPath: { value: Float32Array; size: 2 };
      getTimestamps: { value: Float32Array; size: 1 };
      getColor: { value: Uint8Array; size: 4; normalized: true };
    };
  };
}

/**
 * One decoded hour chunk. Trips are re-ordered by render group (duration class,
 * then start time), not file order, so groups are contiguous; all per-trip
 * arrays below share that order.
 */
export interface TripChunk {
  hour: number;
  tripCount: number;
  vertexCount: number;
  /** Vertex offset of each trip; length tripCount + 1, last = vertexCount. */
  startIndices: Uint32Array;
  /** lng,lat pairs (Float32), length vertexCount * 2. */
  positions: Float32Array;
  /** Absolute seconds since midnight (HH*3600 + t), length vertexCount. May exceed 86400. */
  timestamps: Float32Array;
  /** RGBA per vertex, length vertexCount * 4. */
  colors: Uint8Array;
  /** Per trip: bit0 = ebike, bit1 = member. */
  flags: Uint8Array;
  /** Per trip: absolute start / end time (seconds since midnight). */
  tripStart: Float32Array;
  tripEnd: Float32Array;
  groups: TripGroup[];
  /** Encoded byte size, for stats. */
  bytes: number;
}
