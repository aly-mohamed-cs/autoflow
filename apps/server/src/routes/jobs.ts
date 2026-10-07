import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { requireRole } from '../auth/sessions.js';
import { notFound } from '../services/core.js';
import { present, type JobRow } from '../services/jobs.js';

const STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export async function jobRoutes(app: FastifyInstance) {
  const { db, jobs, gateway, audit, bus } = app.svc;

  app.get('/api/jobs', { preHandler: requireRole('viewer') }, async (request) => {
    const q = request.query as { flowId?: string; status?: string; limit?: string; before?: string };
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.flowId) {
      where.push('j.flow_id = ?');
      params.push(q.flowId);
    }
    if (q.status && STATUSES.has(q.status)) {
      where.push('j.status = ?');
      params.push(q.status);
    }
    if (q.before) {
      where.push('j.queued_at < ?');
      params.push(q.before);
    }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const rows = db.all<JobRow & { flow_name: string; robot_name: string | null }>(
      `SELECT j.*, f.name AS flow_name, r.name AS robot_name FROM jobs j
         JOIN flows f ON f.id = j.flow_id LEFT JOIN robots r ON r.id = j.robot_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY j.queued_at DESC LIMIT ${limit}`,
      ...params,
    );
    return { jobs: rows.map((r) => present(r, { flowName: r.flow_name, robotName: r.robot_name })) };
  });

  app.get('/api/jobs/:id', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    const row = db.get<JobRow & { flow_name: string; robot_name: string | null }>(
      `SELECT j.*, f.name AS flow_name, r.name AS robot_name FROM jobs j
         JOIN flows f ON f.id = j.flow_id LEFT JOIN robots r ON r.id = j.robot_id WHERE j.id = ?`,
      id,
    );
    if (!row) throw notFound('The run');
    const artifacts = db.all<{ id: string; step_id: string | null; kind: string; name: string; size: number; created_at: string }>(
      'SELECT id, step_id, kind, name, size, created_at FROM artifacts WHERE job_id = ? ORDER BY created_at',
      id,
    );
    return {
      job: present(row, { flowName: row.flow_name, robotName: row.robot_name }),
      events: jobs.events(id),
      artifacts: artifacts.map((a) => ({ id: a.id, stepId: a.step_id, kind: a.kind, name: a.name, size: a.size, createdAt: a.created_at })),
      definition: jobs.definition(row),
    };
  });

  app.post('/api/jobs/:id/cancel', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    const job = jobs.requestCancel(id);
    gateway.cancel(id);
    audit.record({ id: request.user!.id, name: request.user!.username }, 'job.cancelled', id);
    return { job: present(job) };
  });

  app.get('/api/artifacts/:id', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const a = db.get<{ path: string; name: string; kind: string }>('SELECT path, name, kind FROM artifacts WHERE id = ?', id);
    if (!a || !existsSync(a.path)) throw notFound('The file');
    reply.header('Content-Type', a.name.toLowerCase().endsWith('.png') ? 'image/png' : 'application/octet-stream');
    reply.header('Cache-Control', 'private, max-age=86400');
    if (a.kind !== 'screenshot') reply.header('Content-Disposition', `attachment; filename="${a.name.replace(/"/g, '')}"`);
    return reply.send(createReadStream(a.path));
  });

  /** Numbers for the dashboard home page. */
  app.get('/api/stats', { preHandler: requireRole('viewer') }, async () => {
    const today = db.get<{ total: number; succeeded: number; failed: number; running: number }>(
      `SELECT COUNT(*) AS total, SUM(status = 'succeeded') AS succeeded, SUM(status = 'failed') AS failed,
              SUM(status IN ('queued', 'running')) AS running
         FROM jobs WHERE queued_at >= date('now', 'localtime', 'start of day', 'utc')`,
    );
    const week = db.get<{ total: number; succeeded: number }>(
      `SELECT COUNT(*) AS total, SUM(status = 'succeeded') AS succeeded FROM jobs
        WHERE finished_at >= datetime('now', '-7 days') AND status IN ('succeeded', 'failed')`,
    );
    const saved = db.get<{ minutes: number | null }>(
      `SELECT SUM(f.minutes_saved) AS minutes FROM jobs j JOIN flows f ON f.id = j.flow_id
        WHERE j.status = 'succeeded' AND j.finished_at >= datetime('now', '-30 days')`,
    );
    const daily = db.all<{ day: string; succeeded: number; failed: number }>(
      `SELECT date(finished_at, 'localtime') AS day, SUM(status = 'succeeded') AS succeeded, SUM(status = 'failed') AS failed
         FROM jobs WHERE finished_at >= datetime('now', '-14 days') GROUP BY day ORDER BY day`,
    );
    const robots = db.all<{ id: string; enabled: number }>('SELECT id, enabled FROM robots');
    return {
      today: { total: today?.total ?? 0, succeeded: today?.succeeded ?? 0, failed: today?.failed ?? 0, active: today?.running ?? 0 },
      successRate7d: week?.total ? (week.succeeded ?? 0) / week.total : null,
      hoursSaved30d: Math.round(((saved?.minutes ?? 0) / 60) * 10) / 10,
      daily,
      robots: {
        total: robots.length,
        online: robots.filter((r) => gateway.isOnline(r.id)).length,
        busy: robots.filter((r) => gateway.busyJob(r.id)).length,
      },
    };
  });

  /** Live updates for the dashboard (Server-Sent Events). */
  app.get('/api/live', { preHandler: requireRole('viewer') }, async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');
    const off = bus.subscribe((event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    request.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
    return reply;
  });
}
