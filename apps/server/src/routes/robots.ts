import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { requireRole } from '../auth/sessions.js';
import { json, now } from '../db.js';
import { hashToken, newId, newToken } from '../security.js';
import { HttpError, notFound } from '../services/core.js';
import type { RepairRequest } from '../services/ai.js';
import { compareVersions } from '../services/robotReleases.js';
import { RepairBody } from './ai.js';
import { credentialNames } from './flows.js';

const EnrollBody = z.object({
  key: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(100),
  machine: z.string().max(200).optional(),
});
const KeyBody = z.object({ pool: z.string().trim().min(1).max(64).default('default'), hours: z.number().min(1).max(24 * 30).default(24) });
const UpdateSettingsBody = z.object({ automatic: z.boolean() });

/** Robots install new versions from the Orchestrator's Downloads by themselves unless turned off. */
export interface RobotUpdateSettings {
  automatic: boolean;
}
export const DEFAULT_ROBOT_UPDATES: RobotUpdateSettings = { automatic: true };

const PatchBody = z.object({ name: z.string().trim().min(1).max(100).optional(), pool: z.string().trim().min(1).max(64).optional(), enabled: z.boolean().optional() });

interface RobotRow {
  id: string;
  name: string;
  machine: string;
  pool: string;
  capabilities: string;
  version: string;
  enabled: number;
  enrolled_at: string;
  last_seen_at: string | null;
}

export async function robotRoutes(app: FastifyInstance) {
  const { db, gateway, jobs, vault, audit, config, ai, settings, robotReleases } = app.svc;
  const actor = (r: { user?: { id: string; username: string } }) => ({ id: r.user!.id, name: r.user!.username });

  // Allow raw uploads (screenshots, output files) from robots.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  /** Robot requests carry "Authorization: Bearer afr_..." */
  function robotFor(request: FastifyRequest): RobotRow {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer afr_') ? header.slice(7) : null;
    const robot = token ? db.get<RobotRow>('SELECT * FROM robots WHERE token_hash = ?', hashToken(token)) : undefined;
    if (!robot) throw new HttpError(401, 'Unknown robot. Enroll it again from the dashboard.');
    if (!robot.enabled) throw new HttpError(403, 'This robot is disabled.');
    return robot;
  }

  // -- for people -----------------------------------------------------------------------

  app.get('/api/robots', { preHandler: requireRole('viewer') }, async () => {
    const latest = robotReleases.newest()?.version ?? null;
    const rows = db.all<RobotRow & { job_flow: string | null }>(
      `SELECT r.*, (SELECT f.name FROM jobs j JOIN flows f ON f.id = j.flow_id
                     WHERE j.robot_id = r.id AND j.status = 'running' LIMIT 1) AS job_flow
         FROM robots r ORDER BY r.name COLLATE NOCASE`,
    );
    return {
      robots: rows.map((r) => ({
        id: r.id,
        name: r.name,
        machine: r.machine,
        pool: r.pool,
        capabilities: json<string[]>(r.capabilities, []),
        version: r.version,
        enabled: !!r.enabled,
        enrolledAt: r.enrolled_at,
        lastSeenAt: r.last_seen_at,
        online: gateway.isOnline(r.id),
        jobId: gateway.busyJob(r.id),
        jobFlowName: r.job_flow,
        updateAvailable: !!latest && !!r.version && compareVersions(latest, r.version) > 0,
        ...gateway.updateState(r.id),
      })),
      latestVersion: latest,
      automaticUpdates: settings.get<RobotUpdateSettings>('robotUpdates', DEFAULT_ROBOT_UPDATES).automatic,
    };
  });

  app.put('/api/settings/robot-updates', { preHandler: requireRole('admin') }, async (request) => {
    const body = UpdateSettingsBody.parse(request.body);
    settings.set('robotUpdates', body);
    audit.record(actor(request), 'settings.robot_updates', undefined, body);
    return { ok: true };
  });

  /** "Update now": the robot installs the newest version even if automatic updates are off. */
  app.post('/api/robots/:id/update', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    const robot = db.get<RobotRow>('SELECT * FROM robots WHERE id = ?', id);
    if (!robot) throw notFound('The robot');
    const latest = robotReleases.newest();
    if (!latest || (robot.version && compareVersions(latest.version, robot.version) <= 0)) {
      throw new HttpError(409, 'There is no newer robot version on this server. The administrator copies it here with update-server.ps1 -Installers.');
    }
    if (!gateway.requestUpdate(id)) throw new HttpError(409, 'The robot is offline. It updates by itself when it connects again.');
    audit.record(actor(request), 'robot.update_requested', id, { version: latest.version });
    return { ok: true, version: latest.version };
  });

  app.post('/api/robots/enrollment-keys', { preHandler: requireRole('admin') }, async (request) => {
    const body = KeyBody.parse(request.body ?? {});
    const { token, hash } = newToken('afe');
    const expiresAt = new Date(Date.now() + body.hours * 3_600_000).toISOString();
    db.run('INSERT INTO enrollment_keys (key_hash, pool, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', hash, body.pool, request.user!.username, now(), expiresAt);
    audit.record({ id: request.user!.id, name: request.user!.username }, 'robot.key_created', body.pool, { expiresAt });
    return { key: token, expiresAt, serverUrl: config.publicUrl };
  });

  app.patch('/api/robots/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = PatchBody.parse(request.body);
    if (!db.get('SELECT 1 FROM robots WHERE id = ?', id)) throw notFound('The robot');
    if (body.name) db.run('UPDATE robots SET name = ? WHERE id = ?', body.name, id);
    if (body.pool) db.run('UPDATE robots SET pool = ? WHERE id = ?', body.pool, id);
    if (body.enabled !== undefined) {
      db.run('UPDATE robots SET enabled = ? WHERE id = ?', body.enabled ? 1 : 0, id);
      if (!body.enabled) gateway.disconnect(id);
    }
    audit.record({ id: request.user!.id, name: request.user!.username }, 'robot.updated', id, body);
    return { ok: true };
  });

  app.delete('/api/robots/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    gateway.disconnect(id);
    db.run('DELETE FROM robots WHERE id = ?', id);
    audit.record({ id: request.user!.id, name: request.user!.username }, 'robot.removed', id);
    return { ok: true };
  });

  // -- for robots ----------------------------------------------------------------------

  app.post('/api/robot/enroll', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const body = EnrollBody.parse(request.body);
    const keyHash = hashToken(body.key.trim());
    const robotToken = newToken('afr');
    const robotId = newId('rbt');
    const pool = db.tx(() => {
      const key = db.get<{ pool: string; expires_at: string; used_at: string | null }>('SELECT * FROM enrollment_keys WHERE key_hash = ?', keyHash);
      if (!key || key.used_at || key.expires_at < now()) return null;
      db.run('UPDATE enrollment_keys SET used_at = ?, robot_id = ? WHERE key_hash = ?', now(), robotId, keyHash);
      db.run(
        'INSERT INTO robots (id, name, machine, pool, token_hash, enrolled_at) VALUES (?, ?, ?, ?, ?, ?)',
        robotId,
        body.name,
        body.machine ?? '',
        key.pool,
        robotToken.hash,
        now(),
      );
      return key.pool;
    });
    if (!pool) throw new HttpError(403, 'This enrollment key is invalid, expired or already used. Create a new one in the dashboard.');
    audit.record({ name: `robot:${body.name}` }, 'robot.enrolled', robotId, { pool, machine: body.machine });
    return { robotId, token: robotToken.token, pool };
  });

  app.get('/api/robot/connect', { websocket: true }, (socket, request) => {
    let robot: RobotRow;
    try {
      robot = robotFor(request);
    } catch (err) {
      socket.close(4001, (err as Error).message.slice(0, 120));
      return;
    }
    gateway.attach(robot.id, socket);
  });

  /** Passwords for the credentials this run's automation uses — only while the robot runs it. */
  app.get('/api/robot/jobs/:id/credentials', async (request) => {
    const robot = robotFor(request);
    const { id } = request.params as { id: string };
    const job = jobs.get(id);
    if (!job || job.robot_id !== robot.id || job.status !== 'running') throw new HttpError(403, 'Not your job.');
    const names = credentialNames(jobs.definition(job));
    const out: Record<string, { username: string; password: string }> = {};
    for (const name of names) {
      const row = db.get<{ name: string; username: string; secret: string }>('SELECT * FROM credentials WHERE name = ?', name);
      if (row) out[name] = { username: row.username, password: vault.decrypt(row.secret) };
    }
    audit.record({ name: `robot:${robot.name}` }, 'credentials.read', id, { names: Object.keys(out) });
    return { credentials: out };
  });

  /** The newest robot version on this server; robots download it from /downloads/ and check the hash. */
  app.get('/api/robot/update', async (request) => {
    robotFor(request);
    const release = await robotReleases.latest();
    const { automatic } = settings.get<RobotUpdateSettings>('robotUpdates', DEFAULT_ROBOT_UPDATES);
    return release
      ? { version: release.version, url: release.url, size: release.size, sha256: release.sha256, automatic }
      : { version: null, automatic };
  });

  /** AI self-repair during a robot run. The fix only changes this run; builders approve keeping it. */
  app.post('/api/robot/jobs/:id/repair', { bodyLimit: 2 * 1024 * 1024 }, async (request) => {
    const robot = robotFor(request);
    const { id } = request.params as { id: string };
    const job = jobs.get(id);
    if (!job || job.robot_id !== robot.id || job.status !== 'running') throw new HttpError(403, 'Not your job.');
    if (!gateway.repairAllowed(job)) return { fixable: false, explanation: 'AI repair is turned off for this automation.' };
    // Bounded per run so a broken automation can't keep the model server busy.
    const calls = db.run('UPDATE jobs SET repair_calls = repair_calls + 1 WHERE id = ? AND repair_calls < 10', id).changes;
    if (!calls) return { fixable: false, explanation: 'The AI assistant already tried several fixes in this run.' };
    const body = RepairBody.parse(request.body) as RepairRequest;
    const reply = await ai.repairStep(body);
    audit.record({ name: `robot:${robot.name}` }, 'ai.repair', id, { activity: body.activity, step: body.step.id, fixable: reply.fixable });
    return reply;
  });

  app.post('/api/robot/jobs/:id/artifacts', { bodyLimit: 30 * 1024 * 1024 }, async (request) => {
    const robot = robotFor(request);
    const { id } = request.params as { id: string };
    const q = request.query as { name?: string; step_id?: string; kind?: string };
    const job = jobs.get(id);
    if (!job || job.robot_id !== robot.id) throw new HttpError(403, 'Not your job.');
    const name = basename(q.name || 'file.bin').replace(/[^\w.\-]/g, '_').slice(0, 120);
    const dir = join(config.dataDir, 'artifacts', id);
    mkdirSync(dir, { recursive: true });
    const artifactId = newId('art');
    const path = join(dir, `${artifactId}-${name}`);
    await pipeline(request.body as NodeJS.ReadableStream, createWriteStream(path));
    const size = statSync(path).size;
    db.run(
      'INSERT INTO artifacts (id, job_id, step_id, kind, name, path, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      artifactId,
      id,
      q.step_id ?? null,
      q.kind === 'screenshot' ? 'screenshot' : 'file',
      name,
      path,
      size,
      now(),
    );
    return { id: artifactId };
  });
}
