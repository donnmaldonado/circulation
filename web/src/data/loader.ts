// Manifest + hour-chunk loading.
//
// Chunks are fetched in *playback order* from the current sim hour, with
// limited concurrency. A seek re-prioritises whatever hasn't started yet.

import { FETCH_CONCURRENCY } from '../config';
import { decodeChunk, pad } from './decode';
import type { Manifest, Station, TripChunk } from './types';

export interface DataSource {
  /** Base URL ending in '/', e.g. "./data/" or "./fixture/". */
  base: string;
  manifest: Manifest;
  isFixture: boolean;
}

const ROOT = import.meta.env.BASE_URL; // "./" in builds, "/" in dev

async function tryManifest(base: string): Promise<Manifest | null> {
  try {
    const res = await fetch(`${base}manifest.json`);
    // The dev server answers unknown paths with index.html, so check the type too.
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Pick the data directory: `data/` by default, falling back to `fixture/` when
 * `data/manifest.json` is missing. `?data=fixture` (or `?data=data`) forces one.
 */
export async function resolveDataSource(params: URLSearchParams): Promise<DataSource> {
  const forced = params.get('data');
  const order = forced ? [forced] : ['data', 'fixture'];
  for (const dir of order) {
    const base = `${ROOT}${dir.replace(/\/?$/, '/')}`;
    const manifest = await tryManifest(base);
    if (manifest) return { base, manifest, isFixture: dir.startsWith('fixture') || !!manifest.fixture };
  }
  throw new Error(`No manifest.json found in ${order.map((d) => `${d}/`).join(' or ')}`);
}

export async function loadStations(src: DataSource): Promise<Station[]> {
  const res = await fetch(`${src.base}stations.json`);
  if (!res.ok) throw new Error(`stations.json: HTTP ${res.status}`);
  return (await res.json()) as Station[];
}

/** Hours whose trips can be on screen at `hour` (trips last up to 3h), in fetch priority. */
export function playbackOrder(hour: number): number[] {
  const h = (k: number) => (((hour + k) % 24) + 24) % 24;
  // Current hour first, then the hour before (trips in progress), then ahead.
  const first = [h(0), h(-1), h(1), h(-2), h(2), h(3), h(-3)];
  const rest: number[] = [];
  for (let k = 4; k < 24; k++) rest.push(h(k));
  const seen = new Set<number>();
  return [...first, ...rest].filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

export interface LoadStats {
  loaded: number;
  bytes: number;
  decodeMs: number;
  vertices: number;
  trips: number;
}

type Listener = (chunk: TripChunk) => void;

export class ChunkStore {
  readonly chunks: (TripChunk | undefined)[] = new Array(24).fill(undefined);
  readonly stats: LoadStats = { loaded: 0, bytes: 0, decodeMs: 0, vertices: 0, trips: 0 };
  /** Bumped on every chunk load; cheap change detection for renderers. */
  version = 0;
  private queue: number[] = [];
  private inflight = new Set<number>();
  private failed = new Set<number>();
  private listeners = new Set<Listener>();
  private waiters: { hours: number[]; resolve: () => void }[] = [];

  constructor(
    readonly src: DataSource,
    private readonly concurrency = FETCH_CONCURRENCY,
  ) {}

  /** Start (or re-prioritise) loading from `hour` onwards in playback order. */
  prioritize(hour: number): void {
    this.queue = playbackOrder(hour).filter(
      (h) => !this.chunks[h] && !this.inflight.has(h) && !this.failed.has(h),
    );
    this.pump();
  }

  get(hour: number): TripChunk | undefined {
    return this.chunks[hour];
  }

  /** All chunks decoded so far. */
  loaded(): TripChunk[] {
    return this.chunks.filter((c): c is TripChunk => !!c);
  }

  isLoaded(hour: number): boolean {
    return !!this.chunks[hour] || this.failed.has(hour);
  }

  /** Resolves once every hour in `hours` is loaded (or has failed). */
  whenLoaded(hours: number[]): Promise<void> {
    if (hours.every((h) => this.isLoaded(h))) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ hours, resolve }));
  }

  /** Called with each chunk as it lands. Returns an unsubscribe function. */
  onLoad(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private pump(): void {
    while (this.inflight.size < this.concurrency && this.queue.length) {
      const hour = this.queue.shift()!;
      if (this.chunks[hour] || this.inflight.has(hour)) continue;
      this.inflight.add(hour);
      void this.fetchChunk(hour).finally(() => {
        this.inflight.delete(hour);
        this.pump();
      });
    }
  }

  private async fetchChunk(hour: number, attempt = 0): Promise<void> {
    const name = this.src.manifest.chunks[hour] ?? `trips-${pad(hour)}.bin`;
    try {
      const res = await fetch(`${this.src.base}${name}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const t0 = performance.now();
      const chunk = decodeChunk(buf, hour, this.src.manifest);
      const dt = performance.now() - t0;
      this.chunks[hour] = chunk;
      this.version++;
      Object.assign(this.stats, {
        loaded: this.stats.loaded + 1,
        bytes: this.stats.bytes + buf.byteLength,
        decodeMs: this.stats.decodeMs + dt,
        vertices: this.stats.vertices + chunk.vertexCount,
        trips: this.stats.trips + chunk.tripCount,
      });
      this.listeners.forEach((fn) => fn(chunk));
    } catch (err) {
      if (attempt < 1) return this.fetchChunk(hour, attempt + 1);
      console.error(`[loader] ${name} failed:`, err);
      this.failed.add(hour);
    }
    this.waiters = this.waiters.filter((w) => {
      if (!w.hours.every((h) => this.isLoaded(h))) return true;
      w.resolve();
      return false;
    });
  }
}
