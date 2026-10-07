import type { Flow } from '@autoflow/flow-types';
import type { Db, Row } from '../db.js';
import { json, now } from '../db.js';
import { newId } from '../security.js';
import { badRequest, notFound, type Bus } from './core.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type Trigger = 'manual' | 'schedule' | 'webhook' | 'queue' | 'hotkey' | 'api';

export interface JobRow {
  id: string;
  flow_id: string;
  version: number;
  status: JobStatus;
  trigger: Trigger;
  trigger_ref: string | null;
  triggered_by: string | null;
  inputs: string;
  pool: string;
  robot_id: string | null;
  priority: number;
  timeout_s: number;
  queue_item_id: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  outputs: string | null;
  error: string | null;
  cancel_requested: number;
}

export interface CreateJob {
  flowId: string;
  version?: number;
  trigger: Trigger;
  triggerRef?: string | null;
  triggeredBy?: string | null;
  inputs?: Record<string, unknown>;
  pool?: string;
  priority?: number;
  timeoutS?: number;
  queueItemId?: string | null;
}

export interface FinishJob {
  status: 'succeeded' | 'failed' | 'cancelled';
  durationMs?: number;
  outputs?: Record<string, unknown>;
  error?: { message: string; hint?: string | null; step_id?: string } | null;
}

/** Engine events worth keeping for run history (variables are only kept as the final outputs). */
const KEPT_EVENTS = new Set(['run_started', 'step_started', 'step_finished', 'log', 'screenshot', 'run_finished']);

export class Jobs {
  /** Called after any job finishes (queues, alerts...). */
  onFinished: ((job: JobRow) => void)[] = [];
  /** Called when a job is queued (dispatcher). */
  onQueued: (() => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
  ) {}

  create(input: CreateJob): JobRow {
    const flow = this.db.get<{ latest_version: number; archived: number }>('SELECT latest_version, archived FROM flows WHERE id = ?', input.flowId);
    if (!flow || flow.archived) throw notFound('The automation');
    const version = input.version ?? flow.latest_version;
    if (!version || !this.db.get('SELECT 1 FROM flow_versions WHERE flow_id = ? AND version = ?', input.flowId, version)) {
      throw badRequest('This automation has no published version yet. Publish it from Studio first.');
    }
    const id = newId('job');
    this.db.run(
      `INSERT INTO jobs (id, flow_id, version, status, trigger, trigger_ref, triggered_by, inputs, pool, priority, timeout_s, queue_item_id, queued_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.flowId,
      version,
      input.trigger,
      input.triggerRef ?? null,
      input.triggeredBy ?? null,
      JSON.stringify(input.inputs ?? {}),
      input.pool ?? 'default',
      input.priority ?? 0,
      input.timeoutS ?? 3600,
      input.queueItemId ?? null,
      now(),
    );
    const job = this.get(id)!;
    this.publish(job);
    for (const fn of this.onQueued) fn();
    return job;
  }

  get(id: string): JobRow | undefined {
    return this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id);
  }

  definition(job: Pick<JobRow, 'flow_id' | 'version'>): Flow {
    const row = this.db.get<{ definition: string }>('SELECT definition FROM flow_versions WHERE flow_id = ? AND version = ?', job.flow_id, job.version);
    if (!row) throw notFound('The automation version');
    return JSON.parse(row.definition) as Flow;
  }

  /** Atomically take the next queued job a robot in this pool may run. */
  claimNext(robotId: string, pool: string): JobRow | undefined {
    return this.db.tx(() => {
      const job = this.db.get<JobRow>(
        `SELECT * FROM jobs WHERE status = 'queued' AND pool = ? AND cancel_requested = 0
         ORDER BY priority DESC, queued_at LIMIT 1`,
        pool,
      );
      if (!job) return undefined;
      this.db.run(`UPDATE jobs SET status = 'running', robot_id = ?, started_at = ? WHERE id = ? AND status = 'queued'`, robotId, now(), job.id);
      return this.get(job.id);
    });
  }

  /** Put a claimed job back (e.g. the robot went away before accepting it). */
  requeue(jobId: string): void {
    this.db.run(`UPDATE jobs SET status = 'queued', robot_id = NULL, started_at = NULL WHERE id = ? AND status = 'running'`, jobId);
    const job = this.get(jobId);
    if (job) this.publish(job);
  }

  recordEvent(jobId: string, event: Record<string, unknown>): void {
    const kind = String(event.event ?? 'unknown');
    if (!KEPT_EVENTS.has(kind)) return;
    const seq = (this.db.get<{ n: number | null }>('SELECT MAX(seq) AS n FROM job_events WHERE job_id = ?', jobId)?.n ?? 0) + 1;
    this.db.run(
      'INSERT INTO job_events (job_id, seq, ts, kind, step_id, data) VALUES (?, ?, ?, ?, ?, ?)',
      jobId,
      seq,
      Number(event.ts ?? Date.now() / 1000),
      kind,
      typeof event.step_id === 'string' ? event.step_id : null,
      JSON.stringify(event),
    );
    this.bus.publish({ type: 'job.event', jobId, event });
  }

  events(jobId: string): Record<string, unknown>[] {
    return this.db.all<{ data: string }>('SELECT data FROM job_events WHERE job_id = ? ORDER BY seq', jobId).map((r) => json(r.data, {}));
  }

  finish(jobId: string, result: FinishJob): JobRow | undefined {
    const changed = this.db.run(
      `UPDATE jobs SET status = ?, finished_at = ?, duration_ms = ?, outputs = ?, error = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
      result.status,
      now(),
      result.durationMs ?? null,
      JSON.stringify(result.outputs ?? {}),
      result.error ? JSON.stringify(result.error) : null,
      jobId,
    ).changes;
    const job = this.get(jobId);
    if (!job || !changed) return job;
    this.publish(job);
    for (const fn of this.onFinished) {
      try {
        fn(job);
      } catch (err) {
        console.error('job finished hook failed', err);
      }
    }
    return job;
  }

  requestCancel(jobId: string): JobRow {
    const job = this.get(jobId);
    if (!job) throw notFound('The run');
    if (job.status === 'queued') return this.finish(jobId, { status: 'cancelled', error: { message: 'Cancelled before it started.' } })!;
    if (job.status === 'running') {
      this.db.run('UPDATE jobs SET cancel_requested = 1 WHERE id = ?', jobId);
      return this.get(jobId)!;
    }
    return job;
  }

  publish(job: JobRow): void {
    this.bus.publish({ type: 'job.updated', job: present(job) });
  }
}

/** API shape of a job. */
export function present(job: JobRow, extra: Row = {}): Record<string, unknown> {
  return {
    id: job.id,
    flowId: job.flow_id,
    version: job.version,
    status: job.status,
    trigger: job.trigger,
    triggerRef: job.trigger_ref,
    triggeredBy: job.triggered_by,
    inputs: json(job.inputs, {}),
    pool: job.pool,
    robotId: job.robot_id,
    priority: job.priority,
    queuedAt: job.queued_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    durationMs: job.duration_ms,
    outputs: json(job.outputs, null),
    error: json(job.error, null),
    cancelRequested: !!job.cancel_requested,
    ...extra,
  };
}
