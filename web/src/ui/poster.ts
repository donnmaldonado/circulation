// The poster is painted by index.html's inline CSS before any JS runs. Once the
// basemap and the first trips are on screen we cross-fade it away.

const FADE_MS = 700;

export function revealLive(): Promise<void> {
  const poster = document.getElementById('poster');
  document.documentElement.classList.add('live');
  if (!poster) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      poster.remove();
      resolve();
    };
    poster.addEventListener('transitionend', done, { once: true });
    setTimeout(done, FADE_MS + 200); // in case transitions are disabled
  });
}
