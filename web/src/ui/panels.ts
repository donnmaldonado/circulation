// Places and About panels and their entry buttons.
//
// One panel slot: the selection panel (stations/selection.ts) and these
// panels occupy the same place — top-right on desktop, a bottom
// sheet just above the HUD on phones — and only one is ever open. Opening a
// panel clears the selection; selecting a station or a place closes the panel.
// The entry buttons live in the HUD's controls row (thumb reach on phones).

import { COLORS } from '../config';
import type { Manifest } from '../data/types';
import { PLACES, placeById } from '../stations/places';
import type { StationSelection } from '../stations/selection';
import { formatDay } from './day';

export type PanelId = 'places' | 'about';

export interface PanelsHandle {
  open(id: PanelId): void;
  close(): void;
  readonly current: PanelId | null;
  /** Hook the station selection in once the tide layer is mounted. */
  attachSelection(sel: StationSelection): void;
}

const CLOSE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

export function mountPanels(o: {
  root: HTMLElement;
  navSlot: HTMLElement;
  manifest: Manifest;
  isFixture: boolean;
}): PanelsHandle {
  const nav = document.createElement('div');
  nav.className = 'nav';
  nav.innerHTML = `
    <button type="button" class="nav-btn" data-open="places" aria-expanded="false" aria-controls="panel" hidden>Places</button>
    <button type="button" class="nav-btn" data-open="about" aria-expanded="false" aria-controls="panel">About</button>`;
  o.navSlot.appendChild(nav);

  const panel = document.createElement('aside');
  panel.id = 'panel';
  panel.className = 'side-panel';
  panel.hidden = true;
  panel.setAttribute('aria-live', 'polite');
  o.root.appendChild(panel);

  let current: PanelId | null = null;
  let selection: StationSelection | null = null;

  const syncButtons = () => {
    nav.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => {
      const on = b.dataset.open === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', String(on));
    });
  };

  function open(id: PanelId) {
    if (current === id) return close();
    selection?.clear();
    current = id;
    syncButtons();
    panel.className = `side-panel panel-${id}`;
    panel.hidden = false;
    panel.scrollTop = 0;
    panel.innerHTML = frame(id === 'places' ? placesHtml(selection) : aboutHtml(o.manifest, o.isFixture));
    panel.querySelector<HTMLElement>('.pn-close')?.focus({ preventScroll: true });
  }

  function close() {
    if (!current) return;
    const was = current;
    current = null;
    panel.hidden = true;
    panel.innerHTML = '';
    syncButtons();
    nav.querySelector<HTMLElement>(`[data-open="${was}"]`)?.focus({ preventScroll: true });
  }

  nav.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-open]');
    if (b) open(b.dataset.open as PanelId);
  });
  panel.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('.pn-close')) return close();
    const place = placeById(el.closest<HTMLElement>('[data-place]')?.dataset.place);
    if (place) selection?.selectPlace(place);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) close();
  });

  return {
    open,
    close,
    get current() {
      return current;
    },
    attachSelection(sel) {
      selection = sel;
      nav.querySelector<HTMLElement>('[data-open="places"]')!.hidden = false;
      sel.onChange((active) => {
        if (active && current) close();
      });
    },
  };
}

function frame(body: string): string {
  return `<button class="pn-close" type="button" aria-label="Close panel">${CLOSE_SVG}</button>${body}`;
}

const rgb = (c: readonly number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

function placesHtml(sel: StationSelection | null): string {
  const items = PLACES.map((p) => {
    const tot = sel?.placeTotals(p);
    const count = tot ? `<span class="pl-count"><b>${tot.inbound.toLocaleString('en-US')}</b> rides end here</span>` : '';
    return `<li><button type="button" data-place="${p.id}">
      <span class="pl-name">${p.name}</span>${count}
      <span class="pl-blurb">${p.blurb}${tot ? ` · ${tot.docks} docks` : ''}</span></button></li>`;
  }).join('');
  return `
    <div class="pn-kicker">Places</div>
    <h2 class="pn-title">Where are they going?</h2>
    <p>Pick a place to see only the rides that end there. You can switch to the rides that start there, too.</p>
    <ul class="pl-list">${items}</ul>`;
}

function aboutHtml(m: Manifest, isFixture: boolean): string {
  return `
    <div class="pn-kicker">About</div>
    <h2 class="pn-title">Circulation</h2>
    ${isFixture ? '<p class="ab-warn">You are looking at the <b>synthetic fixture</b>, not real trips.</p>' : ''}
    <p>Every Citi Bike trip that started on ${formatDay(m.date)} — the busiest Tuesday, Wednesday or Thursday of June–August 2026 — replayed at 720×, a day in two minutes: ${m.totals.trips.toLocaleString('en-US')} trips.</p>
    <ul class="ab-key">
      <li><i style="--c:${rgb(COLORS.ebike)}"></i>e-bike trip · <i style="--c:${rgb(COLORS.classic)}"></i>classic bike; casual riders drawn dimmer than members.</li>
      <li><i class="dot" style="--c:var(--tide-sink)"></i>station filling up (more bikes arriving than leaving, per 15 min) · <i class="dot" style="--c:var(--tide-source)"></i>emptying out. Dot size = activity. Tap a station for where its riders go.</li>
    </ul>
    <h3>Estimated routes</h3>
    <p>Routes are <b>estimated</b>: Citi Bike publishes only start and end stations and times, not GPS traces. Each trail follows the OSRM bicycle shortest path between its two stations, with its real start and end times spread evenly along the path. Station positions are each station's median reported coordinates for the month. Trips under 60 s or over 3 h, round trips, and trips missing a station were dropped before encoding (about 2% of the day).</p>
    <h3>Data &amp; credits</h3>
    <ul class="ab-credits">
      <li>Trips: <a href="https://citibikenyc.com/system-data" target="_blank" rel="noopener">Citi Bike System Data</a> — Lyft / NYC Bike Share, used under the Citi Bike Data License Agreement.</li>
      <li>Routing: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a> on <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> (ODbL), Geofabrik New York extract.</li>
      <li>Basemap: <a href="https://carto.com/attributions" target="_blank" rel="noopener">© CARTO</a> Dark Matter, © OpenStreetMap contributors.</li>
      <li>Areas: <a href="https://opendata.cityofnewyork.us" target="_blank" rel="noopener">NYC Open Data</a> — 2020 Neighborhood Tabulation Areas (for the headline).</li>
      <li>Rendering: deck.gl, MapLibre GL. Pipeline: Python, DuckDB, uv.</li>
    </ul>
    <h3>Controls</h3>
    <p class="ab-keys"><kbd>Space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> ±15 min · <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> speed · drag the timeline to scrub · <kbd>Esc</kbd> close</p>`;
}
