// Intro overlay: title, the headline insight and a "scroll / tap to explore"
// prompt, over the poster and then over the live, already-playing map.
//
// The markup is static in index.html (headline inlined at build time from
// data/manifest.json by vite.config.ts) so it is on the very first paint with
// the poster; this module only fills it from the loaded manifest and wires the
// dismissal. The first wheel / touch / click / key anywhere fades it out. That
// first gesture is consumed (it doesn't also zoom the map or toggle playback);
// the HUD sits above the overlay and works straight away.

import type { Manifest } from '../data/types';

const FADE_MS = 650;

export interface IntroHandle {
  readonly open: boolean;
  /** Fade out (or remove at once with `instant`). Idempotent. */
  dismiss(instant?: boolean): void;
  /** Called once when the intro starts to close. */
  onDismiss(fn: () => void): void;
}

export function mountIntro(manifest: Manifest, opts: { onChapter?: () => void } = {}): IntroHandle {
  const el = document.getElementById('intro');
  const listeners: (() => void)[] = [];
  let open = !!el;
  const handle: IntroHandle = {
    get open() {
      return open;
    },
    dismiss,
    onDismiss: (fn) => void listeners.push(fn),
  };
  if (!el) return handle;

  fill(el, manifest);
  document.documentElement.classList.add('intro-open');

  el.querySelector<HTMLButtonElement>('.intro-go')?.addEventListener('click', () => dismiss());
  const chapterLink = el.querySelector<HTMLButtonElement>('[data-intro-chapter]');
  chapterLink?.addEventListener('click', (e) => {
    e.stopPropagation();
    dismiss();
    opts.onChapter?.();
  });

  // Any first gesture dismisses. Capture on window so it runs before the map
  // and the keyboard shortcuts; events that land on the overlay itself are
  // consumed so the gesture doesn't also zoom/pan the map.
  const onGesture = (e: Event) => {
    if (!open) return;
    const target = e.target as HTMLElement | null;
    const onOverlay = !!target && el.contains(target);
    if (e.type === 'keydown') {
      const k = (e as KeyboardEvent).key;
      if (k === 'Tab' || k === 'Shift' || k === 'Meta' || k === 'Alt' || k === 'Control') return;
      if (onOverlay && (k === 'Enter' || k === ' ') && target?.closest('button')) return; // let the button act
      if (k === ' ' || k === 'Enter' || k === 'Escape') e.preventDefault();
      e.stopImmediatePropagation();
    } else if (onOverlay && target?.closest('button')) {
      // The intro's own buttons act on click. Dismissing on pointerdown would
      // switch the overlay's pointer-events off mid-click and the click would miss.
      return;
    } else if (onOverlay) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    }
    dismiss();
  };
  const types = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
  for (const t of types) window.addEventListener(t, onGesture, { capture: true, passive: false });

  function dismiss(instant = false) {
    if (!open || !el) return;
    open = false;
    for (const t of types) window.removeEventListener(t, onGesture, { capture: true });
    document.documentElement.classList.remove('intro-open');
    listeners.forEach((fn) => fn());
    if (instant) {
      el.remove();
      return;
    }
    el.classList.add('closing');
    const done = () => el.remove();
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, FADE_MS + 150);
  }

  return handle;
}

function fill(el: HTMLElement, m: Manifest) {
  const set = (sel: string, text: string | undefined) => {
    const node = el.querySelector(sel);
    if (node && text) node.textContent = text;
  };
  const d = new Date(`${m.date}T12:00:00`);
  const day = Number.isNaN(d.getTime())
    ? m.date
    : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  set('[data-intro-date]', day);
  set('[data-intro-trips]', m.totals.trips.toLocaleString('en-US'));
  set('[data-intro-headline]', m.headline);
  // The evening flip, if the encoder found one for the same region, turns the headline into a tide.
  const m1 = /, (.+?) (absorbs|sends out) /.exec(m.headline);
  const opposite = m1?.[2] === 'absorbs' ? 'sends out' : 'absorbs';
  const flip = m1 ? m.runner_ups?.find((r) => r.includes(`, ${m1[1]} ${opposite} `)) : undefined;
  const sub = el.querySelector('[data-intro-sub]');
  if (sub) {
    if (flip) sub.textContent = `Then the tide turns. ${flip}`;
    else sub.remove();
  }
}
