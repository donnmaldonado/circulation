// Pure decoder for trips-HH.bin (Contract). No DOM access, so it can move into a
// Web Worker unchanged if decode time ever shows up in profiles.

import { ALPHA, COLORS } from '../config';
import { FLAG_EBIKE, FLAG_MEMBER, type Manifest, type TripChunk, type TripGroup } from './types';

/**
 * Trips are grouped by (duration class, start-time window). A group is drawn
 * only while [first start, last end + trail] covers the clock, so at any moment
 * the GPU sees roughly the trips that are actually riding — not a whole hour
 * of trips that haven't started yet or finished long ago. Short trips (the vast
 * majority) get narrow start windows; the rare long ones get wide windows so
 * the group count stays small (~11 per hour).
 */
const DURATION_CLASSES = [
  { maxDur: 20 * 60, window: 10 * 60 },
  { maxDur: 45 * 60, window: 20 * 60 },
  { maxDur: 90 * 60, window: 60 * 60 },
  { maxDur: Infinity, window: 60 * 60 },
];

export interface DecodeOptions {
  /**
   * Render only half the trails (phones). Every trip is still decoded and kept
   * in the chunk — the station index, tide sizes and station selection see all
   * of them — but each render group draws only the trips with an even index in
   * the file. Deterministic, and unbiased: file order is by start time.
   */
  thin?: boolean;
}

export function decodeChunk(buffer: ArrayBuffer, hour: number, manifest: Manifest, opts: DecodeOptions = {}): TripChunk {
  const view = new DataView(buffer);
  const tripCount = view.getUint32(0, true);
  const vertexCount = view.getUint32(4, true);
  let off = 8;
  const srcStarts = new Uint32Array(buffer, off, tripCount + 1);
  off += 4 * (tripCount + 1);
  const srcCoords = new Uint16Array(buffer, off, vertexCount * 2);
  off += 2 * vertexCount * 2;
  const srcTimes = new Uint16Array(buffer, off, vertexCount);
  off += 2 * vertexCount;
  const srcFlags = new Uint8Array(buffer, off, tripCount);
  off += tripCount;
  if (off !== buffer.byteLength || srcStarts[tripCount] !== vertexCount) {
    throw new Error(`trips-${pad(hour)}.bin: malformed (${off} != ${buffer.byteLength})`);
  }

  const base = hour * 3600;
  // Order trips by group key, then start time, so each group is a contiguous range.
  // When thinning, the kept (even-index) trips sort first within their group, so
  // the drawn half is a contiguous prefix: no copies, just shorter views.
  const thin = !!opts.thin;
  const order = new Uint32Array(tripCount);
  const key = new Uint16Array(tripCount);
  const startRel = new Uint16Array(tripCount);
  for (let i = 0; i < tripCount; i++) {
    order[i] = i;
    const t0 = srcTimes[srcStarts[i]];
    const dur = srcTimes[srcStarts[i + 1] - 1] - t0;
    let c = 0;
    while (dur > DURATION_CLASSES[c].maxDur) c++;
    key[i] = c * 100 + Math.floor(t0 / DURATION_CLASSES[c].window);
    startRel[i] = t0;
  }
  order.sort((a, b) => key[a] - key[b] || (thin ? (a & 1) - (b & 1) : 0) || startRel[a] - startRel[b]);

  const [minLng, minLat, maxLng, maxLat] = manifest.bbox;
  const sx = (maxLng - minLng) / 65535;
  const sy = (maxLat - minLat) / 65535;

  const startIndices = new Uint32Array(tripCount + 1);
  const positions = new Float32Array(vertexCount * 2);
  const timestamps = new Float32Array(vertexCount);
  const colors = new Uint8Array(vertexCount * 4);
  const flags = new Uint8Array(tripCount);
  const tripStart = new Float32Array(tripCount);
  const tripEnd = new Float32Array(tripCount);

  let v = 0;
  for (let j = 0; j < tripCount; j++) {
    const i = order[j];
    const f = srcFlags[i];
    flags[j] = f;
    startIndices[j] = v;
    const c = f & FLAG_EBIKE ? COLORS.ebike : COLORS.classic;
    const a = f & FLAG_MEMBER ? ALPHA.member : ALPHA.casual;
    const s0 = srcStarts[i];
    const s1 = srcStarts[i + 1];
    tripStart[j] = base + srcTimes[s0];
    tripEnd[j] = base + srcTimes[s1 - 1];
    for (let k = s0; k < s1; k++, v++) {
      positions[2 * v] = minLng + srcCoords[2 * k] * sx;
      positions[2 * v + 1] = minLat + srcCoords[2 * k + 1] * sy;
      timestamps[v] = base + srcTimes[k];
      colors[4 * v] = c[0];
      colors[4 * v + 1] = c[1];
      colors[4 * v + 2] = c[2];
      colors[4 * v + 3] = a;
    }
  }
  startIndices[tripCount] = v;

  const chunk: TripChunk = {
    hour,
    tripCount,
    vertexCount,
    startIndices,
    positions,
    timestamps,
    colors,
    flags,
    tripStart,
    tripEnd,
    groups: [],
    bytes: buffer.byteLength,
  };
  const sortedKeys = new Uint16Array(tripCount);
  const skipped = new Uint8Array(tripCount);
  for (let j = 0; j < tripCount; j++) {
    sortedKeys[j] = key[order[j]];
    skipped[j] = thin ? order[j] & 1 : 0;
  }
  chunk.groups = makeGroups(chunk, sortedKeys, skipped);
  return chunk;
}

function makeGroups(chunk: TripChunk, keys: Uint16Array, skipped: Uint8Array): TripGroup[] {
  const groups: TripGroup[] = [];
  let from = 0;
  while (from < chunk.tripCount) {
    let to = from;
    let drawTo = from; // end of the drawn prefix (== to unless thinning)
    let tMin = Infinity;
    let tMax = -Infinity;
    while (to < chunk.tripCount && keys[to] === keys[from]) {
      if (!skipped[to]) {
        drawTo = to + 1;
        tMin = Math.min(tMin, chunk.tripStart[to]);
        tMax = Math.max(tMax, chunk.tripEnd[to]);
      }
      to++;
    }
    if (drawTo === from) {
      from = to;
      continue; // nothing drawn in this group
    }
    const v0 = chunk.startIndices[from];
    const v1 = chunk.startIndices[drawTo];
    const startIndices = new Uint32Array(drawTo - from + 1);
    for (let i = from; i <= drawTo; i++) startIndices[i - from] = chunk.startIndices[i] - v0;
    groups.push({
      id: `${pad(chunk.hour)}-${keys[from]}`,
      tripFrom: from,
      tripTo: to,
      tMin,
      tMax,
      data: {
        length: drawTo - from,
        startIndices,
        attributes: {
          getPath: { value: chunk.positions.subarray(v0 * 2, v1 * 2), size: 2 },
          getTimestamps: { value: chunk.timestamps.subarray(v0, v1), size: 1 },
          getColor: { value: chunk.colors.subarray(v0 * 4, v1 * 4), size: 4, normalized: true },
        },
      },
    });
    from = to;
  }
  return groups;
}

export const pad = (n: number) => String(n).padStart(2, '0');
