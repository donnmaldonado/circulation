// The day on show, from manifest.date (YYYY-MM-DD, NYC local).
// long: "Wednesday, June 3, 2026" · short: "Wed, Jun 3"

export function formatDay(iso: string, style: 'long' | 'short' = 'long'): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return style === 'long'
    ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
