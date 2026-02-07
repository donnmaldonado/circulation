import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

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

/** Keep scratch/test-only files out of the static build. */
function pruneDist(): Plugin {
  return {
    name: 'prune-dist',
    apply: 'build',
    closeBundle() {
      for (const p of ['fixture-dense', 'poster-lqip.txt']) {
        rmSync(resolve(import.meta.dirname, 'dist', p), { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [posterLqip(), pruneDist()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  server: { port: 5173 },
  preview: { port: 4173 },
});
