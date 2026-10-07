import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/sessions.js';
import { json, now } from '../db.js';
import { hashToken, newId, newToken } from '../security.js';
import { HttpError, notFound } from '../services/core.js';
import { present } from '../services/jobs.js';
import { nextRuns, validateCron, type QueueRow, type ScheduleRow } from '../services/triggers.js';

const ScheduleBody = z.object({
  flowId: z.string(),
  name: z.string().trim().min(1).max(100),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().max(64).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  inputs: z.record(z.string(), z.unknown()).default({}),
  pool: z.string().max(64).default('default'),
  enabled: z.boolean().default(true),
});
const WebhookBody = z.object({ flowId: z.string(), name: z.string().trim().min(1).max(100) });
const QueueBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(''),
  flowId: z.string().nullable().default(null),
  maxRetries: z.number().int().min(0).max(10).default(2),
  enabled: z.boolean().default(true),
});
const ItemsBody = z.object({
  items: z
    .array(z.object({ reference: z.string().max(200).optional(), data: z.record(z.string(), z.unknown()), priority: z.number().int().min(-10).max(10).optional() }))
    .min(1)
    .max(10_000),
});

export async function triggerRoutes(app: FastifyInstance) {
  const { db, scheduler, jobs, queues, audit, config } = app.svc;
  const actor = (r: { user?: { id: string; username: string } }) => ({ id: r.user!.id, name: r.user!.username });

  // -- schedules ---------------------------------------------------------------------------

  app.get('/api/schedules', { preHandler: requireRole('viewer') }, async (request) => {
    const { flowId } = request.query as { flowId?: string };
    const rows = flowId
      ? db.all<ScheduleRow & { flow_name: string }>('SELECT s.*, f.name AS flow_name FROM schedules s JOIN flows f ON f.id = s.flow_id WHERE s.flow_id = ? ORDER BY s.name', flowId)
      : db.all<ScheduleRow & { flow_name: string }>('SELECT s.*, f.name AS flow_name FROM schedules s JOIN flows f ON f.id = s.flow_id ORDER BY f.name, s.name');
    return {
      schedules: rows.map((s) => ({
        id: s.id,
        flowId: s.flow_id,
        flowName: s.flow_name,
        name: s.name,
        cron: s.cron,
        timezone: s.timezone,
        inputs: json(s.inputs, {}),
        pool: s.pool,
        enabled: !!s.enabled,
        lastRunAt: s.last_run_at,
        nextRunAt: s.enabled ? scheduler.nextRun(s.id) : null,
      })),
    };
  });

  app.post('/api/schedules/preview', { preHandler: requireRole('viewer') }, async (request) => {
    const { cron, timezone } = z.object({ cron: z.string(), timezone: z.string() }).parse(request.body);
    validateCron(cron, timezone);
    return { next: nextRuns(cron, timezone, 5) };
  });

  app.post('/api/schedules', { preHandler: requireRole('operator') }, async (request) => {
    const body = ScheduleBody.parse(request.body);
    validateCron(body.cron, body.timezone);
    if (!db.get('SELECT 1 FROM flows WHERE id = ?', body.flowId)) throw notFound('The automation');
    const id = newId('sch');
    db.run(
      'INSERT INTO schedules (id, flow_id, name, cron, timezone, inputs, pool, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      body.flowId,
      body.name,
      body.cron,
      body.timezone,
      JSON.stringify(body.inputs),
      body.pool,
      body.enabled ? 1 : 0,
      request.user!.displayName,
      now(),
    );
    scheduler.sync(db.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', id)!);
    audit.record(actor(request), 'schedule.created', id, { flowId: body.flowId, cron: body.cron });
    return { id, nextRunAt: scheduler.nextRun(id) };
  });

  app.put('/api/schedules/:id', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = ScheduleBody.parse(request.body);
    validateCron(body.cron, body.timezone);
    const changed = db.run(
      'UPDATE schedules SET flow_id = ?, name = ?, cron = ?, timezone = ?, inputs = ?, pool = ?, enabled = ? WHERE id = ?',
      body.flowId,
      body.name,
      body.cron,
      body.timezone,
      JSON.stringify(body.inputs),
      body.pool,
      body.enabled ? 1 : 0,
      id,
    ).changes;
    if (!changed) throw notFound('The schedule');
    scheduler.sync(db.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', id)!);
    audit.record(actor(request), 'schedule.updated', id, { cron: body.cron, enabled: body.enabled });
    return { ok: true, nextRunAt: scheduler.nextRun(id) };
  });

  app.delete('/api/schedules/:id', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    db.run('DELETE FROM schedules WHERE id = ?', id);
    scheduler.sync(id);
    audit.record(actor(request), 'schedule.deleted', id);
    return { ok: true };
  });

  // -- webhooks ----------------------------------------------------------------------------

  app.get('/api/webhooks', { preHandler: requireRole('operator') }, async (request) => {
    const { flowId } = request.query as { flowId?: string };
    const rows = db.all<{ id: string; flow_id: string; name: string; token_hint: string; enabled: number; created_at: string; last_called_at: string | null }>(
      `SELECT id, flow_id, name, token_hint, enabled, created_at, last_called_at FROM webhooks ${flowId ? 'WHERE flow_id = ?' : ''} ORDER BY name`,
      ...(flowId ? [flowId] : []),
    );
    return {
      webhooks: rows.map((w) => ({ id: w.id, flowId: w.flow_id, name: w.name, tokenHint: w.token_hint, enabled: !!w.enabled, createdAt: w.created_at, lastCalledAt: w.last_called_at })),
    };
  });

  app.post('/api/webhooks', { preHandler: requireRole('operator') }, async (request) => {
    const body = WebhookBody.parse(request.body);
    if (!db.get('SELECT 1 FROM flows WHERE id = ?', body.flowId)) throw notFound('The automation');
    const { token, hash } = newToken('afh');
    const id = newId('whk');
    db.run(
      'INSERT INTO webhooks (id, flow_id, name, token_hash, token_hint, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      body.flowId,
      body.name,
      hash,
      `…${token.slice(-6)}`,
      request.user!.displayName,
      now(),
    );
    audit.record(actor(request), 'webhook.created', id, { flowId: body.flowId });
    // The full address is shown once; only its hash is stored.
    return { id, url: `${config.publicUrl}/api/hooks/${token}` };
  });

  app.delete('/api/webhooks/:id', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    db.run('DELETE FROM webhooks WHERE id = ?', id);
    audit.record(actor(request), 'webhook.deleted', id);
    return { ok: true };
  });

  /** Other systems start a run: POST JSON start values to the secret address. */
  app.post('/api/hooks/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const { token } = request.params as { token: string };
    const hook = db.get<{ id: string; flow_id: string; name: string; enabled: number }>('SELECT * FROM webhooks WHERE token_hash = ?', hashToken(token));
    if (!hook || !hook.enabled) throw new HttpError(404, 'Unknown webhook.');
    const inputs = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : {};
    const job = jobs.create({ flowId: hook.flow_id, trigger: 'webhook', triggerRef: hook.id, triggeredBy: `Webhook “${hook.name}”`, inputs });
    db.run('UPDATE webhooks SET last_called_at = ? WHERE id = ?', now(), hook.id);
    return { jobId: job.id, status: job.status, statusUrl: `${config.publicUrl}/api/hooks/${token}/jobs/${job.id}` };
  });

  app.get('/api/hooks/:token/jobs/:jobId', async (request) => {
    const { token, jobId } = request.params as { token: string; jobId: string };
    const hook = db.get<{ id: string }>('SELECT id FROM webhooks WHERE token_hash = ?', hashToken(token));
    const job = hook ? jobs.get(jobId) : undefined;
    if (!hook || !job || job.trigger_ref !== hook.id) throw new HttpError(404, 'Unknown run.');
    const p = present(job);
    return { id: p.id, status: p.status, outputs: p.outputs, error: p.error, queuedAt: p.queuedAt, finishedAt: p.finishedAt };
  });

  // -- queues ------------------------------------------------------------------------------

  app.get('/api/queues', { preHandler: requireRole('viewer') }, async () => {
    const rows = db.all<QueueRow & { flow_name: string | null; counts: string }>(
      `SELECT q.*, f.name AS flow_name,
         (SELECT json_object('new', SUM(status = 'new'), 'in_progress', SUM(status = 'in_progress'),
                             'done', SUM(status = 'done'), 'failed', SUM(status = 'failed'))
            FROM queue_items i WHERE i.queue_id = q.id) AS counts
       FROM queues q LEFT JOIN flows f ON f.id = q.flow_id ORDER BY q.name`,
    );
    return {
      queues: rows.map((q) => ({
        id: q.id,
        name: q.name,
        description: q.description,
        flowId: q.flow_id,
        flowName: q.flow_name,
        maxRetries: q.max_retries,
        enabled: !!q.enabled,
        counts: Object.fromEntries(Object.entries(json<Record<string, number | null>>(q.counts, {})).map(([k, v]) => [k, v ?? 0])),
      })),
    };
  });

  app.post('/api/queues', { preHandler: requireRole('operator') }, async (request) => {
    const body = QueueBody.parse(request.body);
    const id = newId('que');
    try {
      db.run(
        'INSERT INTO queues (id, name, description, flow_id, max_retries, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        body.name,
        body.description,
        body.flowId,
        body.maxRetries,
        body.enabled ? 1 : 0,
        now(),
      );
    } catch {
      throw new HttpError(409, 'A queue with this name already exists.');
    }
    audit.record(actor(request), 'queue.created', id, { name: body.name });
    return { id };
  });

  app.put('/api/queues/:id', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = QueueBody.parse(request.body);
    const changed = db.run(
      'UPDATE queues SET name = ?, description = ?, flow_id = ?, max_retries = ?, enabled = ? WHERE id = ?',
      body.name,
      body.description,
      body.flowId,
      body.maxRetries,
      body.enabled ? 1 : 0,
      id,
    ).changes;
    if (!changed) throw notFound('The queue');
    queues.pump(id);
    return { ok: true };
  });

  app.delete('/api/queues/:id', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    db.run('DELETE FROM queues WHERE id = ?', id);
    audit.record(actor(request), 'queue.deleted', id);
    return { ok: true };
  });

  app.get('/api/queues/:id/items', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    const { status } = request.query as { status?: string };
    const rows = db.all<{ id: string; reference: string; status: string; priority: number; data: string; result: string | null; error: string | null; attempts: number; job_id: string | null; created_at: string; updated_at: string }>(
      `SELECT * FROM queue_items WHERE queue_id = ? ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC LIMIT 500`,
      ...(status ? [id, status] : [id]),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        status: r.status,
        priority: r.priority,
        data: json(r.data, {}),
        result: json(r.result, null),
        error: r.error,
        attempts: r.attempts,
        jobId: r.job_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.post('/api/queues/:id/items', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = ItemsBody.parse(request.body);
    const ids = queues.addItems(id, body.items);
    audit.record(actor(request), 'queue.items_added', id, { count: ids.length });
    return { added: ids.length };
  });

  app.post('/api/queues/:id/retry-failed', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    const n = db.run(`UPDATE queue_items SET status = 'new', attempts = 0, updated_at = ? WHERE queue_id = ? AND status = 'failed'`, now(), id).changes;
    queues.pump(id);
    return { retried: n };
  });
}
