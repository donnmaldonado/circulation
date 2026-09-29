// Filter bar, top-left: which rides are lit. A picker (every trip, a named
// place, or the station last clicked on the map), the direction (rides
// leaving or arriving, with counts), and a button that shows the details
// panel. It drives the station selection and follows it, so a station click
// or the URL shows up here too.

import type { Station } from '../data/types';
import { PLACES, placeById } from '../stations/places';
import type { Dir, StationSelection } from '../stations/selection';
import type { PanelsHandle } from './panels';

const ALL = 'all';
const PANEL_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M9.75 2.75v10.5"/></svg>';

export function mountFilter(
  slot: HTMLElement,
  sel: StationSelection,
  stations: Station[],
  panels: PanelsHandle | null,
): void {
  slot.innerHTML = `
    <div class="fb-place">
      <span class="sel-badge" aria-hidden="true"></span>
      <select aria-label="Show rides for">
        <option value="${ALL}">All of New York City</option>
        <optgroup label="Places">${PLACES.map((p) => `<option value="place:${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>
      </select>
    </div>
    <div class="fb-dir" role="radiogroup" aria-label="Which rides">
      <button type="button" role="radio" data-dir="out">Leaving<b></b></button>
      <button type="button" role="radio" data-dir="in">Arriving<b></b></button>
    </div>
    <button type="button" class="fb-details" aria-controls="details" aria-expanded="false">${PANEL_SVG}Details</button>
    <span class="fb-hint">or click any station on the map</span>`;

  const select = slot.querySelector('select')!;
  const place = slot.querySelector<HTMLElement>('.fb-place')!;
  const badge = place.querySelector<HTMLElement>('.sel-badge')!;
  const dirBtns = [...slot.querySelectorAll<HTMLButtonElement>('[data-dir]')];
  const dirGroup = slot.querySelector<HTMLElement>('.fb-dir')!;
  const detailsBtn = slot.querySelector<HTMLButtonElement>('.fb-details')!;
  const hint = slot.querySelector<HTMLElement>('.fb-hint')!;
  // The clicked station gets its own group while it is selected.
  const stationGroup = document.createElement('optgroup');
  stationGroup.label = 'Station';

  select.addEventListener('change', () => {
    const v = select.value;
    if (v === ALL) sel.clear();
    else if (v.startsWith('place:')) {
      const place = placeById(v.slice(6));
      if (place) sel.selectPlace(place);
    }
    select.blur(); // hand the keyboard back to the playback shortcuts
  });
  dirBtns.forEach((b) => b.addEventListener('click', () => sel.setDir(b.dataset.dir as Dir)));
  detailsBtn.addEventListener('click', () => {
    if (panels?.current) {
      panels.close();
      sel.showDetails(true);
    } else sel.showDetails(!sel.details);
  });

  const n = (x: number) => x.toLocaleString('en-US');
  const sync = () => {
    const st = sel.station;
    if (st >= 0) {
      stationGroup.innerHTML = `<option value="station:${st}">${esc(stations[st].name)}</option>`;
      if (!stationGroup.isConnected) select.appendChild(stationGroup);
    } else stationGroup.remove();
    select.value = sel.place ? `place:${sel.place.id}` : st >= 0 ? `station:${st}` : ALL;
    // The selection's mark from the map (a dock dot, or the station ring) ties the picker to it.
    place.classList.toggle('marked', sel.active);
    badge.classList.toggle('ring', st >= 0);

    const { inbound, outbound } = sel.counts;
    for (const b of dirBtns) {
      const on = b.dataset.dir === sel.dir;
      b.classList.toggle('on', on && sel.active);
      b.setAttribute('aria-checked', String(on));
      b.querySelector('b')!.textContent = sel.active ? n(b.dataset.dir === 'out' ? outbound : inbound) : '';
    }
    // With every trip on show there is no direction to pick: a pointer to the stations instead.
    dirGroup.hidden = !sel.active;
    hint.hidden = sel.active;
    const shown = sel.active && sel.details && !panels?.current;
    detailsBtn.hidden = !sel.active;
    detailsBtn.classList.toggle('on', shown);
    detailsBtn.setAttribute('aria-expanded', String(shown));
  };
  sel.onChange(sync);
  panels?.onChange(sync);
  sync();
  slot.closest('.bar')?.classList.add('ready');
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
