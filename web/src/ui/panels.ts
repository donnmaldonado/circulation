// Chapter + About panels and their entry buttons.
//
// One panel slot: the station panel (stations/selection.ts), the chapter and
// the about panel all occupy the same place — top-right on desktop, a bottom
// sheet just above the HUD on phones — and only one is ever open. Opening a
// panel clears the station selection; selecting a station closes the panel.
// Entry buttons live in the HUD's controls row (thumb reach on phones).

import { COLORS } from '../config';
import type { Manifest } from '../data/types';
import type { Scene } from '../map/scene';
import type { StationSelection } from '../stations/selection';
import { chapterHtml, loadChapter, loadZone, wireChart, zoneLayers, type Chapter } from './chapter';

export type PanelId = 'chapter' | 'about';

export interface PanelsHandle {
  open(id: PanelId): void;
  close(): void;
  readonly current: PanelId | null;
  /** Hook the station selection in once the tide layer is mounted. */
  attachSelection(sel: StationSelection): void;
}

const CLOSE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const ZONE_FADE_MS = 400;

export function mountPanels(o: {
  root: HTMLElement;
  navSlot: HTMLElement;
  base: string;
  scene: Scene;
  manifest: Manifest;
  isFixture: boolean;
}): PanelsHandle {
  const nav = document.createElement('div');
  nav.className = 'nav';
  nav.innerHTML = `
    <button type="button" class="nav-btn" data-open="chapter" aria-expanded="false" aria-controls="panel">
      <span class="nav-long">Did congestion pricing change this?</span><span class="nav-short">Pricing</span>
    </button>
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
  let chapter: Chapter | null | undefined;
  let chapterReq: Promise<Chapter | null> | null = null;
  let zone: number[][][] | null = null;
  let zoneShown = false;
  let zoneT0 = 0;

  const getChapter = () => (chapterReq ??= loadChapter(o.base).then((c) => (chapter = c)));
  // Warm the chapter after first paint so opening it is instant; tiny (4 KB).
  setTimeout(() => void getChapter(), 2500);

  o.scene.addProvider(
    'zone',
    () => {
      if (!zone) return [];
      const k = Math.min(1, (performance.now() - zoneT0) / ZONE_FADE_MS);
      const alpha = zoneShown ? k : 1 - k;
      if (k < 1) o.scene.requestRender();
      return zoneLayers(zone, alpha);
    },
    -20, // under the trails: the tint lands on the basemap, not on the light
  );
  const showZone = (on: boolean) => {
    if (on === zoneShown) return;
    zoneShown = on;
    zoneT0 = performance.now();
    if (on && !zone)
      void loadZone(o.base).then((z) => {
        zone = z;
        zoneT0 = performance.now();
        o.scene.requestRender();
      });
    o.scene.requestRender();
  };

  const syncButtons = () => {
    nav.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => {
      const on = b.dataset.open === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', String(on));
    });
  };

  async function open(id: PanelId) {
    if (current === id) return close();
    selection?.clear();
    current = id;
    syncButtons();
    panel.className = `side-panel panel-${id}`;
    panel.hidden = false;
    panel.scrollTop = 0;
    if (id === 'about') {
      panel.innerHTML = frame(aboutHtml(o.manifest, o.isFixture));
      showZone(false);
    } else {
      showZone(true);
      if (chapter === undefined) {
        panel.innerHTML = frame('<div class="pn-kicker">Chapter</div><p class="pn-loading">Loading…</p>');
        await getChapter();
        if (current !== 'chapter') return;
      }
      panel.innerHTML = frame(
        chapter ? chapterHtml(chapter) : '<p>The chapter data (<code>chapter.json</code>) is not available.</p>',
      );
      if (chapter) wireChart(panel, chapter);
    }
    panel.querySelector<HTMLElement>('.pn-close')?.focus({ preventScroll: true });
  }

  function close() {
    if (!current) return;
    const was = current;
    current = null;
    panel.hidden = true;
    panel.innerHTML = '';
    showZone(false);
    syncButtons();
    nav.querySelector<HTMLElement>(`[data-open="${was}"]`)?.focus({ preventScroll: true });
  }

  nav.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-open]');
    if (b) void open(b.dataset.open as PanelId);
  });
  panel.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.pn-close')) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) close();
  });

  return {
    open: (id) => void open(id),
    close,
    get current() {
      return current;
    },
    attachSelection(sel) {
      selection = sel;
      sel.onChange((s) => {
        if (s >= 0 && current) close();
      });
    },
  };
}

function frame(body: string): string {
  return `<button class="pn-close" type="button" aria-label="Close panel">${CLOSE_SVG}</button>${body}`;
}

const rgb = (c: readonly number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

function aboutHtml(m: Manifest, isFixture: boolean): string {
  const d = new Date(`${m.date}T12:00:00`);
  const day = Number.isNaN(d.getTime())
    ? m.date
    : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return `
    <div class="pn-kicker">About</div>
    <h2 class="pn-title">Circulation</h2>
    ${isFixture ? '<p class="ab-warn">You are looking at the <b>synthetic fixture</b>, not real trips.</p>' : ''}
    <p>Every Citi Bike trip that started on ${day} — the busiest Tuesday, Wednesday or Thursday of June–September 2025 — replayed at 720×, a day in two minutes: ${m.totals.trips.toLocaleString('en-US')} trips.</p>
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
      <li>Areas: <a href="https://opendata.cityofnewyork.us" target="_blank" rel="noopener">NYC Open Data</a> — 2020 Neighborhood Tabulation Areas and borough boundaries.</li>
      <li>Chapter weather: <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> historical archive (ERA5).</li>
      <li>Rendering: deck.gl, MapLibre GL. Pipeline: Python, DuckDB, uv.</li>
    </ul>
    <h3>Controls</h3>
    <p class="ab-keys"><kbd>Space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> ±15 min · <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> speed · drag the timeline to scrub · <kbd>Esc</kbd> close</p>`;
}
