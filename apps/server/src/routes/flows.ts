import { walkFlow, type Flow } from '@autoflow/flow-types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/sessions.js';
import { json, now } from '../db.js';
import { badRequest, notFound } from '../services/core.js';
import { present, type JobRow } from '../services/jobs.js';
import { publishVersion } from '../services/versions.js';

const FlowDoc = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5000).optional(),
    steps: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const PublishBody = z.object({ flow: FlowDoc, notes: z.string().max(2000).optional() });
const RunBody = z.object({
  inputs: z.record(z.string(), z.unknown()).optional(),
  version: z.number().int().positive().optional(),
  pool: z.string().max(64).optional(),
  /** Studio's quick-launch hotkeys mark their runs so history shows how they started. */
  trigger: z.enum(['manual', 'hotkey']).optional(),
});
const PatchBody = z.object({
  minutesSaved: z.number().min(0).max(100_000).optional(),
  archived: z.boolean().optional(),
  /** Let robots ask the AI assistant to fix failed steps of this automation. */
  aiRepair: z.boolean().optional(),
});

interface FlowRow {
  id: string;
  name: string;
  description: string;
  latest_version: number;
  minutes_saved: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived: number;
  ai_repair: number;
}

/** Names of saved credentials a flow uses (robots may only fetch these). */
export function credentialNames(flow: Flow): string[] {
  const names = new Set<string>();
  for (const { step } of walkFlow(flow)) {
    const c = step.params?.credential;
    if (typeof c === 'string' && c.trim() && !c.includes('{{')) names.add(c.trim());
  }
  return [...names];
}

export function inputVariables(flow: Flow) {
  return (flow.variables ?? [])
    .filter((v) => v.is_input)
    .map((v) => ({ name: v.name, type: v.type ?? 'any', description: v.description ?? '', default: v.default ?? null, sensitive: !!v.sensitive }));
}

export async function flowRoutes(app: FastifyInstance) {
  const { db, jobs, audit, repairs } = app.svc;
  const actor = (r: { user?: { id: string; username: string } }) => ({ id: r.user!.id, name: r.user!.username });

  app.get('/api/flows', { preHandler: requireRole('viewer') }, async (request) => {
    const { archived } = request.query as { archived?: string };
    const rows = db.all<FlowRow & { last_job: string | null; schedules: number; pending_fixes: number }>(
      `SELECT f.*,
         (SELECT json_object('id', j.id, 'status', j.status, 'queuedAt', j.queued_at, 'finishedAt', j.finished_at)
            FROM jobs j WHERE j.flow_id = f.id ORDER BY j.queued_at DESC LIMIT 1) AS last_job,
         (SELECT COUNT(*) FROM schedules s WHERE s.flow_id = f.id AND s.enabled = 1) AS schedules,
         (SELECT COUNT(*) FROM repair_suggestions x WHERE x.flow_id = f.id AND x.status = 'pending') AS pending_fixes
       FROM flows f WHERE f.archived = ? ORDER BY f.name COLLATE NOCASE`,
      archived === 'true' ? 1 : 0,
    );
    return { flows: rows.map((r) => ({ ...presentFlow(r), lastJob: json(r.last_job, null), activeSchedules: r.schedules, pendingFixes: r.pending_fixes })) };
  });

  app.get('/api/flows/:id', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    const flow = db.get<FlowRow>('SELECT * FROM flows WHERE id = ?', id);
    if (!flow) throw notFound('The automation');
    const versions = db.all<{ version: number; notes: string; published_by: string | null; published_at: string }>(
      'SELECT version, notes, published_by, published_at FROM flow_versions WHERE flow_id = ? ORDER BY version DESC',
      id,
    );
    const latest = db.get<{ definition: string }>('SELECT definition FROM flow_versions WHERE flow_id = ? AND version = ?', id, flow.latest_version);
    const definition = latest ? (JSON.parse(latest.definition) as Flow) : null;
    const stats = db.get<{ runs: number; succeeded: number; avg_ms: number | null }>(
      `SELECT COUNT(*) AS runs, SUM(status = 'succeeded') AS succeeded, AVG(duration_ms) AS avg_ms
         FROM jobs WHERE flow_id = ? AND finished_at >= datetime('now', '-30 days')`,
      id,
    );
    return {
      flow: presentFlow(flow),
      versions: versions.map((v) => ({ version: v.version, notes: v.notes, publishedBy: v.published_by, publishedAt: v.published_at })),
      definition,
      inputs: definition ? inputVariables(definition) : [],
      credentials: definition ? credentialNames(definition) : [],
      stats: { runs30d: stats?.runs ?? 0, succeeded30d: stats?.succeeded ?? 0, avgDurationMs: stats?.avg_ms ?? null },
      fixes: repairs.list(id),
    };
  });

  app.get('/api/flows/:id/versions/:version', { preHandler: requireRole('viewer') }, async (request) => {
    const { id, version } = request.params as { id: string; version: string };
    const row = db.get<{ definition: string }>('SELECT definition FROM flow_versions WHERE flow_id = ? AND version = ?', id, Number(version));
    if (!row) throw notFound('That version');
    return { definition: JSON.parse(row.definition) };
  });

  /** Studio publishes a new version. Versions are immutable; runs always use a fixed version. */
  app.post('/api/flows/:id/versions', { preHandler: requireRole('builder') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = PublishBody.parse(request.body);
    if (body.flow.id !== id) throw badRequest('The automation id does not match the address.');
    const user = request.user!;
    const version = publishVersion(db, body.flow as unknown as Flow, body.notes ?? '', user.displayName);
    audit.record({ id: user.id, name: user.username }, 'flow.published', id, { version, name: body.flow.name });
    return { version };
  });

  app.patch('/api/flows/:id', { preHandler: requireRole('builder') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = PatchBody.parse(request.body);
    if (!db.get('SELECT 1 FROM flows WHERE id = ?', id)) throw notFound('The automation');
    if (body.minutesSaved !== undefined) db.run('UPDATE flows SET minutes_saved = ? WHERE id = ?', body.minutesSaved, id);
    if (body.archived !== undefined) db.run('UPDATE flows SET archived = ? WHERE id = ?', body.archived ? 1 : 0, id);
    if (body.aiRepair !== undefined) db.run('UPDATE flows SET ai_repair = ? WHERE id = ?', body.aiRepair ? 1 : 0, id);
    audit.record({ id: request.user!.id, name: request.user!.username }, 'flow.updated', id, body);
    return { ok: true };
  });

  /** A builder keeps an AI fix from a robot run: it becomes the next version. */
  app.post('/api/fixes/:id/approve', { preHandler: requireRole('builder') }, async (request) => {
    const { id } = request.params as { id: string };
    const result = repairs.approve(id, request.user!.displayName);
    audit.record(actor(request), 'flow.fix_approved', result.flowId, { fix: id, version: result.version });
    return result;
  });

  app.post('/api/fixes/:id/dismiss', { preHandler: requireRole('builder') }, async (request) => {
    const { id } = request.params as { id: string };
    const result = repairs.dismiss(id, request.user!.displayName);
    audit.record(actor(request), 'flow.fix_dismissed', result.flowId, { fix: id });
    return { ok: true };
  });

  app.post('/api/flows/:id/run', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = RunBody.parse(request.body ?? {});
    const user = request.user!;
    const job = jobs.create({
      flowId: id,
      version: body.version,
      trigger: body.trigger ?? 'manual',
      triggeredBy: body.trigger === 'hotkey' ? `${user.displayName} (hotkey)` : user.displayName,
      inputs: body.inputs,
      pool: body.pool,
    });
    audit.record({ id: user.id, name: user.username }, 'job.started', job.id, { flowId: id });
    return { job: present(job as JobRow) };
  });
}

function presentFlow(r: FlowRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    latestVersion: r.latest_version,
    minutesSaved: r.minutes_saved,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archived: !!r.archived,
    aiRepair: !!r.ai_repair,
  };
}
