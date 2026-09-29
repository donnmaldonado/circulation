import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { START_TIME } from './src/config.ts';
import { agoPrefix, formatDay, tripsLabel } from './src/ui/day.ts';

/**
 * Inline the poster's tiny blurred placeholder (written by scripts/poster.mjs)
 * into index.html so the very first paint has an image even before
 * poster.webp arrives. Without poster.webp (the nightly build drops a poster
 * it could not regenerate rather than show another day's) the preload and the
 * image go too, and the poster is just the dark page until the reveal.
 */
function posterLqip(): Plugin {
  const file = resolve(import.meta.dirname, 'public/poster-lqip.txt');
  const webp = resolve(import.meta.dirname, 'public/poster.webp');
  return {
    name: 'poster-lqip',
    transformIndexHtml(html) {
      const has = existsSync(webp);
      const uri = has && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
      return html
        .replace('%POSTER_LQIP%', uri ? `url(${uri})` : 'none')
        .replace('%POSTER_FULL%', has ? 'url(./poster.webp)' : 'none')
        .replace(
          '%POSTER_PRELOAD%',
          has ? '<link rel="preload" as="image" href="./poster.webp" type="image/webp" fetchpriority="high" />' : '',
        );
    },
  };
}

/** The night's data version (manifest.generated_at); src/data/loader.ts adds it to every data URL. */
function dataVersion(): string {
  const file = resolve(import.meta.dirname, 'public/data/manifest.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).generated_at ?? '') : '';
}
const versioned = (url: string, v: string | undefined) => (v ? `${url}?v=${encodeURIComponent(v)}` : url);

/**
 * Put the day on show straight into index.html from data/manifest.json, so it
 * is on the very first paint with the poster, and preload what the opening
 * frame needs: the manifest, the hour chunks on screen at START_TIME, and
 * stations.json (the default filter is drawn from it). main.ts re-fills the
 * date from whatever manifest actually loads (e.g. ?data=fixture), and drops
 * "One year ago today" if the page is being read on a later day.
 */
function inlineFromManifest(): Plugin {
  const pub = resolve(import.meta.dirname, 'public');
  const dir = existsSync(resolve(pub, 'data/manifest.json')) ? 'data' : 'fixture';
  return {
    name: 'inline-from-manifest',
    transformIndexHtml(html) {
      const file = resolve(pub, dir, 'manifest.json');
      const m = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
      const h = Math.floor(START_TIME / 3600);
      const hours = [h, (h + 23) % 24];
      const preloads = m
        ? [
            `<link rel="preload" as="fetch" href="${versioned(`./${dir}/manifest.json`, dir === 'data' ? dataVersion() : '')}" crossorigin />`,
            ...hours.map((x) => `<link rel="preload" as="fetch" href="${versioned(`./${dir}/${m.chunks[x]}`, m.generated_at)}" crossorigin />`),
            `<link rel="preload" as="fetch" href="${versioned(`./${dir}/stations.json`, m.generated_at)}" crossorigin />`,
          ].join('\n    ')
        : '';
      return html
        .replace('%DATA_PRELOADS%', preloads)
        .replace('%BRAND_AGO%', m ? agoPrefix(m.date) : '')
        .replace('%BRAND_DATE%', m ? formatDay(m.date) : '')
        .replace('%BRAND_TRIPS%', m ? tripsLabel(m.totals.trips) : '');
    },
  };
}

/** Keep scratch/test-only files out of the static build. */
function pruneDist(): Plugin {
  return {
    name: 'prune-dist',
    apply: 'build',
    closeBundle() {
      // fixture/ is the synthetic dev dataset: the app only falls back to it
      // when data/manifest.json is missing, so it has no business in dist.
      const dropFixture = existsSync(resolve(import.meta.dirname, 'public/data/manifest.json'));
      for (const p of ['fixture-dense', 'poster-lqip.txt', ...(dropFixture ? ['fixture'] : [])]) {
        rmSync(resolve(import.meta.dirname, 'dist', p), { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig({
  base: './',
  define: { __DATA_VERSION__: JSON.stringify(dataVersion()) },
  plugins: [posterLqip(), inlineFromManifest(), pruneDist()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  server: { port: 5173 },
  preview: { port: 4173 },
});
