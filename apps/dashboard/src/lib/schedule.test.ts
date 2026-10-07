import { describe as group, expect, it } from 'vitest';
import { describe, fromCron, toCron, type Friendly } from './schedule';

group('schedule builder', () => {
  const cases: [Friendly, string, string][] = [
    [{ kind: 'daily', time: '08:30' }, '30 8 * * *', 'Every day at 08:30'],
    [{ kind: 'weekdays', time: '07:00' }, '0 7 * * 1-5', 'Every weekday (Mon–Fri) at 07:00'],
    [{ kind: 'weekly', days: [5, 1], time: '18:15' }, '15 18 * * 1,5', 'Every Monday and Friday at 18:15'],
    [{ kind: 'monthly', day: 1, time: '06:00' }, '0 6 1 * *', 'Every month on the 1st at 06:00'],
    [{ kind: 'monthly', day: 'last', time: '23:00' }, '0 23 L * *', 'Every month on the last day at 23:00'],
    [{ kind: 'every', minutes: 15, from: '08:00', to: '18:00', weekdaysOnly: true }, '*/15 8-17 * * 1-5', 'Every 15 minutes from 08:00 to 18:00 on weekdays'],
    [{ kind: 'every', minutes: 120, from: '06:00', to: '20:00', weekdaysOnly: false }, '0 6-20/2 * * *', 'Every 2 hours from 06:00 to 20:00'],
  ];

  for (const [friendly, cron, text] of cases) {
    it(text, () => {
      expect(toCron(friendly)).toBe(cron);
      expect(describe(friendly)).toBe(text);
      const back = fromCron(cron);
      expect(toCron(back)).toBe(cron);
      expect(back.kind).toBe(friendly.kind);
    });
  }

  it('keeps unknown expressions as custom cron', () => {
    expect(fromCron('0 0 1 1 *')).toEqual({ kind: 'cron', cron: '0 0 1 1 *' });
    expect(fromCron('nonsense')).toMatchObject({ kind: 'cron' });
  });

  it('uses ordinals', () => {
    expect(describe({ kind: 'monthly', day: 22, time: '01:00' })).toContain('22nd');
    expect(describe({ kind: 'monthly', day: 13, time: '01:00' })).toContain('13th');
  });
});
