import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_LDAP, LdapError, ldapAuthenticate, type LdapSettings } from '../auth/ldap.js';
import { ROLE_LABELS } from '../auth/roles.js';
import { createSession, deleteSession, SESSION_COOKIE, sessionToken } from '../auth/sessions.js';
import { now } from '../db.js';
import { hashPassword, newId, verifyPassword } from '../security.js';
import { HttpError } from '../services/core.js';

const LoginBody = z.object({ username: z.string().trim().min(1).max(200), password: z.string().max(500), client: z.string().max(100).optional() });
const SetupBody = z.object({ username: z.string().trim().min(2).max(64), displayName: z.string().trim().min(1).max(100), password: z.string().min(10).max(500) });

export async function authRoutes(app: FastifyInstance) {
  const { db, settings, audit, config } = app.svc;

  const cookieOptions = () => ({
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: !config.insecureHttp,
    maxAge: config.sessionHours * 3600,
  });

  app.get('/api/setup/status', async () => ({
    needsSetup: !db.get('SELECT 1 FROM users LIMIT 1'),
    ldapEnabled: settings.get<LdapSettings>('ldap', DEFAULT_LDAP).enabled,
  }));

  /** First run only: create the break-glass administrator. */
  app.post('/api/setup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = SetupBody.parse(request.body);
    const id = newId('usr');
    const created = db.tx(() => {
      if (db.get('SELECT 1 FROM users LIMIT 1')) return false;
      db.run(
        `INSERT INTO users (id, username, display_name, role, source, password_hash, created_at) VALUES (?, ?, ?, 'admin', 'local', ?, ?)`,
        id,
        body.username,
        body.displayName,
        hashPassword(body.password),
        now(),
      );
      return true;
    });
    if (!created) throw new HttpError(409, 'Autoflow is already set up.');
    audit.record({ id, name: body.username }, 'setup.admin_created');
    const token = createSession(db, id, config.sessionHours, 'dashboard');
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { username, password, client } = LoginBody.parse(request.body);
    const local = db.get<{ id: string; password_hash: string | null; disabled: number; source: string }>(
      'SELECT id, password_hash, disabled, source FROM users WHERE username = ?',
      username,
    );
    let userId: string | null = null;
    if (local?.source === 'local') {
      if (!local.disabled && verifyPassword(password, local.password_hash)) userId = local.id;
    } else {
      const ldap = settings.get<LdapSettings>('ldap', DEFAULT_LDAP);
      if (ldap.enabled) {
        try {
          const found = await ldapAuthenticate(ldap, username, password);
          if (!found.role) {
            audit.record({ name: username }, 'auth.denied', undefined, { reason: 'no matching group' });
            throw new HttpError(403, "You don't have access to Autoflow yet. Ask your administrator to add you to an Autoflow group.");
          }
          userId = upsertLdapUser(found);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          if (err instanceof LdapError) {
            audit.record({ name: username }, 'auth.failed');
            throw new HttpError(401, err.message);
          }
          request.log.error(err, 'LDAP sign-in failed');
          throw new HttpError(503, 'Could not reach the company directory. Try again, or contact your administrator.');
        }
      }
    }
    if (!userId) {
      audit.record({ name: username }, 'auth.failed');
      throw new HttpError(401, 'Wrong username or password.');
    }
    const disabled = db.get<{ disabled: number }>('SELECT disabled FROM users WHERE id = ?', userId)?.disabled;
    if (disabled) throw new HttpError(403, 'Your Autoflow account is disabled.');
    const token = createSession(db, userId, config.sessionHours, client ?? 'dashboard');
    audit.record({ id: userId, name: username }, 'auth.login', undefined, { client: client ?? 'dashboard' });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    // Studio keeps the token (encrypted) and sends it as a Bearer token.
    return { token, user: me(userId) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = sessionToken(request);
    if (token) deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Please sign in.' });
    if (request.user.apiKey) {
      const { id, username, displayName, role } = request.user;
      return { user: { id, username, displayName, email: null, role, roleLabel: ROLE_LABELS[role], source: 'api' } };
    }
    return { user: me(request.user.id) };
  });

  function me(userId: string) {
    const u = db.get<{ id: string; username: string; display_name: string; email: string | null; role: keyof typeof ROLE_LABELS; source: string }>(
      'SELECT id, username, display_name, email, role, source FROM users WHERE id = ?',
      userId,
    )!;
    return { id: u.id, username: u.username, displayName: u.display_name, email: u.email, role: u.role, roleLabel: ROLE_LABELS[u.role], source: u.source };
  }

  function upsertLdapUser(found: { username: string; displayName: string; email: string | null; role: string | null }): string {
    const existing = db.get<{ id: string }>('SELECT id FROM users WHERE username = ?', found.username);
    if (existing) {
      // The directory is the source of truth for LDAP users' roles.
      db.run('UPDATE users SET display_name = ?, email = ?, role = ? WHERE id = ?', found.displayName, found.email, found.role, existing.id);
      return existing.id;
    }
    const id = newId('usr');
    db.run(
      `INSERT INTO users (id, username, display_name, email, role, source, created_at) VALUES (?, ?, ?, ?, ?, 'ldap', ?)`,
      id,
      found.username,
      found.displayName,
      found.email,
      found.role,
      now(),
    );
    return id;
  }
}
