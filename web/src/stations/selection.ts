// Selection: a station (tide-dot click) or a place (a named set of docks, see
// places.ts). Highlights the trips that leave it or arrive at it (all loaded
// hours), dims everything else, marks it on the map in the selection colour
// (a labelled halo and ring for a station; a labelled outline for a place,
// with a dot on each of its docks),
// numbers the busiest docks at the other end to match the list, and shows a details panel (rides by hour, top docks at the other
// end). The direction (rides leaving or arriving) is kept across selections,
// so switching place or clicking a station keeps it. Rebuilds as more hour
// chunks are indexed, so an early selection fills in. Also owns the hover
// tooltip. Clear with Esc or the filter bar's "All of New York City".

import type { Layer, PickingInfo } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { SELECTION_COLOR, TRAIL_LENGTH } from '../config';
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
/** Colour of the selection's full-day routes: where they overlap they build up to this and no brighter. */
export const ROUTE_COLOR = [89, 85, 80] as [number, number, number];
const TOP_N = 5;

type LngLat = [number, number];
/** Map marks draw over everything, regardless of depth. */
const ON_TOP = { depthWriteEnabled: false, depthCompare: 'always' } as const;
const INK: [number, number, number, number] = [6, 7, 10, 215];
const WARM: [number, number, number, number] = [255, 244, 230, 235];
const SEL = (alpha: number): [number, number, number, number] => [...SELECTION_COLOR, alpha];
const LABEL_FONT = "ui-sans-serif, -apple-system, 'Inter', 'Helvetica Neue', Arial, sans-serif";

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
  /** The same per 15 minutes, for the timeline. */
  quarterly: Uint32Array;
  /** Busiest docks at the other end, outside the selection. */
  top: { station: number; count: number }[];
  /** Binary path data of the highlighted trips (null if none). */
  paths: object | null;
  trips: object | null;
  /** Positions of the selection's docks. */
  own: LngLat[];
  /** The top docks at the other end, ranked from 1 (same order as `top`). */
  ranked: { position: LngLat; rank: number }[];
  /** The selection's name on the map: over the station, or at the top of the place's outline. */
  label: { position: LngLat; text: string };
  outline: LngLat[] | null;
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

  /** The selection's rides per 15 minutes, and what they are ("Leaving Central Park"); null when nothing is selected. */
  get timeline(): { values: Uint32Array; caption: string } | null {
    const sel = this.sel;
    if (!sel) return null;
    const name = sel.target.kind === 'place' ? sel.target.place.name : this.index.stations[sel.target.station].name;
    return { values: sel.quarterly, caption: `${sel.dir === 'out' ? 'Leaving' : 'Arriving at'} ${name}` };
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
      this.tip.innerHTML = `<div class="st-box"><b>${esc(st.name)}</b>${this.rankHtml(s)}<div class="st-flow">${flowHtml(st.tide[bin] ?? 0)} <em>${binLabel(bin)}</em></div></div>`;
    }
    this.tip.hidden = false;
    this.tip.style.transform = `translate(${Math.round(info.x)}px, ${Math.round(info.y)}px)`;
  };

  /** "Top destination #2 · 15 rides" when `s` is one of the numbered docks, or "Selected". */
  private rankHtml(s: number): string {
    const sel = this.sel;
    if (!sel) return '';
    if (sel.members.includes(s)) return `<div class="st-rank">${selBadge(sel.target.kind)}Selected${sel.target.kind === 'place' ? ` · ${esc(sel.target.place.name)}` : ''}</div>`;
    const i = sel.top.findIndex((d) => d.station === s);
    if (i < 0) return '';
    const what = sel.dir === 'out' ? 'Top destination' : 'Top origin';
    return `<div class="st-rank"><span class="rank">${i + 1}</span>${what} · ${sel.top[i].count.toLocaleString('en-US')} rides</div>`;
  }

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
        // Normal (not additive) blending: overlapping paths build up towards
        // this colour and stop there, so the busiest streets top out at ~35%
        // brightness instead of saturating to white. One path alone is ~6%.
        getColor: [...ROUTE_COLOR, 46],
        widthUnits: 'pixels',
        getWidth: 1,
        widthMinPixels: 1,
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

  /**
   * The selection on the map, above the tide dots, in the selection colour: a
   * place's outline (dark casing, faint fill) and a dot on each of its docks,
   * or a halo and ring on a station; the selection's name (beside the station, above the place); and
   * numbered badges on the top docks at the other end (matching the details
   * list), drawn last so a label never hides a number.
   */
  markLayers(): Layer[] {
    const sel = this.sel;
    if (!sel) return [];
    const single = sel.target.kind === 'station';
    const layers: Layer[] = [];
    if (sel.outline) {
      layers.push(
        new SolidPolygonLayer({
          id: 'sel-fill',
          data: [sel.outline],
          getPolygon: (d: LngLat[]) => d,
          getFillColor: SEL(18),
          pickable: false,
          parameters: ON_TOP,
        }),
        ...[
          { id: 'sel-outline-casing', color: INK, width: 5 },
          { id: 'sel-outline', color: SEL(235), width: 2 },
        ].map(
          (o) =>
            new PathLayer({
              id: o.id,
              data: [sel.outline],
              getPath: (d: LngLat[]) => d,
              getColor: o.color,
              widthUnits: 'pixels',
              getWidth: o.width,
              jointRounded: true,
              pickable: false,
              parameters: ON_TOP,
            }),
        ),
      );
    }
    if (single) {
      layers.push(
        new ScatterplotLayer({
          id: 'sel-halo',
          data: sel.own,
          getPosition: (d: LngLat) => d,
          radiusUnits: 'pixels',
          getRadius: 24,
          getFillColor: SEL(64),
          pickable: false,
          parameters: ON_TOP,
        }),
      );
    }
    if (single) {
      layers.push(
        ...[
          { id: 'sel-rings-casing', color: INK, width: 6 },
          { id: 'sel-rings', color: SEL(255), width: 3 },
        ].map(
          (o) =>
            new ScatterplotLayer({
              id: o.id,
              data: sel.own,
              getPosition: (d: LngLat) => d,
              radiusUnits: 'pixels',
              getRadius: 11,
              stroked: true,
              filled: false,
              lineWidthUnits: 'pixels',
              getLineWidth: o.width,
              getLineColor: o.color,
              pickable: false,
              parameters: ON_TOP,
            }),
        ),
      );
    } else {
      layers.push(
        new ScatterplotLayer({
          id: 'sel-docks',
          data: sel.own,
          getPosition: (d: LngLat) => d,
          radiusUnits: 'pixels',
          getRadius: 6,
          getFillColor: SEL(255),
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          getLineColor: INK,
          pickable: false,
          parameters: ON_TOP,
        }),
      );
    }
    layers.push(
      new TextLayer({
        id: 'sel-label',
        data: [sel.label],
        getPosition: (d: Selection['label']) => d.position,
        getText: (d: Selection['label']) => d.text,
        getColor: [255, 255, 255, 255],
        getSize: 13,
        getPixelOffset: single ? [20, 0] : [0, -8],
        fontFamily: LABEL_FONT,
        fontWeight: 600,
        characterSet: 'auto',
        getTextAnchor: single ? 'start' : 'middle',
        getAlignmentBaseline: single ? 'center' : 'bottom',
        background: true,
        getBackgroundColor: [10, 12, 16, 225],
        getBorderColor: SEL(210),
        getBorderWidth: 1,
        backgroundPadding: [8, 4],
        backgroundBorderRadius: 6,
        pickable: false,
        parameters: ON_TOP,
      }),
      new ScatterplotLayer({
        id: 'sel-top',
        data: sel.ranked,
        getPosition: (d: Selection['ranked'][number]) => d.position,
        radiusUnits: 'pixels',
        getRadius: 8.5,
        getFillColor: INK,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 1.5,
        getLineColor: WARM,
        pickable: false,
        parameters: ON_TOP,
      }),
      new TextLayer({
        id: 'sel-top-rank',
        data: sel.ranked,
        getPosition: (d: Selection['ranked'][number]) => d.position,
        getText: (d: Selection['ranked'][number]) => String(d.rank),
        getColor: WARM,
        getSize: 11,
        fontFamily: LABEL_FONT,
        fontWeight: 700,
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        pickable: false,
        parameters: ON_TOP,
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
    const quarterly = new Uint32Array(TIDE_BINS);
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
        const at = dir === 'out' ? chunk.tripStart[j] : chunk.tripEnd[j];
        hourly[dir === 'out' ? h : Math.floor(at / 3600) % 24]++;
        quarterly[Math.floor(at / 900) % TIDE_BINS]++;
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

    const at = (st: number): LngLat => [index.positions[2 * st], index.positions[2 * st + 1]];
    const outline = target.kind === 'place' ? placeOutline(target.place) : null;
    // A place's label sits on the northernmost point of its outline, clear of its docks.
    const label = outline
      ? { position: outline.reduce((a, p) => (p[1] > a[1] ? p : a)), text: target.kind === 'place' ? target.place.name : '' }
      : { position: at(members[0]), text: index.stations[members[0]].name };

    return {
      target,
      dir,
      members,
      version: index.version,
      outbound,
      inbound,
      internal,
      hourly,
      quarterly,
      top,
      paths,
      trips,
      own: members.map(at),
      ranked: top.map((d, i) => ({ position: at(d.station), rank: i + 1 })),
      label,
      outline,
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
            (d, i) => `<li data-station="${d.station}" style="--w:${((100 * d.count) / max).toFixed(1)}%">
              <span class="rank">${i + 1}</span><span class="sp-dn">${esc(stations[d.station].name)}</span>
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
    const rides = out ? sel.outbound : sel.inbound;
    const peak = rides ? formatClock(sel.hourly.indexOf(Math.max(...sel.hourly)) * 3600) : '–';
    const share = (100 * rides) / Math.max(1, this.store.src.manifest.totals.trips);
    const inside = place ? place.name : 'this dock';
    this.panel.innerHTML = `
      <button class="sp-close" type="button" aria-label="Hide details">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
      <div class="sp-kicker">${place ? `Place · ${sel.members.length} docks` : 'Station'}</div>
      <h2 class="sp-name">${selBadge(sel.target.kind)}${esc(name)}</h2>
      ${place ? `<div class="sp-blurb">${esc(place.blurb)}</div>` : '<div class="sp-flow"></div>'}
      <div class="sp-stats">
        <div><b>${n(rides)}</b>rides ${out ? 'leaving' : 'arriving'}</div>
        <div><b>${share < 0.1 && rides ? '<0.1' : share.toFixed(1)}%</b>of the day's trips</div>
        <div><b>${peak}</b>busiest hour</div>
      </div>
      <h3>${out ? 'Leaving' : 'Arriving'} by hour <span class="sp-hint">click a bar to jump there</span></h3>
      <div class="sp-hours">${bars}</div>
      <div class="sp-axis" aria-hidden="true"><span>12a</span><span>6a</span><span>12p</span><span>6p</span></div>
      <h3>${out ? 'Top destinations' : 'Top origins'}${sel.top.length ? ' <span class="sp-hint">numbered on the map</span>' : ''}</h3>
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

/** The selection's mark as on the map: a place's dock dot, or the station's ring. */
function selBadge(kind: Target['kind']): string {
  return `<span class="sel-badge${kind === 'station' ? ' ring' : ''}"></span>`;
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
