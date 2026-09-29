// Regenerate public/poster.webp (+ the inlined blur placeholder) from the live
// app at the opening moment, UI hidden.
//
//   npm run poster                       # auto: data/ if present, else fixture/
//   npm run poster -- --data=fixture     # force a data dir
//   npm run poster -- --url=http://localhost:5173/
//   CIRC_GL=swiftshader npm run poster   # software WebGL, as on the headless Linux CI runner
//
// Exits non-zero (and writes nothing) if the frame never gets ready; the
// nightly build then ships without a poster rather than with another day's.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GL, WEB, arg, launch, startServer, glRenderer } from './lib.mjs';

const WIDTH = 1600; // keep in sync with POSTER_SIZE in src/config.ts
const HEIGHT = 1000;
const MAX_BYTES = 150_000;
// SwiftShader draws a frame of the whole day in seconds, not milliseconds.
const READY_TIMEOUT = GL === 'swiftshader' ? 300_000 : 90_000;

const server = await startServer('dev');
const browser = await launch({ headed: !!arg('headed') });
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
  const data = arg('data');
  const url = `${server.url}?poster${data ? `&data=${data}` : ''}`;
  page.setDefaultTimeout(READY_TIMEOUT);
  await page.goto(url, { timeout: READY_TIMEOUT });
  const ready = await page.waitForFunction(
    () => {
      const html = document.documentElement;
      return html.dataset.posterReady === '1' ? 'ready' : html.classList.contains('boot-failed') && 'boot failed';
    },
    null,
    { timeout: READY_TIMEOUT },
  );
  if ((await ready.jsonValue()) !== 'ready') throw new Error(`poster: the app did not boot (renderer: ${await glRenderer(page)})`);
  await page.waitForTimeout(300);
  const png = await page.screenshot({ type: 'png' });
  console.log(`renderer: ${await glRenderer(page)}`);

  // Encode WebP inside Chromium (no native image deps needed).
  const { webp, lqip, q } = await page.evaluate(
    async ({ b64, maxBytes }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const encode = (w, h, quality) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        return c.toDataURL('image/webp', quality);
      };
      let quality = 0.86;
      let out = encode(img.width, img.height, quality);
      while (out.length * 0.75 > maxBytes && quality > 0.4) {
        quality -= 0.06;
        out = encode(img.width, img.height, quality);
      }
      return { webp: out, lqip: encode(40, 25, 0.5), q: quality };
    },
    { b64: png.toString('base64'), maxBytes: MAX_BYTES },
  );
  const buf = Buffer.from(webp.split(',')[1], 'base64');
  writeFileSync(resolve(WEB, 'public/poster.webp'), buf);
  writeFileSync(resolve(WEB, 'public/poster-lqip.txt'), lqip);
  console.log(
    `wrote public/poster.webp (${(buf.length / 1024).toFixed(0)} KB, q=${q.toFixed(2)}) ` +
      `and public/poster-lqip.txt (${lqip.length} chars) from ${url}`,
  );
} finally {
  await browser.close();
  await server.close();
}
