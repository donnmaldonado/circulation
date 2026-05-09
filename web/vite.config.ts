import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { START_TIME } from './src/config.ts';

/**
 * Inline the poster's tiny blurred placeholder (written by scripts/poster.mjs)
 * into index.html so the very first paint has an image even before
 * poster.webp arrives.
 */
function posterLqip(): Plugin {
  const file = resolve(import.meta.dirname, 'public/poster-lqip.txt');
  return {
    name: 'poster-lqip',
    transformIndexHtml(html) {
      const uri = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
      return html.replace('%POSTER_LQIP%', uri ? `url(${uri})` : 'none');
    },
  };
}

/**
 * Put the intro's text (date, trip count, headline, evening flip) straight into
 * index.html from data/manifest.json — so the one-sentence insight is on the
 * very first paint, with the poster, before any JS — and preload the manifest
 * and the hour chunks the opening frame needs. intro.ts re-fills the same
 * nodes from whatever manifest actually loads (e.g. ?data=fixture).
 */
function introFromManifest(): Plugin {
  const pub = resolve(import.meta.dirname, 'public');
  const dir = existsSync(resolve(pub, 'data/manifest.json')) ? 'data' : 'fixture';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    name: 'intro-from-manifest',
    transformIndexHtml(html) {
      const file = resolve(pub, dir, 'manifest.json');
      const m = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
      const date = m ? new Date(`${m.date}T12:00:00`) : null;
      const dateLabel = date
        ? date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        : '';
      const hm = m ? /, (.+?) (absorbs|sends out) /.exec(m.headline) : null;
      const opposite = hm?.[2] === 'absorbs' ? 'sends out' : 'absorbs';
      const flip: string | undefined = hm
        ? (m.runner_ups ?? []).find((r: string) => r.includes(`, ${hm[1]} ${opposite} `))
        : undefined;
      const h = Math.floor(START_TIME / 3600);
      const hours = [h, (h + 23) % 24];
      const preloads = m
        ? [
            `<link rel="preload" as="fetch" href="./${dir}/manifest.json" crossorigin />`,
            ...hours.map((x) => `<link rel="preload" as="fetch" href="./${dir}/${m.chunks[x]}" crossorigin />`),
          ].join('\n    ')
        : '';
      return html
        .replace('%DATA_PRELOADS%', preloads)
        .replace('%INTRO_DATE%', esc(dateLabel))
        .replace('%INTRO_TRIPS%', m ? Number(m.totals.trips).toLocaleString('en-US') : '')
        .replace('%INTRO_HEADLINE%', esc(m?.headline ?? ''))
        .replace('%INTRO_SUB%', flip ? esc(`Then the tide turns. ${flip}`) : '');
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
  plugins: [posterLqip(), introFromManifest(), pruneDist()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  server: { port: 5173 },
  preview: { port: 4173 },
});
