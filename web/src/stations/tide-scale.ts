// Diverging colour scale for the tide.
//
// Sinks (net arrivals, docks filling) run warm toward rose; sources (net
// departures, docks draining) run cool toward violet. Both arms are straight
// lines in OKLCH from a dim neutral grey, so:
//   • lightness and chroma rise together with |flow| — balanced stations recede
//     into the basemap and only real imbalance glows;
//   • the two extremes have matched lightness, so neither side reads as "more";
//   • the hues sit clear of the trails: rose (h≈5°) is ~40° away from the ember
//     classic trails (h≈45°), violet (h≈295°) ~75° away from the cyan e-bikes
//     (h≈220°), and the dots are solid discs with a dark rim, not glowing lines.
// Precomputed into a 256-entry RGBA lookup table.

const STEPS = 256;

const NEUTRAL = { L: 0.44, C: 0.008, alpha: 0.42 };
const SINK = { L: 0.72, C: 0.2, h: 5, alpha: 0.88 }; // rose  ≈ #ff5f86
const SOURCE = { L: 0.7, C: 0.19, h: 293, alpha: 0.88 }; // violet ≈ #9a7bff

export const SINK_CSS = oklchCss(SINK.L, SINK.C, SINK.h);
export const SOURCE_CSS = oklchCss(SOURCE.L, SOURCE.C, SOURCE.h);
export const NEUTRAL_CSS = oklchCss(NEUTRAL.L, NEUTRAL.C, 0);

/** RGBA for v in [-1, 1] (−1 = strongest source, +1 = strongest sink), at index round((v+1)/2*255). */
export const TIDE_LUT: Uint8Array = buildLut();

export function lutIndex(v: number): number {
  const i = Math.round(((v + 1) / 2) * (STEPS - 1));
  return i < 0 ? 0 : i > STEPS - 1 ? STEPS - 1 : i;
}

function buildLut(): Uint8Array {
  const lut = new Uint8Array(STEPS * 4);
  for (let i = 0; i < STEPS; i++) {
    const v = (i / (STEPS - 1)) * 2 - 1;
    const end = v >= 0 ? SINK : SOURCE;
    const u = Math.abs(v);
    const L = NEUTRAL.L + (end.L - NEUTRAL.L) * u;
    const C = NEUTRAL.C + (end.C - NEUTRAL.C) * u;
    const [r, g, b] = oklchToSrgb(L, C, end.h);
    lut[4 * i] = r;
    lut[4 * i + 1] = g;
    lut[4 * i + 2] = b;
    lut[4 * i + 3] = Math.round(255 * (NEUTRAL.alpha + (end.alpha - NEUTRAL.alpha) * Math.pow(u, 0.6)));
  }
  return lut;
}

/** OKLCH → 8-bit sRGB (clipped to gamut by scaling chroma down). */
export function oklchToSrgb(L: number, C: number, hDeg: number): [number, number, number] {
  for (let c = C; c >= 0; c -= 0.005) {
    const rgb = oklabToLinear(L, c * Math.cos((hDeg * Math.PI) / 180), c * Math.sin((hDeg * Math.PI) / 180));
    if (rgb.every((x) => x >= -1e-4 && x <= 1 + 1e-4)) return rgb.map((x) => Math.round(255 * gamma(x))) as never;
  }
  const g = Math.round(255 * gamma(L * L * L));
  return [g, g, g];
}

function oklabToLinear(L: number, a: number, b: number): number[] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function gamma(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function oklchCss(L: number, C: number, h: number): string {
  const [r, g, b] = oklchToSrgb(L, C, h);
  return `rgb(${r}, ${g}, ${b})`;
}
