const relative = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
const dateTime = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'medium' });
const dateOnly = new Intl.DateTimeFormat('es', { dateStyle: 'medium' });
const number = new Intl.NumberFormat('es');

/** "hace 3 min", "ayer"… */
export function timeAgo(value: string | Date, now = Date.now()): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'ahora mismo';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  return dateOnly.format(new Date(value));
}

export const fullDate = (value: string | Date) => dateTime.format(new Date(value));
export const shortDate = (value: string | Date) => dateOnly.format(new Date(value));
export const formatNumber = (value: number) => number.format(value);

export function percent(part: number, total: number): string {
  if (!total) return '—';
  return `${((part / total) * 100).toFixed(part === total ? 0 : 1)} %`;
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}
