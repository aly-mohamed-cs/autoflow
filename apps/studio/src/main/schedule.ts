// When a work plan automation runs next on this PC (local time).
import type { WorkPlanSchedule } from '../shared/api';

/** The next time a schedule is due after `from` (null: only when started by hand). */
export function nextRun(schedule: WorkPlanSchedule, from: Date): Date | null {
  if (schedule.kind === 'manual') return null;
  if (schedule.kind === 'every') return new Date(from.getTime() + Math.max(5, schedule.minutes) * 60_000);
  const [h, m] = schedule.time.split(':').map(Number) as [number, number];
  const at = new Date(from);
  at.setHours(h, m, 0, 0);
  if (at <= from) at.setDate(at.getDate() + 1);
  if (schedule.kind === 'weekdays') while (at.getDay() === 0 || at.getDay() === 6) at.setDate(at.getDate() + 1);
  return at;
}
