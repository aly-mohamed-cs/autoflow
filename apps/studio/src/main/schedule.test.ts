import { describe, expect, it } from 'vitest';
import { nextRun } from './schedule';

const at = (s: string) => new Date(s); // local time
const schedule = (kind: 'manual' | 'daily' | 'weekdays' | 'every', time = '09:00', minutes = 60) => ({ kind, time, minutes });

describe('work plan schedules', () => {
  it('runs daily at the time, today if it is still ahead', () => {
    expect(nextRun(schedule('daily'), at('2026-10-13T08:00:00'))).toEqual(at('2026-10-13T09:00:00'));
    expect(nextRun(schedule('daily'), at('2026-10-13T09:00:00'))).toEqual(at('2026-10-14T09:00:00'));
  });

  it('skips Saturday and Sunday for weekdays', () => {
    // 2026-10-16 is a Friday.
    expect(nextRun(schedule('weekdays', '07:30'), at('2026-10-16T08:00:00'))).toEqual(at('2026-10-19T07:30:00'));
    expect(nextRun(schedule('weekdays', '07:30'), at('2026-10-16T07:00:00'))).toEqual(at('2026-10-16T07:30:00'));
  });

  it('repeats every few minutes (at least 5), and never when started by hand', () => {
    expect(nextRun(schedule('every', '', 30), at('2026-10-13T10:00:00'))).toEqual(at('2026-10-13T10:30:00'));
    expect(nextRun(schedule('every', '', 1), at('2026-10-13T10:00:00'))).toEqual(at('2026-10-13T10:05:00'));
    expect(nextRun(schedule('manual'), at('2026-10-13T10:00:00'))).toBeNull();
  });
});
