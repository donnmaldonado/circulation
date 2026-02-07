// Layer registry. Workstreams add *providers* (functions of sim time that return
// deck.gl layers); the scene concatenates them in `order` and hands the result
// to the overlay once per frame. Trips are order 0; draw tide dots above (e.g. 10).

import type { Layer } from '@deck.gl/core';
import type { MapboxOverlay } from '@deck.gl/mapbox';

export type LayerProvider = (time: number) => (Layer | null | false | undefined)[];

interface Entry {
  id: string;
  order: number;
  fn: LayerProvider;
}

export class Scene {
  private entries: Entry[] = [];
  private pending = 0;
  private listeners = new Set<() => void>();
  /** Number of deck frames drawn (incremented from deck's onAfterRender). */
  frames = 0;

  constructor(
    private readonly overlay: MapboxOverlay,
    private readonly getTime: () => number,
  ) {
    overlay.setProps({
      onAfterRender: () => {
        this.frames++;
        this.listeners.forEach((fn) => fn());
      },
    });
  }

  /** Register (or replace) a provider. Returns a remove function. */
  addProvider(id: string, fn: LayerProvider, order = 0): () => void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.entries.push({ id, order, fn });
    this.entries.sort((a, b) => a.order - b.order);
    this.requestRender();
    return () => {
      this.entries = this.entries.filter((e) => e.id !== id);
      this.requestRender();
    };
  }

  /** Rebuild layers for the current time now (call from the clock tick). */
  render(): void {
    cancelAnimationFrame(this.pending);
    this.pending = 0;
    const t = this.getTime();
    const layers: Layer[] = [];
    for (const e of this.entries) {
      for (const l of e.fn(t)) if (l) layers.push(l);
    }
    this.overlay.setProps({ layers });
  }

  /** Coalesce a render into the next animation frame (use when paused or on data load). */
  requestRender(): void {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.render();
    });
  }

  /** Called after each deck frame is drawn. */
  onAfterRender(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
