import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_LDAP, LdapError, ldapAuthenticate, type LdapSettings } from '../auth/ldap.js';
import { ROLE_LABELS } from '../auth/roles.js';
import { createSession, deleteSession, SESSION_COOKIE, sessionToken } from '../auth/sessions.js';
import { now } from '../db.js';
import { hashPassword, hashToken, newId, newToken, verifyPassword } from '../security.js';
import { HttpError } from '../services/core.js';

const LoginBody = z.object({ username: z.string().trim().min(1).max(200), password: z.string().max(500), client: z.string().max(100).optional() });
const CodeBody = z.object({
  ticket: z.string().min(10).max(200),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email.'),
  client: z.string().max(100).optional(),
});

/** Two-step sign-in: after the password, a code sent by email (for administrators, or for everyone). */
export interface SignInSettings {
  codes: 'off' | 'admins' | 'everyone';
}
export const DEFAULT_SIGNIN: SignInSettings = { codes: 'off' };
const CODE_MINUTES = 10;
const CODE_TRIES = 5;

/** m***@company.com: enough to recognise the address, not to harvest it. */
export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name!.slice(0, 1)}***@${domain ?? ''}`;
}

const SetupBody = z.object({ username: z.string().trim().min(2).max(64), displayName: z.string().trim().min(1).max(100), password: z.string().min(10).max(500) });

export async function authRoutes(app: FastifyInstance) {
  const { db, settings, audit, config, mailer } = app.svc;

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
    const user = db.get<{ disabled: number; role: string; email: string | null }>('SELECT disabled, role, email FROM users WHERE id = ?', userId)!;
    if (user.disabled) throw new HttpError(403, 'Your Autoflow account is disabled.');

    const { codes } = settings.get<SignInSettings>('signin', DEFAULT_SIGNIN);
    if (codes === 'everyone' || (codes === 'admins' && user.role === 'admin')) {
      if (!user.email) {
        audit.record({ id: userId, name: username }, 'auth.denied', undefined, { reason: 'no email for the sign-in code' });
        throw new HttpError(403, 'Signing in needs a code sent to your email, but your account has no email address. Ask an administrator to add it.');
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const { token: ticket, hash } = newToken('afl');
      db.run('DELETE FROM login_codes WHERE user_id = ? OR expires_at < ?', userId, now()); // one waiting code per person
      db.run(
        'INSERT INTO login_codes (ticket_hash, user_id, code_hash, client, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        hash,
        userId,
        hashToken(`${ticket}:${code}`),
        client ?? 'dashboard',
        new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
        now(),
      );
      try {
        await mailer.send({
          to: user.email,
          subject: `Your Autoflow sign-in code: ${code}`,
          text:
            `Your Autoflow sign-in code is ${code}. It works for ${CODE_MINUTES} minutes.\n\n` +
            "If you didn't just try to sign in to Autoflow, tell your administrator: someone may know your password.",
        });
      } catch (err) {
        db.run('DELETE FROM login_codes WHERE ticket_hash = ?', hash);
        request.log.error(err, 'sending the sign-in code failed');
        throw new HttpError(503, 'Could not send the sign-in code by email. Try again, or contact your administrator.');
      }
      audit.record({ id: userId, name: username }, 'auth.code_sent', undefined, { client: client ?? 'dashboard' });
      return { twoFactor: true, ticket, sentTo: maskEmail(user.email) };
    }
    return signIn(userId, username, client ?? 'dashboard', reply);
  });

  /** Second step: the code from the email. */
  app.post('/api/auth/login/code', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { ticket, code, client } = CodeBody.parse(request.body);
    const hash = hashToken(ticket);
    const row = db.get<{ user_id: string; code_hash: string; client: string; attempts: number; expires_at: string }>('SELECT * FROM login_codes WHERE ticket_hash = ?', hash);
    if (!row || row.expires_at < now()) {
      if (row) db.run('DELETE FROM login_codes WHERE ticket_hash = ?', hash);
      throw new HttpError(401, 'The code has expired. Sign in again to get a new one.');
    }
    const expected = Buffer.from(row.code_hash, 'hex');
    const given = Buffer.from(hashToken(`${ticket}:${code}`), 'hex');
    const username = db.get<{ username: string }>('SELECT username FROM users WHERE id = ?', row.user_id)?.username ?? row.user_id;
    if (!timingSafeEqual(expected, given)) {
      const tries = row.attempts + 1;
      if (tries >= CODE_TRIES) db.run('DELETE FROM login_codes WHERE ticket_hash = ?', hash);
      else db.run('UPDATE login_codes SET attempts = ? WHERE ticket_hash = ?', tries, hash);
      audit.record({ id: row.user_id, name: username }, 'auth.code_failed', undefined, { tries });
      throw new HttpError(401, tries >= CODE_TRIES ? 'Too many wrong codes. Sign in again to get a new one.' : 'That code is not right. Check the newest email.');
    }
    db.run('DELETE FROM login_codes WHERE ticket_hash = ?', hash);
    const user = db.get<{ disabled: number }>('SELECT disabled FROM users WHERE id = ?', row.user_id);
    if (!user || user.disabled) throw new HttpError(403, 'Your Autoflow account is disabled.');
    return signIn(row.user_id, username, client ?? row.client, reply, true);
  });

  function signIn(userId: string, username: string, client: string, reply: FastifyReply, withCode = false) {
    const token = createSession(db, userId, config.sessionHours, client);
    audit.record({ id: userId, name: username }, 'auth.login', undefined, { client, ...(withCode ? { code: true } : {}) });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    // Studio keeps the token (encrypted) and sends it as a Bearer token.
    return { token, user: me(userId) };
  }

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
