// Selection: a station (tide-dot click) or a place (a named set of docks, see
// places.ts). Highlights the trips that leave it or arrive at it (all loaded
// hours), dims everything else, rings its docks and the busiest docks at the
// other end, and shows a details panel (rides by hour, top docks at the other
// end). The direction (rides leaving or arriving) is kept across selections,
// so switching place or clicking a station keeps it. Rebuilds as more hour
// chunks are indexed, so an early selection fills in. Also owns the hover
// tooltip. Clear with Esc or the filter bar's "All of New York City".

import type { Layer, PickingInfo } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TRAIL_LENGTH } from '../config';
import type { ChunkStore } from '../data/loader';
import { ADDITIVE_BLEND } from '../layers/trips';
import { CulledTripsLayer } from '../layers/culled-trips-layer';
import type { Clock } from '../playback/clock';
import { formatClock } from '../playback/clock';
import { type Place, placeOutline, placeStations } from './places';
import { NO_STATION, TIDE_BINS, type StationIndex } from './station-index';
import { pickedStation } from './tide-layer';

/** Opacity of the base trails while something is selected. */
export const DIMMED_TRIPS = 0.12;
/** Opacity of the tide dots while something is selected (its rings stay full). */
export const DIMMED_TIDE = 0.4;
const TOP_N = 5;

/** 'out': rides that start at the selection; 'in': rides that end there. */
export type Dir = 'out' | 'in';

export type Target = { kind: 'station'; station: number } | { kind: 'place'; place: Place };

interface Selection {
  target: Target;
  dir: Dir;
  /** Station indices of the selection's docks. */
  members: number[];
  version: number;
  outbound: number;
  inbound: number;
  /** Highlighted rides with both ends at the selection's docks. */
  internal: number;
  /** Highlighted rides per hour (of start for 'out', of arrival for 'in'). */
  hourly: Uint32Array;
  /** Busiest docks at the other end, outside the selection. */
  top: { station: number; count: number }[];
  /** Binary path data of the highlighted trips (null if none). */
  paths: object | null;
  trips: object | null;
  marks: object;
  outline: [number, number][] | null;
}

export class StationSelection {
  private sel: Selection | null = null;
  private readonly panel: HTMLElement;
  private readonly tip: HTMLElement;
  private lastBin = -1;
  private hovered = -1;
  /** Direction for the next selection; follows the last one made. */
  private preferredDir: Dir;
  /** Whether the details panel shows while something is selected. */
  private detailsOpen: boolean;
  private readonly changeListeners = new Set<(active: boolean) => void>();

  constructor(
    private readonly index: StationIndex,
    private readonly store: ChunkStore,
    private readonly clock: Clock,
    private readonly requestRender: () => void,
    parent: HTMLElement,
    opts: { dir: Dir; details: boolean },
  ) {
    this.preferredDir = opts.dir;
    this.detailsOpen = opts.details;
    this.panel = document.createElement('aside');
    this.panel.className = 'station-panel';
    this.panel.id = 'details';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-live', 'polite');
    parent.appendChild(this.panel);
    this.panel.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      if (el.closest('.sp-close')) return this.showDetails(false);
      const hour = el.closest<HTMLElement>('[data-hour]');
      if (hour) return this.clock.seek(Number(hour.dataset.hour) * 3600);
      const li = el.closest<HTMLElement>('[data-station]');
      if (li) this.select(Number(li.dataset.station));
    });

    this.tip = document.createElement('div');
    this.tip.className = 'station-tip';
    this.tip.hidden = true;
    parent.appendChild(this.tip);

    index.onChange(() => {
      if (this.sel) this.set(this.sel.target, this.sel.dir);
    });
    clock.subscribe(() => {
      const bin = clock.bin15;
      if (bin === this.lastBin) return;
      this.lastBin = bin;
      if (this.sel) this.renderLive();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.sel) this.showDetails(false);
    });
  }

  /** Called with whether something is selected, on every change: select, direction, rebuild as hours load, details shown/hidden, clear. Returns an unsubscribe function. */
  onChange(fn: (active: boolean) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  get active(): boolean {
    return this.sel !== null;
  }

  /** The selected station, or -1 (also -1 while a place is selected). */
  get station(): number {
    const t = this.sel?.target;
    return t?.kind === 'station' ? t.station : -1;
  }

  /** The selected place, or null. */
  get place(): Place | null {
    const t = this.sel?.target;
    return t?.kind === 'place' ? t.place : null;
  }

  /** Direction of the selection, or the one the next selection will use. */
  get dir(): Dir {
    return this.sel?.dir ?? this.preferredDir;
  }

  /** Rides ending at / starting from the selection (loaded hours); zero when nothing is selected. */
  get counts(): { inbound: number; outbound: number } {
    return { inbound: this.sel?.inbound ?? 0, outbound: this.sel?.outbound ?? 0 };
  }

  get details(): boolean {
    return this.detailsOpen;
  }

  /** Show or hide the details panel (the selection stays). */
  showDetails(open: boolean): void {
    if (open === this.detailsOpen) return;
    this.detailsOpen = open;
    this.panel.hidden = !(open && this.sel);
    this.changeListeners.forEach((fn) => fn(this.active));
  }

  /** Opacity for the base trips layers. */
  get baseOpacity(): number {
    return this.sel ? DIMMED_TRIPS : 1;
  }

  /** deck onClick handler: select a tide dot. A click on empty map keeps the filter. */
  handleClick = (info: PickingInfo): void => {
    const s = pickedStation(info);
    if (s >= 0) this.select(s);
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

  /** Select a station, keeping the current direction. */
  select(s: number, dir: Dir = this.dir): void {
    if (s < 0 || s >= this.index.n) return;
    this.set({ kind: 'station', station: s }, dir);
  }

  /** Select a place, keeping the current direction. */
  selectPlace(place: Place, dir: Dir = this.dir): void {
    this.set({ kind: 'place', place }, dir);
  }

  /** Switch between rides leaving and rides arriving (also when nothing is selected yet). */
  setDir(dir: Dir): void {
    if (this.sel) {
      if (this.sel.dir !== dir) this.set(this.sel.target, dir);
    } else if (this.preferredDir !== dir) {
      this.preferredDir = dir;
      this.changeListeners.forEach((fn) => fn(false));
    }
  }

  /** Time the last select() took (ms), for verification. */
  lastSelectMs = 0;

  clear(): void {
    if (!this.sel) return;
    this.sel = null;
    this.panel.hidden = true;
    this.requestRender();
    this.changeListeners.forEach((fn) => fn(false));
  }

  /** Highlighted trips: full-day paths (faint) + the ones riding now (bright). Draw above base trips. */
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

  /** The place outline and rings on the selection's docks and the top docks at the other end. Draw above the tide dots. */
  markLayers(): Layer[] {
    const sel = this.sel;
    if (!sel) return [];
    const layers: Layer[] = [];
    if (sel.outline) {
      layers.push(
        new PathLayer({
          id: 'sel-outline',
          data: [sel.outline],
          getPath: (d: [number, number][]) => d,
          getColor: [255, 244, 230, 90],
          widthUnits: 'pixels',
          getWidth: 1.2,
          jointRounded: true,
          pickable: false,
          parameters: { depthWriteEnabled: false, depthCompare: 'always' },
        }),
      );
    }
    layers.push(
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
    );
    return layers;
  }

  private set(target: Target, dir: Dir): void {
    const t0 = performance.now();
    this.sel = this.build(target, dir);
    this.preferredDir = dir;
    this.lastSelectMs = performance.now() - t0;
    this.renderPanel();
    this.requestRender();
    this.changeListeners.forEach((fn) => fn(true));
  }

  private mask(members: number[]): Uint8Array {
    const mask = new Uint8Array(this.index.n);
    for (const s of members) mask[s] = 1;
    return mask;
  }

  private build(target: Target, dir: Dir): Selection {
    const { index, store } = this;
    const members = target.kind === 'station' ? [target.station] : placeStations(target.place, index);
    const mask = this.mask(members);
    const isIn = (s: number) => s !== NO_STATION && mask[s] === 1;
    const counts = new Uint32Array(index.n);
    const hourly = new Uint32Array(24);
    let outbound = 0;
    let inbound = 0;
    let internal = 0;
    let vertices = 0;
    const picked: [number, number][] = []; // [hour, trip]
    for (let h = 0; h < 24; h++) {
      const cs = index.chunks[h];
      const chunk = store.chunks[h];
      if (!cs || !chunk) continue;
      const { from, to } = cs;
      for (let j = 0; j < from.length; j++) {
        const a = isIn(from[j]);
        const b = isIn(to[j]);
        if (a) outbound++;
        if (b) inbound++;
        if (!(dir === 'out' ? a : b)) continue;
        if (a && b) internal++;
        const other = dir === 'out' ? to[j] : from[j];
        if (other !== NO_STATION && !mask[other]) counts[other]++;
        hourly[dir === 'out' ? h : Math.floor(chunk.tripEnd[j] / 3600) % 24]++;
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

    // Rings: the selection's docks (a big ring for a station, small ones for a
    // place's many docks), then the top docks at the other end.
    const single = target.kind === 'station';
    const ringStations = [...members, ...top.map((d) => d.station)];
    const pos = new Float32Array(ringStations.length * 2);
    const radius = new Float32Array(ringStations.length);
    const ring = new Uint8Array(ringStations.length * 4);
    ringStations.forEach((st, k) => {
      const own = k < members.length;
      pos[2 * k] = index.positions[2 * st];
      pos[2 * k + 1] = index.positions[2 * st + 1];
      radius[k] = own ? (single ? 11 : 6) : 7;
      ring.set(own ? [255, 255, 255, 240] : [255, 244, 230, 170], 4 * k);
    });
    const marks = {
      length: ringStations.length,
      attributes: {
        getPosition: { value: pos, size: 2 },
        getRadius: { value: radius, size: 1 },
        getLineColor: { value: ring, size: 4, normalized: true },
      },
    };

    return {
      target,
      dir,
      members,
      version: index.version,
      outbound,
      inbound,
      internal,
      hourly,
      top,
      paths,
      trips,
      marks,
      outline: target.kind === 'place' ? placeOutline(target.place) : null,
    };
  }

  private renderPanel(): void {
    const sel = this.sel!;
    const { stations } = this.index;
    const place = sel.target.kind === 'place' ? sel.target.place : null;
    const name = place ? place.name : stations[(sel.target as { station: number }).station].name;
    const out = sel.dir === 'out';
    const max = sel.top[0]?.count ?? 1;
    const hours = this.index.hoursIndexed;
    const n = (x: number) => x.toLocaleString('en-US');
    const dests = sel.top.length
      ? sel.top
          .map(
            (d) => `<li data-station="${d.station}" style="--w:${((100 * d.count) / max).toFixed(1)}%">
              <span class="sp-dn">${esc(stations[d.station].name)}</span>
              <span class="sp-dc">${n(d.count)}</span></li>`,
          )
          .join('')
      : `<li class="sp-empty">No ${out ? 'departures' : 'arrivals'} in the loaded hours yet.</li>`;
    const hmax = Math.max(1, ...sel.hourly);
    const bars = [...sel.hourly]
      .map(
        (c, h) =>
          `<button type="button" data-hour="${h}" style="--h:${((100 * c) / hmax).toFixed(1)}%" aria-label="${formatClock(h * 3600)}: ${n(c)} rides" title="${formatClock(h * 3600)} · ${n(c)} rides"></button>`,
      )
      .join('');
    const peak = sel.hourly.indexOf(Math.max(...sel.hourly));
    const inside = place ? place.name : 'this dock';
    this.panel.innerHTML = `
      <button class="sp-close" type="button" aria-label="Hide details">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
      <div class="sp-kicker">${place ? 'Place' : 'Station'}</div>
      <h2 class="sp-name">${esc(name)}</h2>
      ${place ? `<div class="sp-blurb">${esc(place.blurb)} · ${sel.members.length} docks</div>` : '<div class="sp-flow"></div>'}
      <div class="sp-total"><b>${n(out ? sel.outbound : sel.inbound)}</b> rides ${out ? 'leaving' : 'arriving'}</div>
      <h3>${out ? 'Leaving' : 'Arriving'} by hour${sel.inbound + sel.outbound ? ` <span class="sp-peak">peak ${formatClock(peak * 3600)}</span>` : ''}</h3>
      <div class="sp-hours" style="--now:${this.clock.hour}">${bars}</div>
      <h3>${out ? 'Top destinations' : 'Top origins'}</h3>
      <ol class="sp-dests">${dests}</ol>
      ${place && sel.internal ? `<div class="sp-note">${n(sel.internal)} of these rides ${out ? 'end' : 'start'} at ${esc(inside)} too.</div>` : ''}
      ${hours < 24 ? `<div class="sp-note">Counting… ${hours}/24 hours loaded</div>` : ''}`;
    this.panel.hidden = !this.detailsOpen;
    this.renderLive();
  }

  /** The parts that follow the clock: the station's net flow now, the current-hour bar. */
  private renderLive(): void {
    if (!this.sel) return;
    const hour = this.clock.hour;
    this.panel.querySelectorAll<HTMLElement>('[data-hour]').forEach((b) => b.classList.toggle('now', Number(b.dataset.hour) === hour));
    const el = this.panel.querySelector<HTMLElement>('.sp-flow');
    if (!el || this.sel.target.kind !== 'station') return;
    const bin = this.clock.bin15;
    const raw = this.index.stations[this.sel.target.station].tide[bin] ?? 0;
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
