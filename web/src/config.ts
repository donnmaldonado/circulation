// Central knobs for the look and the opening moment. Everything visual that a
// later workstream might tune lives here.

export const DAY_SECONDS = 86_400;

/** Opening time: 07:30, with the morning rush already building. */
export const START_TIME = 7.5 * 3600;

/** Sim seconds per real second. 720x plays 24h in 2 minutes. */
export const SPEEDS = [180, 720, 2880] as const;
export const DEFAULT_SPEED = 720;

/** Trail length in sim seconds (locked: ~90 s). */
export const TRAIL_LENGTH = 90;

/** Colours (RGB). Chosen to glow on near-black and mix to white under additive blending. */
export const COLORS = {
  ebike: [64, 216, 255] as [number, number, number], // electric cyan  #40D8FF
  classic: [255, 122, 69] as [number, number, number], // warm ember   #FF7A45
};
/** Alpha by rider type: members full, casual riders dimmer. */
export const ALPHA = { member: 255, casual: 110 };

/** Trail width in CSS pixels. */
export const TRAIL_WIDTH_PX = 1.6;

/**
 * Peak dimming. Under additive blending the busy avenues saturate to white at
 * rush hour, so trail opacity eases down as the city gets busier: 1 while the
 * number of trips starting (±10 min) is below `knee` × the day's peak, then
 * (knee / r)^gamma, never below `floor`. Quiet hours keep full brightness.
 */
export const PEAK_DIM = { knee: 0.4, gamma: 0.7, floor: 0.5 };

/**
 * Glow: a wide, faint pass drawn under the trails (same data, same culling), so
 * corridors and bridges bloom a little. Scaled by PEAK_DIM squared, so it is
 * strongest in the quiet hours and nearly gone at rush hour, where overlapping
 * halos would wash Midtown out. Off when trails are thinned (phones).
 */
export const HALO = { widthPx: 4.5, opacity: 0.07 };

/** Phones and coarse pointers draw half the trails (decode.ts). `?density=full|half` overrides. */
export const THIN_MEDIA = '(max-width: 640px), (pointer: coarse)';

/**
 * Camera. The poster is captured at POSTER_SIZE with this view; at runtime the
 * zoom is offset by log2(cover scale) so the live map lines up exactly with the
 * `background-size: cover` poster during the cross-fade. Centred on Central
 * Park (the default filter) with Midtown and both sides of the park in frame.
 */
export const VIEW = {
  longitude: -73.972,
  latitude: 40.772,
  zoom: 12.5,
  pitch: 0,
  bearing: 0,
};
export const POSTER_SIZE = { width: 1600, height: 1000 };

/**
 * What the page opens on: the rides leaving Central Park. `?place=<id>`,
 * `?station=<id>` and `?dir=in|out` override it; `?place=all` shows every trip
 * unfiltered.
 */
export const DEFAULT_FILTER = { place: 'central-park', dir: 'out' } as const;

export const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/** Near-black page background (also inlined in index.html). */
export const BG = '#050608';

/**
 * Latest moment (ms after navigation) to start playing if the basemap is still
 * loading tiles. The poster covers until then and cross-fades over whatever has
 * arrived. The opening trips themselves are always waited for.
 */
export const REVEAL_DEADLINE_MS = 1500;

/** Max concurrent chunk fetches. */
export const FETCH_CONCURRENCY = 3;
