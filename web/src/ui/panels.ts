// The About panel and its entry button (in the HUD's controls row, thumb
// reach on phones).
//
// About shares the top-right slot (a bottom sheet just above the HUD on
// phones) with the selection's details panel: while About is open the details
// are hidden (html.about-open) but the filter stays as it is.

import { COLORS } from '../config';
import type { Manifest } from '../data/types';
import { formatDay } from './day';

export type PanelId = 'about';

export interface PanelsHandle {
  open(id: PanelId): void;
  close(): void;
  readonly current: PanelId | null;
  /** Called after a panel opens or closes. */
  onChange(fn: () => void): void;
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
    <button type="button" class="nav-btn" data-open="about" aria-expanded="false" aria-controls="panel">About</button>`;
  o.navSlot.appendChild(nav);

  const panel = document.createElement('aside');
  panel.id = 'panel';
  panel.className = 'side-panel';
  panel.hidden = true;
  panel.setAttribute('aria-live', 'polite');
  o.root.appendChild(panel);

  let current: PanelId | null = null;
  const listeners: (() => void)[] = [];

  const sync = () => {
    nav.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => {
      const on = b.dataset.open === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', String(on));
    });
    document.documentElement.classList.toggle('about-open', current === 'about');
    listeners.forEach((fn) => fn());
  };

  function open(id: PanelId) {
    if (current === id) return close();
    current = id;
    panel.className = `side-panel panel-${id}`;
    panel.hidden = false;
    panel.scrollTop = 0;
    panel.innerHTML = frame(aboutHtml(o.manifest, o.isFixture));
    sync();
    panel.querySelector<HTMLElement>('.pn-close')?.focus({ preventScroll: true });
  }

  function close() {
    if (!current) return;
    const was = current;
    current = null;
    panel.hidden = true;
    panel.innerHTML = '';
    sync();
    nav.querySelector<HTMLElement>(`[data-open="${was}"]`)?.focus({ preventScroll: true });
  }

  nav.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-open]');
    if (b) open(b.dataset.open as PanelId);
  });
  panel.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.pn-close')) close();
  });
  // Capture, so Esc closes About first and doesn't also hide the details behind it.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !current) return;
      e.stopImmediatePropagation();
      close();
    },
    { capture: true },
  );

  return {
    open,
    close,
    get current() {
      return current;
    },
    onChange: (fn) => void listeners.push(fn),
  };
}

function frame(body: string): string {
  return `<button class="pn-close" type="button" aria-label="Close panel">${CLOSE_SVG}</button>${body}`;
}

const rgb = (c: readonly number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

function aboutHtml(m: Manifest, isFixture: boolean): string {
  return `
    <div class="pn-kicker">About</div>
    <h2 class="pn-title">Circulation: Citi Bike trips</h2>
    ${isFixture ? '<p class="ab-warn">You are looking at the <b>synthetic fixture</b>, not real trips.</p>' : ''}
    <p>Every Citi Bike trip that started on ${formatDay(m.date)} (${m.totals.trips.toLocaleString('en-US')} trips), the busiest Tuesday, Wednesday or Thursday of June–August 2026. At the default 720× a day plays in two minutes.</p>
    <p>Use the bar at the top left to pick a place, or click any station dot, and choose rides <b>leaving</b> or <b>arriving</b>. The page opens on the rides leaving Central Park. Pick <b>All of New York City</b> to see every trip. The address bar keeps your choice, so you can share it.</p>
    <ul class="ab-key">
      <li><i style="--c:${rgb(COLORS.ebike)}"></i>e-bike trip · <i style="--c:${rgb(COLORS.classic)}"></i>classic bike; casual riders drawn dimmer than members.</li>
      <li><i class="dot" style="--c:var(--tide-sink)"></i>station filling up (more bikes arriving than leaving, per 15 min) · <i class="dot" style="--c:var(--tide-source)"></i>emptying out. Dot size = activity.</li>
    </ul>
    <h3>Estimated routes</h3>
    <p>Routes are <b>estimated</b>: Citi Bike publishes only start and end stations and times, not GPS traces. Each trail follows the OSRM bicycle shortest path between its two stations, with its real start and end times spread evenly along the path. Station positions are each station's median reported coordinates for the month. Trips under 60 s or over 3 h, round trips, and trips missing a station were dropped before encoding (about 2% of the day).</p>
    <h3>Data &amp; credits</h3>
    <ul class="ab-credits">
      <li>Trips: <a href="https://citibikenyc.com/system-data" target="_blank" rel="noopener">Citi Bike System Data</a> — Lyft / NYC Bike Share, used under the Citi Bike Data License Agreement.</li>
      <li>Routing: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a> on <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> (ODbL), Geofabrik New York extract.</li>
      <li>Basemap: <a href="https://carto.com/attributions" target="_blank" rel="noopener">© CARTO</a> Dark Matter, © OpenStreetMap contributors.</li>
      <li>Rendering: deck.gl, MapLibre GL. Pipeline: Python, DuckDB, uv.</li>
    </ul>
    <h3>Controls</h3>
    <p class="ab-keys"><kbd>Space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> ±15 min · <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> speed · drag the timeline to scrub · click a bar in the details to jump to that hour · <kbd>Esc</kbd> close a panel</p>`;
}
