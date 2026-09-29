// The day on show, from manifest.date (YYYY-MM-DD, NYC local).
// long: "Sunday, September 28, 2025" · short: "Sun, Sep 28"
//
// The site shows the same date one year back and is rebuilt every night, so
// the day is usually "one year ago today". dayLabel() only says so when it is
// still true for the viewer in New York: a late or failed nightly build leaves
// an older day up, and a page left open past midnight goes stale.

export function formatDay(iso: string, style: 'long' | 'short' = 'long'): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return style === 'long'
    ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Today's date in New York as YYYY-MM-DD (daysBack earlier). */
export function nycDate(now: Date = new Date(), daysBack = 0): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day - daysBack));
  return d.toISOString().slice(0, 10);
}

/** The day the nightly build shows for a given NYC date: one year back, Feb 29 → Feb 28. */
export function yearAgo(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${+y - 1}-${m}-${m === '02' && d === '29' ? '28' : d}`;
}

/** "One year ago today", "One year ago yesterday", or null when neither is true. */
export function yearAgoLabel(iso: string, now: Date = new Date()): string | null {
  if (iso === yearAgo(nycDate(now))) return 'One year ago today';
  if (iso === yearAgo(nycDate(now, 1))) return 'One year ago yesterday';
  return null;
}

/** The title line's lead-in before the date: "One year ago today · ", or "" when that would not be true. */
export function agoPrefix(iso: string, now: Date = new Date()): string {
  const ago = yearAgoLabel(iso, now);
  return ago ? `${ago} · ` : '';
}
