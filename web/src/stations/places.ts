// Places: named areas of the city (a park, a transit hub, a campus), each
// resolved to the set of docks that serve it. Selecting a place highlights the
// rides that end there (or start there), the way a station click does for one
// dock.
//
// A place is either a circle (hubs: the docks within walking distance of the
// entrance) or an outline plus a buffer (parks: the docks along the edge, which
// sit across the street from the outline, not inside it).

import type { StationIndex } from './station-index';

type LngLat = [number, number];

export interface Place {
  /** URL id, e.g. `?place=central-park`. */
  id: string;
  name: string;
  /** One line for the picker. */
  blurb: string;
  shape: { center: LngLat; radiusM: number } | { ring: LngLat[]; bufferM: number };
}

export const PLACES: Place[] = [
  {
    id: 'central-park',
    name: 'Central Park',
    blurb: 'Docks around the edge of the park, 59th to 110th',
    shape: {
      ring: [
        [-73.9819, 40.7681], // Columbus Circle
        [-73.973, 40.7644], // Grand Army Plaza
        [-73.9497, 40.7968], // 5 Ave & 110 St
        [-73.9581, 40.8005], // Frederick Douglass Circle
      ],
      bufferM: 70,
    },
  },
  {
    id: 'prospect-park',
    name: 'Prospect Park',
    blurb: 'Docks around the edge of the park',
    shape: {
      ring: [
        [-73.9702, 40.6737], // Grand Army Plaza
        [-73.9806, 40.6605], // Bartel-Pritchard Square
        [-73.9727, 40.6517], // Park Circle
        [-73.962, 40.6553], // Parkside & Ocean Ave
        [-73.9614, 40.6628], // Flatbush & Ocean Ave
      ],
      bufferM: 70,
    },
  },
  {
    id: 'penn-station',
    name: 'Penn Station',
    blurb: 'Penn Station, Moynihan Hall and Madison Square Garden',
    shape: { center: [-73.9935, 40.7505], radiusM: 300 },
  },
  {
    id: 'grand-central',
    name: 'Grand Central',
    blurb: 'Docks within a few minutes’ walk of the terminal',
    shape: { center: [-73.9772, 40.7527], radiusM: 280 },
  },
  {
    id: 'times-square',
    name: 'Times Square & Bryant Park',
    blurb: 'Broadway from 42nd to 48th, and the park behind the library',
    shape: {
      ring: [
        [-73.9895, 40.76], // 8 Ave & 46 St
        [-73.985, 40.761], // Broadway & 48 St
        [-73.9815, 40.7585], // 6 Ave & 47 St
        [-73.98, 40.754], // 5 Ave & 42 St
        [-73.984, 40.7518], // 6 Ave & 40 St
        [-73.9905, 40.7555], // 8 Ave & 40 St
      ],
      bufferM: 40,
    },
  },
  {
    id: 'hudson-yards',
    name: 'Hudson Yards',
    blurb: 'The Vessel, the Javits end of the High Line',
    shape: { center: [-74.0015, 40.7538], radiusM: 320 },
  },
  {
    id: 'washington-square',
    name: 'Washington Square',
    blurb: 'The park and the NYU blocks around it',
    shape: {
      ring: [
        [-73.9998, 40.7318],
        [-73.9966, 40.7331],
        [-73.9952, 40.7304],
        [-73.9985, 40.7292],
      ],
      bufferM: 150,
    },
  },
  {
    id: 'world-trade-center',
    name: 'World Trade Center',
    blurb: 'The Oculus, the memorial and Brookfield Place',
    shape: { center: [-74.0122, 40.7118], radiusM: 320 },
  },
  {
    id: 'staten-island-ferry',
    name: 'Staten Island Ferry',
    blurb: 'Whitehall Terminal and the Battery',
    shape: { center: [-74.0132, 40.7022], radiusM: 300 },
  },
  {
    id: 'brooklyn-bridge-park',
    name: 'Brooklyn Bridge Park',
    blurb: 'DUMBO and the piers, down to Atlantic Avenue',
    shape: {
      ring: [
        [-73.986, 40.7045], // Jay St at the water
        [-73.995, 40.7045], // Brooklyn Bridge
        [-73.999, 40.699], // Pier 2
        [-74.0015, 40.6915], // Pier 6
        [-73.9995, 40.6912], // Atlantic Ave & Furman St
        [-73.997, 40.6985],
        [-73.9935, 40.7022], // Old Fulton St
        [-73.986, 40.702], // Front St & Jay St
      ],
      bufferM: 60,
    },
  },
  {
    id: 'columbia',
    name: 'Columbia University',
    blurb: 'Morningside Heights, Broadway at 116th',
    shape: { center: [-73.9626, 40.8075], radiusM: 330 },
  },
];

export function placeById(id: string | null | undefined): Place | undefined {
  return PLACES.find((p) => p.id === id);
}

/** Indices of the stations that serve a place. */
export function placeStations(place: Place, index: StationIndex): number[] {
  const out: number[] = [];
  const { positions, n } = index;
  for (let s = 0; s < n; s++) {
    if (inPlace(place, positions[2 * s], positions[2 * s + 1])) out.push(s);
  }
  return out;
}

/** Centre of a place (the circle's centre, or the ring's vertex mean). */
export function placeCenter(place: Place): LngLat {
  const sh = place.shape;
  if (!('ring' in sh)) return sh.center;
  const n = sh.ring.length;
  return [sh.ring.reduce((a, p) => a + p[0], 0) / n, sh.ring.reduce((a, p) => a + p[1], 0) / n];
}

/** Outline to draw on the map: the circle, or the ring (closed). */
export function placeOutline(place: Place): LngLat[] {
  const sh = place.shape;
  if ('ring' in sh) return [...sh.ring, sh.ring[0]];
  const [lng, lat] = sh.center;
  const k = mPerDegLng(lat);
  const pts: LngLat[] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lng + (Math.cos(a) * sh.radiusM) / k, lat + (Math.sin(a) * sh.radiusM) / M_PER_DEG_LAT]);
  }
  return pts;
}

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

function inPlace(place: Place, lng: number, lat: number): boolean {
  const sh = place.shape;
  const k = mPerDegLng(lat);
  if (!('ring' in sh)) {
    const dx = (lng - sh.center[0]) * k;
    const dy = (lat - sh.center[1]) * M_PER_DEG_LAT;
    return dx * dx + dy * dy <= sh.radiusM * sh.radiusM;
  }
  // Local metres around the point: inside the ring, or within bufferM of an edge.
  const pts = sh.ring.map(([x, y]) => [(x - lng) * k, (y - lat) * M_PER_DEG_LAT]);
  let inside = false;
  let d2 = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * -yi) / (yj - yi) + xi) inside = !inside;
    d2 = Math.min(d2, segDist2(xj, yj, xi, yi));
  }
  return inside || d2 <= sh.bufferM * sh.bufferM;
}

/** Squared distance from the origin to segment a→b. */
function segDist2(ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0;
  const x = ax + t * vx;
  const y = ay + t * vy;
  return x * x + y * y;
}
