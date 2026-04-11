// Station click: highlight the trips that leave the selected station (all loaded
// hours), dim everything else, ring its top destinations, and show a panel with
// counts. Rebuilds as more hour chunks are indexed, so an early click fills in.
// Also owns the hover tooltip. Clear with the close button, Esc, or a click on
// empty map.

import type { Layer, PickingInfo } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TRAIL_LENGTH } from '../config';
import type { ChunkStore } from '../data/loader';
import { ADDITIVE_BLEND } from '../layers/trips';
import { CulledTripsLayer } from '../layers/culled-trips-layer';
import type { Clock } from '../playback/clock';
import { formatClock } from '../playback/clock';
import { NO_STATION, TIDE_BINS, type StationIndex } from './station-index';
import { pickedStation } from './tide-layer';

/** Opacity of the base trails while a station is selected. */
export const DIMMED_TRIPS = 0.12;
/** Opacity of the tide dots while a station is selected (its rings stay full). */
export const DIMMED_TIDE = 0.4;
const TOP_N = 5;

interface Selection {
  station: number;
  version: number;
  outbound: number;
  inbound: number;
  top: { station: number; count: number }[];
  /** Binary path data of the outbound trips (null if none). */
  paths: object | null;
  trips: object | null;
  marks: object;
}

export class StationSelection {
  private sel: Selection | null = null;
  private readonly panel: HTMLElement;
  private readonly tip: HTMLElement;
  private lastBin = -1;
  private hovered = -1;

  constructor(
    private readonly index: StationIndex,
    private readonly store: ChunkStore,
    private readonly clock: Clock,
    private readonly requestRender: () => void,
    parent: HTMLElement,
  ) {
    this.panel = document.createElement('aside');
    this.panel.className = 'station-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-live', 'polite');
    parent.appendChild(this.panel);
    this.panel.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.sp-close')) this.clear();
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-station]');
      if (li) this.select(Number(li.dataset.station));
    });

    this.tip = document.createElement('div');
    this.tip.className = 'station-tip';
    this.tip.hidden = true;
    parent.appendChild(this.tip);

    index.onChange(() => {
      if (this.sel) this.select(this.sel.station);
    });
    clock.subscribe(() => {
      const bin = clock.bin15;
      if (bin === this.lastBin) return;
      this.lastBin = bin;
      if (this.sel) this.renderFlow();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.sel) this.clear();
    });
  }

  get station(): number {
    return this.sel?.station ?? -1;
  }

  /** Opacity for the base trips layers. */
  get baseOpacity(): number {
    return this.sel ? DIMMED_TRIPS : 1;
  }

  /** deck onClick handler: select a tide dot, or clear on empty map. */
  handleClick = (info: PickingInfo): void => {
    const s = pickedStation(info);
    if (s >= 0) this.select(s);
    else if (this.sel) this.clear();
  };

  /** deck onHover handler: tooltip + pointer cursor. */
  handleHover = (info: PickingInfo, canvas: HTMLElement): void => {
    const s = pickedStation(info);
    canvas.style.cursor = s >= 0 ? 'pointer' : '';
    if (s < 0) {
      this.hovered = -1;
      this.tip.hidden = true;
      return;
    }
    if (s !== this.hovered) {
      this.hovered = s;
      const st = this.index.stations[s];
      const bin = this.clock.bin15;
      this.tip.innerHTML = `<div class="st-box"><b>${esc(st.name)}</b><div class="st-flow">${flowHtml(st.tide[bin] ?? 0)} <em>${binLabel(bin)}</em></div></div>`;
    }
    this.tip.hidden = false;
    this.tip.style.transform = `translate(${Math.round(info.x)}px, ${Math.round(info.y)}px)`;
  };

  select(s: number): void {
    if (s < 0 || s >= this.index.n) return;
    const t0 = performance.now();
    this.sel = this.build(s);
    this.lastSelectMs = performance.now() - t0;
    this.renderPanel();
    this.requestRender();
  }

  /** Time the last select() took (ms), for verification. */
  lastSelectMs = 0;

  clear(): void {
    if (!this.sel) return;
    this.sel = null;
    this.panel.hidden = true;
    this.requestRender();
  }

  /** Highlighted outbound trips: full-day paths (faint) + the ones riding now (bright). Draw above base trips. */
  trailLayers(t: number): Layer[] {
    const sel = this.sel;
    if (!sel?.paths) return [];
    return [
      new PathLayer({
        id: 'sel-paths',
        data: sel.paths as never,
        _pathType: 'open',
        getColor: [255, 244, 230, 44],
        widthUnits: 'pixels',
        getWidth: 1,
        widthMinPixels: 1,
        parameters: ADDITIVE_BLEND,
      }),
      new CulledTripsLayer({
        id: 'sel-trips',
        data: sel.trips as never,
        _pathType: 'open',
        currentTime: t,
        trailLength: TRAIL_LENGTH * 1.5,
        fadeTrail: true,
        widthUnits: 'pixels',
        getWidth: 2.6,
        widthMinPixels: 1.5,
        capRounded: true,
        jointRounded: true,
        parameters: ADDITIVE_BLEND,
      }),
    ];
  }

  /** Rings on the selected station and its top destinations. Draw above the tide dots. */
  markLayers(): Layer[] {
    const sel = this.sel;
    if (!sel) return [];
    return [
      new ScatterplotLayer({
        id: 'sel-marks',
        data: sel.marks as never,
        radiusUnits: 'pixels',
        stroked: true,
        filled: false,
        lineWidthUnits: 'pixels',
        getLineWidth: 1.5,
        pickable: false,
        parameters: { depthWriteEnabled: false, depthCompare: 'always' },
      }),
    ];
  }

  private build(s: number): Selection {
    const { index, store } = this;
    const counts = new Uint32Array(index.n);
    let outbound = 0;
    let inbound = 0;
    let vertices = 0;
    const picked: [number, number][] = []; // [hour, trip]
    for (let h = 0; h < 24; h++) {
      const cs = index.chunks[h];
      const chunk = store.chunks[h];
      if (!cs || !chunk) continue;
      const { from, to } = cs;
      for (let j = 0; j < from.length; j++) {
        if (to[j] === s) inbound++;
        if (from[j] !== s) continue;
        outbound++;
        if (to[j] !== NO_STATION) counts[to[j]]++;
        picked.push([h, j]);
        vertices += chunk.startIndices[j + 1] - chunk.startIndices[j];
      }
    }

    const top: { station: number; count: number }[] = [];
    for (let d = 0; d < index.n; d++) {
      const c = counts[d];
      if (!c) continue;
      if (top.length < TOP_N || c > top[top.length - 1].count) {
        top.push({ station: d, count: c });
        top.sort((a, b) => b.count - a.count || a.station - b.station);
        if (top.length > TOP_N) top.pop();
      }
    }

    let paths: object | null = null;
    let trips: object | null = null;
    if (picked.length) {
      const startIndices = new Uint32Array(picked.length + 1);
      const positions = new Float32Array(vertices * 2);
      const timestamps = new Float32Array(vertices);
      const colors = new Uint8Array(vertices * 4);
      let v = 0;
      picked.forEach(([h, j], k) => {
        const c = store.chunks[h]!;
        const v0 = c.startIndices[j];
        const v1 = c.startIndices[j + 1];
        startIndices[k] = v;
        positions.set(c.positions.subarray(v0 * 2, v1 * 2), v * 2);
        timestamps.set(c.timestamps.subarray(v0, v1), v);
        colors.set(c.colors.subarray(v0 * 4, v1 * 4), v * 4);
        for (let q = v; q < v + (v1 - v0); q++) colors[4 * q + 3] = 255; // casual riders full too
        v += v1 - v0;
      });
      startIndices[picked.length] = v;
      paths = { length: picked.length, startIndices, attributes: { getPath: { value: positions, size: 2 } } };
      trips = {
        length: picked.length,
        startIndices,
        attributes: {
          getPath: { value: positions, size: 2 },
          getTimestamps: { value: timestamps, size: 1 },
          getColor: { value: colors, size: 4, normalized: true },
        },
      };
    }

    // Rings: the selected station, then its top destinations.
    const ringStations = [s, ...top.map((d) => d.station).filter((d) => d !== s)];
    const pos = new Float32Array(ringStations.length * 2);
    const radius = new Float32Array(ringStations.length);
    const ring = new Uint8Array(ringStations.length * 4);
    ringStations.forEach((st, k) => {
      pos[2 * k] = index.positions[2 * st];
      pos[2 * k + 1] = index.positions[2 * st + 1];
      radius[k] = k === 0 ? 11 : 7;
      ring.set(k === 0 ? [255, 255, 255, 240] : [255, 244, 230, 170], 4 * k);
    });
    const marks = {
      length: ringStations.length,
      attributes: {
        getPosition: { value: pos, size: 2 },
        getRadius: { value: radius, size: 1 },
        getLineColor: { value: ring, size: 4, normalized: true },
      },
    };

    return { station: s, version: index.version, outbound, inbound, top, paths, trips, marks };
  }

  private renderPanel(): void {
    const sel = this.sel!;
    const { stations } = this.index;
    const st = stations[sel.station];
    const max = sel.top[0]?.count ?? 1;
    const hours = this.index.hoursIndexed;
    const dests = sel.top.length
      ? sel.top
          .map(
            (d) => `<li data-station="${d.station}" style="--w:${((100 * d.count) / max).toFixed(1)}%">
              <span class="sp-dn">${d.station === sel.station ? '↺ back to the same dock' : esc(stations[d.station].name)}</span>
              <span class="sp-dc">${d.count.toLocaleString('en-US')}</span></li>`,
          )
          .join('')
      : '<li class="sp-empty">No departures in the loaded hours yet.</li>';
    this.panel.innerHTML = `
      <button class="sp-close" type="button" aria-label="Close station details">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
      <div class="sp-kicker">Station</div>
      <h2 class="sp-name">${esc(st.name)}</h2>
      <div class="sp-flow"></div>
      <div class="sp-stats">
        <span><b>${sel.outbound.toLocaleString('en-US')}</b> rides out</span>
        <span><b>${sel.inbound.toLocaleString('en-US')}</b> rides in</span>
        <span class="sp-day">all day</span>
      </div>
      <h3>Top destinations</h3>
      <ol class="sp-dests">${dests}</ol>
      ${hours < 24 ? `<div class="sp-note">Counting… ${hours}/24 hours loaded</div>` : ''}`;
    this.panel.hidden = false;
    this.renderFlow();
  }

  private renderFlow(): void {
    const el = this.panel.querySelector<HTMLElement>('.sp-flow');
    if (!el || !this.sel) return;
    const bin = this.clock.bin15;
    const raw = this.index.stations[this.sel.station].tide[bin] ?? 0;
    el.innerHTML = `${flowHtml(raw)} <em>${binLabel(bin)}</em>`;
  }
}

/** "+12 arriving / 15 min" with the tide colour class. */
function flowHtml(net: number): string {
  if (net > 0) return `<span class="flow sink">+${net} arriving</span> net / 15 min`;
  if (net < 0) return `<span class="flow source">${-net} leaving</span> net / 15 min`;
  return `<span class="flow">balanced</span> this 15 min`;
}

function binLabel(bin: number): string {
  return `${formatClock(bin * 900)}–${formatClock(((bin + 1) % TIDE_BINS) * 900)}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
