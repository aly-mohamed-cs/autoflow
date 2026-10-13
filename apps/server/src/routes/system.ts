import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { VERSION } from '../app.js';
import { requireRole } from '../auth/sessions.js';
import { now } from '../db.js';
import { newId, newToken } from '../security.js';
import { notFound } from '../services/core.js';
import { serverHealth } from '../services/health.js';

const ApiKeyBody = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.enum(['viewer', 'operator']).default('operator'),
  days: z.number().int().min(1).max(3650).nullable().default(365),
});
const NoticeBody = z.object({
  message: z.string().trim().min(1).max(1000),
  tone: z.enum(['info', 'warning']).default('info'),
  until: z.string().datetime({ offset: true }).nullable().default(null),
});

export async function systemRoutes(app: FastifyInstance) {
  const { db, audit } = app.svc;
  const actor = (r: { user?: { id: string; username: string } }) => ({ id: r.user!.id, name: r.user!.username });

  // -- API keys: other systems start runs and add queue items -------------------------------

  app.get('/api/api-keys', { preHandler: requireRole('admin') }, async () => ({
    keys: db
      .all<{ id: string; name: string; key_hint: string; role: string; created_by: string | null; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null }>(
        'SELECT id, name, key_hint, role, created_by, created_at, expires_at, last_used_at, revoked_at FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC',
      )
      .map((k) => ({ id: k.id, name: k.name, hint: k.key_hint, role: k.role, createdBy: k.created_by, createdAt: k.created_at, expiresAt: k.expires_at, lastUsedAt: k.last_used_at, revoked: !!k.revoked_at })),
  }));

  app.post('/api/api-keys', { preHandler: requireRole('admin') }, async (request) => {
    const body = ApiKeyBody.parse(request.body);
    const { token, hash } = newToken('afk');
    const id = newId('key');
    const expires = body.days ? new Date(Date.now() + body.days * 86_400_000).toISOString() : null;
    db.run(
      'INSERT INTO api_keys (id, name, key_hash, key_hint, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      body.name,
      hash,
      `afk_…${token.slice(-4)}`,
      body.role,
      request.user!.displayName,
      now(),
      expires,
    );
    audit.record(actor(request), 'api_key.created', id, { name: body.name, role: body.role, expiresAt: expires });
    return { id, key: token }; // shown once
  });

  app.delete('/api/api-keys/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    if (!db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id).changes) throw notFound('The API key');
    audit.record(actor(request), 'api_key.revoked', id);
    return { ok: true };
  });

  // -- notices for everyone who uses Autoflow --------------------------------------------------

  const present = (n: { id: string; message: string; tone: string; until: string | null; created_by: string | null; created_at: string }) => ({
    id: n.id,
    message: n.message,
    tone: n.tone,
    until: n.until,
    createdBy: n.created_by,
    createdAt: n.created_at,
  });

  app.get('/api/notices', { preHandler: requireRole('viewer') }, async (request) => {
    const { all } = request.query as { all?: string };
    const rows =
      all && request.user!.role === 'admin'
        ? db.all<any>('SELECT * FROM notices ORDER BY created_at DESC LIMIT 100')
        : db.all<any>('SELECT * FROM notices WHERE until IS NULL OR until > ? ORDER BY created_at DESC LIMIT 10', now());
    return { notices: rows.map(present) };
  });

  app.post('/api/notices', { preHandler: requireRole('admin') }, async (request) => {
    const body = NoticeBody.parse(request.body);
    const id = newId('ntc');
    db.run('INSERT INTO notices (id, message, tone, until, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, body.message, body.tone, body.until ? new Date(body.until).toISOString() : null, request.user!.displayName, now());
    audit.record(actor(request), 'notice.created', id, { message: body.message.slice(0, 200) });
    return { id };
  });

  app.delete('/api/notices/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    if (!db.run('DELETE FROM notices WHERE id = ?', id).changes) throw notFound('The notice');
    audit.record(actor(request), 'notice.deleted', id);
    return { ok: true };
  });

  // -- server health ---------------------------------------------------------------------------

  app.get('/api/server-health', { preHandler: requireRole('admin') }, async () => serverHealth(app.svc, VERSION));
}
