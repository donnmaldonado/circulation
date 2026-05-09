// The congestion-pricing chapter: headline, three numbers, one chart, method
// and caveats — all from data/chapter.json (pipeline/f_chapter.py). While it is
// open the zone outline (data/zone.geojson, pipeline/g_web_zone.py) is drawn
// on the map.
//
// The chart is hand-rolled SVG: weekly change in weekday trips, 2025 vs the
// same weeks of 2024, for trips ending inside vs outside the zone. One axis,
// two series, a legend, and a tooltip per week (hover or tap). Values beyond
// the y-range are clipped to the edge with an arrow and printed, not hidden.

import type { Layer } from '@deck.gl/core';
import { PathLayer, SolidPolygonLayer } from '@deck.gl/layers';

export interface ChapterWeek {
  week_after: string;
  week_before: string;
  days: number;
  zone_after: number;
  zone_before: number;
  outside_after: number;
  outside_before: number;
}

export interface Chapter {
  title: string;
  headline: string;
  method: string;
  zone_name: string;
  windows: { after: [string, string]; before: [string, string] };
  weekdays: { after: number; before: number };
  zone: { before_per_day: number; after_per_day: number; pct_change: number };
  outside: { before_per_day: number; after_per_day: number; pct_change: number };
  did_pct_points: number;
  did_ratio: number;
  did_ratio_ci95: [number, number];
  entering_zone?: { before_per_day: number; after_per_day: number; pct_change: number };
  same_stations?: { stations: number; zone_pct_change: number; outside_pct_change: number; did_pct_points: number };
  context?: {
    ebike_share?: { before: number; after: number };
    weather?: {
      source: string;
      before: { mean_temp_f: number; wet_days: number; snow_days: number };
      after: { mean_temp_f: number; wet_days: number; snow_days: number };
    } | null;
  };
  series_note?: string;
  series: ChapterWeek[];
  caveats: string[];
  source: string;
}

/** Series colours (validated as a categorical pair on the dark panel surface). */
export const ZONE_RGB: [number, number, number] = [201, 133, 0]; // #c98500
const ZONE_CSS = '#c98500';
const OUTSIDE_CSS = '#3987e5';

const Y_MIN = -20;
const Y_MAX = 40;

const fmt = (n: number) => n.toLocaleString('en-US');
const signed = (n: number, digits = 1) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}`;
const pct = (after: number, before: number) => (after / before - 1) * 100;
const shortDate = (iso: string, year = false) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' } : {}),
  });

export async function loadChapter(base: string): Promise<Chapter | null> {
  try {
    const res = await fetch(`${base}chapter.json`);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return (await res.json()) as Chapter;
  } catch {
    return null;
  }
}

/** Panel body HTML (the panel frame and close button belong to panels.ts). */
export function chapterHtml(c: Chapter): string {
  const ci = c.did_ratio_ci95;
  const wx = c.context?.weather;
  const e = c.context?.ebike_share;
  const more: string[] = [];
  if (c.same_stations)
    more.push(
      `Only stations open in both years (${fmt(c.same_stations.stations)}): zone ${signed(c.same_stations.zone_pct_change)}%, elsewhere ${signed(c.same_stations.outside_pct_change)}%, <b>${signed(c.same_stations.did_pct_points)} pts</b>.`,
    );
  if (c.entering_zone)
    more.push(
      `Trips that start outside and end inside the zone: ${fmt(c.entering_zone.before_per_day)} → ${fmt(c.entering_zone.after_per_day)} a weekday (${signed(c.entering_zone.pct_change)}%).`,
    );
  if (wx)
    more.push(
      `Weather (${esc(wx.source)}): ${wx.before.mean_temp_f}°F → ${wx.after.mean_temp_f}°F mean; wet days ${wx.before.wet_days} → ${wx.after.wet_days}; snow days ${wx.before.snow_days} → ${wx.after.snow_days}.`,
    );
  if (e) more.push(`E-bike share of trips: ${e.before}% → ${e.after}%.`);

  return `
    <div class="pn-kicker">Chapter · congestion pricing</div>
    <h2 class="pn-title">${esc(c.title)}</h2>
    <p class="ch-lede">${esc(c.headline)}</p>
    <div class="ch-stats">
      <div class="ch-stat" style="--c:${ZONE_CSS}">
        <span class="ch-k">Ending in the zone</span>
        <b>${signed(c.zone.pct_change)}%</b>
        <span class="ch-s">${fmt(c.zone.before_per_day)} → ${fmt(c.zone.after_per_day)}</span>
      </div>
      <div class="ch-stat" style="--c:${OUTSIDE_CSS}">
        <span class="ch-k">Ending elsewhere</span>
        <b>${signed(c.outside.pct_change)}%</b>
        <span class="ch-s">${fmt(c.outside.before_per_day)} → ${fmt(c.outside.after_per_day)}</span>
      </div>
      <div class="ch-stat ch-did">
        <span class="ch-k">Difference</span>
        <b>${signed(c.did_pct_points)} pts</b>
        <span class="ch-s" title="Growth ratio, zone vs elsewhere, with its 95% range from day pairs">ratio ${c.did_ratio.toFixed(3)}<br />95% ${ci[0].toFixed(3)}–${ci[1].toFixed(3)}</span>
      </div>
    </div>
    <figure class="ch-fig">
      <figcaption>
        <span class="ch-fig-t">Weekly change in trips per weekday, 2025 vs 2024</span>
        <span class="ch-legend">
          <span><i style="--c:${ZONE_CSS}"></i>ending in zone</span>
          <span><i style="--c:${OUTSIDE_CSS}" class="dash"></i>ending elsewhere</span>
        </span>
      </figcaption>
      <div class="ch-chart" role="img" aria-label="${esc(chartAlt(c))}">${chartSvg(c)}<div class="ch-tip" hidden></div></div>
      <p class="ch-note">The two lines move together week by week: whatever lifted riding in 2025 lifted it inside and outside the zone alike.${outlierNote(c)}</p>
    </figure>
    <p class="ch-method"><b>Method.</b> ${esc(c.method)}</p>
    <details class="ch-more">
      <summary>Caveats &amp; checks</summary>
      <ul>${c.caveats.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${more.length ? `<ul class="ch-extra">${more.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
      <p class="ch-src">Zone: ${esc(c.zone_name)}. ${c.weekdays.after} weekday pairs, ${shortDate(c.windows.after[0])}–${shortDate(c.windows.after[1], true)} vs ${shortDate(c.windows.before[0])}–${shortDate(c.windows.before[1], true)}. Numbers from <code>${esc(c.source)}</code>.</p>
    </details>`;
}

function outlierNote(c: Chapter): string {
  const out = c.series.filter((w) => {
    const a = pct(w.zone_after, w.zone_before);
    const b = pct(w.outside_after, w.outside_before);
    return a > Y_MAX || b > Y_MAX || a < Y_MIN || b < Y_MIN;
  });
  if (!out.length) return '';
  return ` ${out
    .map((w) => {
      const why =
        w.week_before === '2024-01-15'
          ? 'its 2024 twin had snow and daily means in the 20s°F (Open-Meteo)'
          : 'of an unusual week in one of the two years';
      return `The week of ${shortDate(w.week_after)} runs off the scale (${signed(pct(w.zone_after, w.zone_before), 0)}% / ${signed(pct(w.outside_after, w.outside_before), 0)}%) because ${why}.`;
    })
    .join(' ')}`;
}

function chartAlt(c: Chapter): string {
  return `Line chart of ${c.series.length} weeks. Trips ending in the zone changed ${signed(c.zone.pct_change)}% overall, trips ending elsewhere ${signed(c.outside.pct_change)}%; the weekly lines track each other closely.`;
}

// ------------------------------------------------------------------ chart

const W = 340;
const H = 168;
const PAD = { l: 34, r: 10, t: 12, b: 22 };

function chartSvg(c: Chapter): string {
  const n = c.series.length;
  const x = (i: number) => PAD.l + (i / Math.max(1, n - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + ((Y_MAX - v) / (Y_MAX - Y_MIN)) * (H - PAD.t - PAD.b);
  const clampY = (v: number) => y(Math.min(Y_MAX, Math.max(Y_MIN, v)));

  const grid = [-20, 0, 20, 40]
    .map(
      (v) =>
        `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'zero' : 'grid'}"/>` +
        `<text x="${PAD.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${v > 0 ? '+' : ''}${v}%</text>`,
    )
    .join('');

  // Month labels at each month's first week.
  let lastMonth = '';
  const months = c.series
    .map((w, i) => {
      const m = shortDate(w.week_after).split(' ')[0];
      if (m === lastMonth) return '';
      lastMonth = m;
      return `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : 'middle'}">${m}</text>`;
    })
    .join('');

  const series = [
    { cls: 'zone', color: ZONE_CSS, vals: c.series.map((w) => pct(w.zone_after, w.zone_before)) },
    { cls: 'outside', color: OUTSIDE_CSS, vals: c.series.map((w) => pct(w.outside_after, w.outside_before)) },
  ];
  // Draw 'outside' first so the zone line reads on top.
  const lines = [...series]
    .reverse()
    .map((s) => {
      const d = s.vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${clampY(v).toFixed(1)}`).join('');
      const dots = s.vals
        .map((v, i) => {
          const off = v > Y_MAX || v < Y_MIN;
          const cx = x(i).toFixed(1);
          const cy = clampY(v).toFixed(1);
          return off
            ? `<path d="M${cx},${cy} m-4.5,${v > 0 ? 5 : -5} l4.5,${v > 0 ? -7 : 7} l4.5,${v > 0 ? 7 : -7}z" fill="${s.color}" class="mk"/>`
            : `<circle cx="${cx}" cy="${cy}" r="3" fill="${s.color}" class="mk"/>`;
        })
        .join('');
      return `<path d="${d}" class="ln ${s.cls}" stroke="${s.color}"/>${dots}`;
    })
    .join('');

  // Invisible per-week hit columns + a crosshair that the tooltip script moves.
  const colW = (W - PAD.l - PAD.r) / Math.max(1, n - 1);
  const hits = c.series
    .map(
      (_, i) =>
        `<rect class="hit" data-i="${i}" x="${(x(i) - colW / 2).toFixed(1)}" y="0" width="${colW.toFixed(1)}" height="${H - PAD.b}"/>`,
    )
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <g class="axis">${grid}${months}</g>
    <line class="xhair" x1="0" x2="0" y1="${PAD.t - 4}" y2="${H - PAD.b}" visibility="hidden"/>
    ${lines}
    <g>${hits}</g>
  </svg>`;
}

/** Wire the per-week tooltip (hover on desktop, tap on touch). */
export function wireChart(root: HTMLElement, c: Chapter): void {
  const box = root.querySelector<HTMLElement>('.ch-chart');
  const svg = box?.querySelector('svg');
  const tip = box?.querySelector<HTMLElement>('.ch-tip');
  const xhair = svg?.querySelector<SVGLineElement>('.xhair');
  if (!box || !svg || !tip || !xhair) return;
  const n = c.series.length;
  const xOf = (i: number) => PAD.l + (i / Math.max(1, n - 1)) * (W - PAD.l - PAD.r);

  const show = (i: number) => {
    const w = c.series[i];
    const z = pct(w.zone_after, w.zone_before);
    const o = pct(w.outside_after, w.outside_before);
    tip.innerHTML = `<b>Week of ${shortDate(w.week_after)}</b> <em>vs ${shortDate(w.week_before, true)} · ${w.days} days</em>
      <span><i style="--c:${ZONE_CSS}"></i>zone ${signed(z)}% <em>${fmt(w.zone_before)} → ${fmt(w.zone_after)}</em></span>
      <span><i style="--c:${OUTSIDE_CSS}"></i>elsewhere ${signed(o)}% <em>${fmt(w.outside_before)} → ${fmt(w.outside_after)}</em></span>`;
    tip.hidden = false;
    xhair.setAttribute('x1', String(xOf(i)));
    xhair.setAttribute('x2', String(xOf(i)));
    xhair.setAttribute('visibility', 'visible');
    // Position in CSS px: the SVG scales to the box width.
    const scale = box.clientWidth / W;
    const px = xOf(i) * scale;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(px - half, 0), box.clientWidth - tip.offsetWidth)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    xhair.setAttribute('visibility', 'hidden');
  };
  svg.addEventListener('pointerover', (e) => {
    const r = (e.target as Element).closest('.hit');
    if (r) show(Number(r.getAttribute('data-i')));
  });
  svg.addEventListener('pointerleave', hide);
}

// ------------------------------------------------------------------ map outline

export async function loadZone(base: string): Promise<number[][][] | null> {
  try {
    const res = await fetch(`${base}zone.geojson`);
    if (!res.ok || !(res.headers.get('content-type') ?? '').match(/json|geo/)) return null;
    const f = (await res.json()) as { geometry: { type: string; coordinates: number[][][] | number[][][][] } };
    const g = f.geometry;
    return g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]).flat() : (g.coordinates as number[][][]);
  } catch {
    return null;
  }
}

/** Faint fill + outline of the zone; `alpha` 0..1 for the fade. */
export function zoneLayers(rings: number[][][], alpha: number): Layer[] {
  if (alpha <= 0) return [];
  return [
    new SolidPolygonLayer({
      id: 'zone-fill',
      data: [{ polygon: rings }],
      getPolygon: (d: { polygon: number[][][] }) => d.polygon as never,
      getFillColor: [...ZONE_RGB, 22],
      opacity: alpha,
      parameters: { depthWriteEnabled: false, depthCompare: 'always' },
    }),
    new PathLayer({
      id: 'zone-line',
      data: rings,
      getPath: (r: number[][]) => r as never,
      getColor: [...ZONE_RGB, 230],
      widthUnits: 'pixels',
      getWidth: 1.5,
      opacity: alpha,
      parameters: { depthWriteEnabled: false, depthCompare: 'always' },
    }),
  ];
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}
