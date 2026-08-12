/**
 * Time formatting helpers shared across screens.
 */

export function timeAgo(iso, t) {
  if (!iso) return t.never;
  // Server timestamps are UTC but arrive without the Z suffix
  const then = new Date(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(then.getTime())) return iso;
  const mins = Math.floor((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return t.justNow;
  if (mins < 60) return t.minutesAgo(mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t.hoursAgo(hrs);
  return t.daysAgo(Math.floor(hrs / 24));
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDateLong(iso) {
  if (!iso) return '—';
  const d = new Date(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}
