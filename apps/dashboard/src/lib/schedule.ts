// Friendly schedules <-> cron. People choose "Every weekday at 08:00"; cron stays underneath.

export type Friendly =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'monthly'; day: number | 'last'; time: string }
  | { kind: 'every'; minutes: number; from: string; to: string; weekdaysOnly: boolean }
  | { kind: 'cron'; cron: string };

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const EVERY_OPTIONS = [5, 10, 15, 30, 60, 120, 240];

const hm = (time: string): [number, number] => {
  const [h, m] = time.split(':').map(Number);
  return [Math.min(Math.max(h ?? 0, 0), 23), Math.min(Math.max(m ?? 0, 0), 59)];
};
const pad = (n: number) => String(n).padStart(2, '0');
const time = (h: string | number, m: string | number) => `${pad(Number(h))}:${pad(Number(m))}`;

export function toCron(f: Friendly): string {
  switch (f.kind) {
    case 'daily': {
      const [h, m] = hm(f.time);
      return `${m} ${h} * * *`;
    }
    case 'weekdays': {
      const [h, m] = hm(f.time);
      return `${m} ${h} * * 1-5`;
    }
    case 'weekly': {
      const [h, m] = hm(f.time);
      const days = [...new Set(f.days)].sort((a, b) => a - b);
      return `${m} ${h} * * ${days.length ? days.join(',') : '1'}`;
    }
    case 'monthly': {
      const [h, m] = hm(f.time);
      return `${m} ${h} ${f.day === 'last' ? 'L' : f.day} * *`;
    }
    case 'every': {
      const [fh] = hm(f.from);
      const [th] = hm(f.to);
      const dow = f.weekdaysOnly ? '1-5' : '*';
      const hours = `${fh}-${Math.max(fh, th - (f.minutes < 60 ? 1 : 0))}`;
      if (f.minutes < 60) return `*/${f.minutes} ${hours} * * ${dow}`;
      const step = Math.round(f.minutes / 60);
      return `0 ${fh}-${Math.max(fh, th)}/${step} * * ${dow}`;
    }
    case 'cron':
      return f.cron.trim();
  }
}

/** Recognise cron expressions this builder produced; anything else stays "cron". */
export function fromCron(cron: string): Friendly {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { kind: 'cron', cron };
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const fixed = /^\d+$/.test(min) && /^\d+$/.test(hour);
  if (fixed && mon === '*') {
    const t = time(hour, min);
    if (dom === '*' && dow === '*') return { kind: 'daily', time: t };
    if (dom === '*' && dow === '1-5') return { kind: 'weekdays', time: t };
    if (dom === '*' && /^\d(,\d)*$/.test(dow)) return { kind: 'weekly', days: dow.split(',').map(Number), time: t };
    if (dow === '*' && (dom === 'L' || /^\d+$/.test(dom))) return { kind: 'monthly', day: dom === 'L' ? 'last' : Number(dom), time: t };
  }
  const everyMin = /^\*\/(\d+)$/.exec(min);
  const range = /^(\d+)-(\d+)$/.exec(hour);
  if (everyMin && range && dom === '*' && mon === '*' && (dow === '*' || dow === '1-5')) {
    return { kind: 'every', minutes: Number(everyMin[1]), from: time(range[1]!, 0), to: time(Number(range[2]) + 1, 0), weekdaysOnly: dow === '1-5' };
  }
  const everyHour = /^(\d+)-(\d+)\/(\d+)$/.exec(hour);
  if (min === '0' && everyHour && dom === '*' && mon === '*' && (dow === '*' || dow === '1-5')) {
    return { kind: 'every', minutes: Number(everyHour[3]) * 60, from: time(everyHour[1]!, 0), to: time(everyHour[2]!, 0), weekdaysOnly: dow === '1-5' };
  }
  return { kind: 'cron', cron };
}

export function describe(f: Friendly): string {
  switch (f.kind) {
    case 'daily':
      return `Every day at ${f.time}`;
    case 'weekdays':
      return `Every weekday (Mon–Fri) at ${f.time}`;
    case 'weekly': {
      const days = [...f.days].sort((a, b) => a - b).map((d) => DAY_NAMES[d]);
      return `Every ${days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}` : days[0]} at ${f.time}`;
    }
    case 'monthly':
      return `Every month on the ${f.day === 'last' ? 'last day' : ordinal(f.day)} at ${f.time}`;
    case 'every': {
      const every = f.minutes < 60 ? `${f.minutes} minutes` : f.minutes === 60 ? 'hour' : `${f.minutes / 60} hours`;
      return `Every ${every} from ${f.from} to ${f.to}${f.weekdaysOnly ? ' on weekdays' : ''}`;
    }
    case 'cron':
      return `Custom (${f.cron})`;
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
