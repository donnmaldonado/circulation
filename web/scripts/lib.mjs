// Shared helpers for the Playwright scripts: start a Vite server (dev or
// preview) and launch Chromium with the GPU enabled where possible.

import { chromium } from 'playwright';
import { createServer, preview } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function arg(name, fallback) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

/** Start Vite unless --url is given. mode: 'dev' | 'preview'. Returns { url, close }. */
export async function startServer(mode = 'dev') {
  const given = arg('url');
  if (given) return { url: given.replace(/\/?$/, '/'), close: async () => {} };
  if (mode === 'preview') {
    const server = await preview({ root: WEB, preview: { port: 0, strictPort: false }, logLevel: 'warn' });
    const url = server.resolvedUrls.local[0];
    return { url, close: () => server.httpServer.close() };
  }
  const server = await createServer({ root: WEB, server: { port: 0 }, logLevel: 'warn' });
  await server.listen();
  return { url: server.resolvedUrls.local[0], close: () => server.close() };
}

/**
 * Chromium with hardware GL. `headed` uses a real window (most honest fps);
 * otherwise the full Chromium build in new-headless mode, which can still use
 * the GPU via ANGLE/Metal (the default headless shell falls back to SwiftShader).
 */
export async function launch({ headed = false } = {}) {
  return chromium.launch({
    headless: !headed,
    channel: headed ? undefined : 'chromium',
    args: [
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
    ],
  });
}

/** WebGL renderer string, to report which GL path the fps came from. */
export async function glRenderer(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no webgl2';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
}
