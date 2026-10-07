export function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  const future = diff < 0;
  const s = Math.abs(diff);
  const text =
    s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : s < 7 * 86400 ? `${Math.round(s / 86400)} d` : '';
  if (!text) return dateTime(iso);
  if (text === 'just now') return text;
  return future ? `in ${text}` : `${text} ago`;
}

/** Date and time; pass a time zone to show it as seen there (e.g. a schedule's zone). */
export function dateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone });
  } catch {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function percent(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`;
}

export const TRIGGER_LABELS: Record<string, string> = {
  manual: 'Started by hand',
  schedule: 'Schedule',
  webhook: 'Webhook',
  queue: 'Queue',
  hotkey: 'Hotkey',
  api: 'API',
};
