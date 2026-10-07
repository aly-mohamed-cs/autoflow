// Schedules ("every weekday at 08:00") and work queues.
import { Cron } from 'croner';
import type { Db } from '../db.js';
import { json, now } from '../db.js';
import { newId } from '../security.js';
import { badRequest, type Bus } from './core.js';
import type { JobRow, Jobs } from './jobs.js';

export interface ScheduleRow {
  id: string;
  flow_id: string;
  name: string;
  cron: string;
  timezone: string;
  inputs: string;
  pool: string;
  enabled: number;
  created_by: string | null;
  created_at: string;
  last_run_at: string | null;
}

export function validateCron(expression: string, timezone: string): void {
  try {
    const probe = new Cron(expression, { timezone, paused: true });
    probe.stop();
  } catch (err) {
    throw badRequest(`The schedule is not valid: ${(err as Error).message}`);
  }
}

export function nextRuns(expression: string, timezone: string, count = 3): string[] {
  try {
    const probe = new Cron(expression, { timezone, paused: true });
    const runs = probe.nextRuns(count).map((d) => d.toISOString());
    probe.stop();
    return runs;
  } catch {
    return [];
  }
}

export class Scheduler {
  private readonly crons = new Map<string, Cron>();

  constructor(
    private readonly db: Db,
    private readonly jobs: Jobs,
  ) {}

  start(): void {
    for (const s of this.db.all<ScheduleRow>('SELECT * FROM schedules')) this.sync(s);
  }

  stop(): void {
    for (const c of this.crons.values()) c.stop();
    this.crons.clear();
  }

  /** Create, update or remove the timer for a schedule row (or id after deletion). */
  sync(schedule: ScheduleRow | string): void {
    const id = typeof schedule === 'string' ? schedule : schedule.id;
    this.crons.get(id)?.stop();
    this.crons.delete(id);
    if (typeof schedule === 'string' || !schedule.enabled) return;
    const cron = new Cron(schedule.cron, { timezone: schedule.timezone, protect: true }, () => this.fire(id));
    this.crons.set(id, cron);
  }

  nextRun(id: string): string | null {
    return this.crons.get(id)?.nextRun()?.toISOString() ?? null;
  }

  private fire(id: string): void {
    const s = this.db.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', id);
    if (!s || !s.enabled) return;
    // Don't pile up: skip if the previous run of this schedule is still waiting or running.
    const active = this.db.get(
      `SELECT 1 FROM jobs WHERE trigger = 'schedule' AND trigger_ref = ? AND status IN ('queued', 'running')`,
      id,
    );
    if (active) return;
    try {
      this.jobs.create({ flowId: s.flow_id, trigger: 'schedule', triggerRef: id, triggeredBy: `Schedule “${s.name}”`, inputs: json(s.inputs, {}), pool: s.pool });
      this.db.run('UPDATE schedules SET last_run_at = ? WHERE id = ?', now(), id);
    } catch (err) {
      console.error(`schedule ${id} could not start a run:`, (err as Error).message);
    }
  }
}

// -- work queues ---------------------------------------------------------------------

export interface QueueRow {
  id: string;
  name: string;
  description: string;
  flow_id: string | null;
  max_retries: number;
  enabled: number;
  created_at: string;
}

/**
 * Each queue item becomes one run of the queue's automation, with the item's data
 * as the start value "queue_item". Failed items are retried up to max_retries.
 */
export class Queues {
  constructor(
    private readonly db: Db,
    private readonly jobs: Jobs,
    private readonly bus: Bus,
  ) {
    jobs.onFinished.push((job) => this.onJobFinished(job));
  }

  addItems(queueId: string, items: { reference?: string; data: Record<string, unknown>; priority?: number }[]): string[] {
    const queue = this.db.get<QueueRow>('SELECT * FROM queues WHERE id = ?', queueId);
    if (!queue) throw badRequest('Unknown queue.');
    const ids = this.db.tx(() =>
      items.map((item) => {
        const id = newId('qi');
        this.db.run(
          `INSERT INTO queue_items (id, queue_id, reference, status, priority, data, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?, ?, ?)`,
          id,
          queueId,
          String(item.reference ?? '').slice(0, 200),
          item.priority ?? 0,
          JSON.stringify(item.data ?? {}),
          now(),
          now(),
        );
        return id;
      }),
    );
    this.bus.publish({ type: 'queue.updated', queueId });
    this.pump(queueId);
    return ids;
  }

  /** Start runs for waiting items. */
  pump(queueId?: string): void {
    const queues = queueId
      ? this.db.all<QueueRow>('SELECT * FROM queues WHERE id = ? AND enabled = 1 AND flow_id IS NOT NULL', queueId)
      : this.db.all<QueueRow>('SELECT * FROM queues WHERE enabled = 1 AND flow_id IS NOT NULL');
    for (const queue of queues) {
      const waiting = this.db.all<{ id: string; data: string; priority: number; reference: string }>(
        `SELECT id, data, priority, reference FROM queue_items WHERE queue_id = ? AND status = 'new' ORDER BY priority DESC, created_at LIMIT 50`,
        queue.id,
      );
      for (const item of waiting) {
        try {
          const job = this.jobs.create({
            flowId: queue.flow_id!,
            trigger: 'queue',
            triggerRef: queue.id,
            triggeredBy: `Queue “${queue.name}”`,
            inputs: { queue_item: json(item.data, {}), queue_item_reference: item.reference },
            priority: item.priority,
            queueItemId: item.id,
          });
          this.db.run(
            `UPDATE queue_items SET status = 'in_progress', job_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
            job.id,
            now(),
            item.id,
          );
        } catch (err) {
          console.error(`queue ${queue.name}: ${(err as Error).message}`);
          break; // e.g. automation not published; try again later
        }
      }
      if (waiting.length) this.bus.publish({ type: 'queue.updated', queueId: queue.id });
    }
  }

  private onJobFinished(job: JobRow): void {
    if (!job.queue_item_id) return;
    const item = this.db.get<{ queue_id: string; attempts: number }>('SELECT queue_id, attempts FROM queue_items WHERE id = ?', job.queue_item_id);
    if (!item) return;
    const queue = this.db.get<QueueRow>('SELECT * FROM queues WHERE id = ?', item.queue_id);
    if (job.status === 'succeeded') {
      this.db.run(`UPDATE queue_items SET status = 'done', result = ?, error = NULL, updated_at = ? WHERE id = ?`, job.outputs ?? '{}', now(), job.queue_item_id);
    } else {
      const retry = job.status === 'failed' && queue && item.attempts <= queue.max_retries;
      this.db.run(
        `UPDATE queue_items SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
        retry ? 'new' : 'failed',
        json<{ message?: string }>(job.error, {}).message ?? job.status,
        now(),
        job.queue_item_id,
      );
    }
    this.bus.publish({ type: 'queue.updated', queueId: item.queue_id });
    this.pump(item.queue_id);
  }
}
