import type { FastifyInstance } from 'fastify';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_LDAP, LdapError, ldapAuthenticate, type LdapSettings } from '../auth/ldap.js';
import { ROLE_LABELS, ROLES } from '../auth/roles.js';
import { requireRole } from '../auth/sessions.js';
import { json, now } from '../db.js';
import { hashPassword, newId } from '../security.js';
import { HttpError, notFound } from '../services/core.js';
import { ownCertificate } from '../services/health.js';
import { SmtpBody, type SmtpSettings } from '../services/mailer.js';
import { DEFAULT_SIGNIN, type SignInSettings } from './auth.js';

const CredentialBody = z.object({
  name: z.string().trim().min(1).max(100),
  username: z.string().max(200).default(''),
  password: z.string().max(2000).optional(),
  description: z.string().max(500).default(''),
});
const Email = z.string().trim().max(200).email('Enter a valid email address.');
const UserPatch = z.object({
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(10).max(500).optional(),
  email: Email.or(z.literal('')).optional(),
});
const SignInBody = z.object({ codes: z.enum(['off', 'admins', 'everyone']), smtp: SmtpBody });
const LocalUser = z.object({
  username: z.string().trim().min(2).max(64).regex(/^[\w.@-]+$/),
  displayName: z.string().trim().min(1).max(100),
  role: z.enum(ROLES),
  password: z.string().min(10).max(500),
  email: Email.or(z.literal('')).default(''),
});
const roleList = z.array(z.string().trim().min(1)).default([]);
const LdapBody = z.object({
  enabled: z.boolean(),
  url: z.string().trim().max(300),
  domain: z.string().trim().max(200),
  baseDn: z.string().trim().max(500),
  startTls: z.boolean().default(false),
  allowInvalidCert: z.boolean().default(false),
  groupRoles: z.object({ admin: roleList, builder: roleList, operator: roleList, viewer: roleList }),
  defaultRole: z.enum(ROLES).nullable(),
});

export async function adminRoutes(app: FastifyInstance) {
  const { db, vault, settings, audit, config, mailer } = app.svc;
  const actor = (r: { user?: { id: string; username: string } }) => ({ id: r.user!.id, name: r.user!.username });

  // -- credentials (vault) ---------------------------------------------------------------

  app.get('/api/credentials', { preHandler: requireRole('builder') }, async () => ({
    credentials: db
      .all<{ name: string; username: string; description: string; updated_by: string | null; updated_at: string }>(
        'SELECT name, username, description, updated_by, updated_at FROM credentials ORDER BY name',
      )
      .map((c) => ({ name: c.name, username: c.username, description: c.description, updatedBy: c.updated_by, updatedAt: c.updated_at })),
  }));

  app.put('/api/credentials', { preHandler: requireRole('builder') }, async (request) => {
    const body = CredentialBody.parse(request.body);
    const existing = db.get<{ secret: string }>('SELECT secret FROM credentials WHERE name = ?', body.name);
    if (!existing && !body.password) throw new HttpError(400, 'Enter a password for the new credential.');
    const secret = body.password ? vault.encrypt(body.password) : existing!.secret;
    db.run(
      `INSERT INTO credentials (name, username, secret, description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET username = excluded.username, secret = excluded.secret,
         description = excluded.description, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      body.name,
      body.username,
      secret,
      body.description,
      request.user!.displayName,
      now(),
    );
    audit.record(actor(request), existing ? 'credential.updated' : 'credential.created', body.name, { passwordChanged: !!body.password });
    return { ok: true };
  });

  app.delete('/api/credentials/:name', { preHandler: requireRole('builder') }, async (request) => {
    const { name } = request.params as { name: string };
    db.run('DELETE FROM credentials WHERE name = ?', name);
    audit.record(actor(request), 'credential.deleted', name);
    return { ok: true };
  });

  // -- users -------------------------------------------------------------------------------

  app.get('/api/users', { preHandler: requireRole('admin') }, async () => ({
    users: db
      .all<{ id: string; username: string; display_name: string; email: string | null; role: keyof typeof ROLE_LABELS; source: string; disabled: number; created_at: string; last_login_at: string | null }>(
        'SELECT id, username, display_name, email, role, source, disabled, created_at, last_login_at FROM users ORDER BY display_name COLLATE NOCASE',
      )
      .map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        email: u.email,
        role: u.role,
        roleLabel: ROLE_LABELS[u.role],
        source: u.source,
        disabled: !!u.disabled,
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
      })),
  }));

  app.post('/api/users', { preHandler: requireRole('admin') }, async (request) => {
    const body = LocalUser.parse(request.body);
    if (db.get('SELECT 1 FROM users WHERE username = ?', body.username)) throw new HttpError(409, 'That username is taken.');
    const id = newId('usr');
    db.run(
      `INSERT INTO users (id, username, display_name, email, role, source, password_hash, created_at) VALUES (?, ?, ?, ?, ?, 'local', ?, ?)`,
      id,
      body.username,
      body.displayName,
      body.email || null,
      body.role,
      hashPassword(body.password),
      now(),
    );
    audit.record(actor(request), 'user.created', id, { username: body.username, role: body.role });
    return { id };
  });

  app.patch('/api/users/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = UserPatch.parse(request.body);
    const user = db.get<{ source: string; role: string }>('SELECT source, role FROM users WHERE id = ?', id);
    if (!user) throw notFound('The user');
    if (id === request.user!.id && (body.disabled || (body.role && body.role !== 'admin'))) {
      throw new HttpError(400, "You can't remove your own administrator access.");
    }
    if (body.role) db.run('UPDATE users SET role = ? WHERE id = ?', body.role, id);
    if (body.disabled !== undefined) {
      db.run('UPDATE users SET disabled = ? WHERE id = ?', body.disabled ? 1 : 0, id);
      if (body.disabled) db.run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    if (body.email !== undefined) {
      if (user.source !== 'local') throw new HttpError(400, "Directory users' email addresses come from Active Directory.");
      db.run('UPDATE users SET email = ? WHERE id = ?', body.email || null, id);
    }
    if (body.password) {
      if (user.source !== 'local') throw new HttpError(400, 'Directory users change their password in Windows.');
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.password), id);
      db.run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    audit.record(actor(request), 'user.updated', id, { role: body.role, disabled: body.disabled, passwordReset: !!body.password, emailChanged: body.email !== undefined });
    return { ok: true };
  });

  // -- directory (LDAP) settings -----------------------------------------------------------

  app.get('/api/settings/ldap', { preHandler: requireRole('admin') }, async () => ({ ldap: settings.get<LdapSettings>('ldap', DEFAULT_LDAP) }));

  app.put('/api/settings/ldap', { preHandler: requireRole('admin') }, async (request) => {
    const body = LdapBody.parse(request.body);
    if (body.enabled && (!body.url || !body.domain || !body.baseDn)) {
      throw new HttpError(400, 'Fill in the server address, domain and search base to turn on directory sign-in.');
    }
    settings.set('ldap', body);
    audit.record(actor(request), 'settings.ldap_updated', undefined, { enabled: body.enabled, url: body.url });
    return { ok: true };
  });

  /** Try a sign-in with the given settings and show which role it would get. */
  app.post('/api/settings/ldap/test', { preHandler: requireRole('admin') }, async (request) => {
    const body = z.object({ settings: LdapBody, username: z.string().min(1), password: z.string().min(1) }).parse(request.body);
    try {
      const user = await ldapAuthenticate(body.settings, body.username, body.password);
      return { ok: true, user: { ...user, groups: user.groups.slice(0, 50) } };
    } catch (err) {
      return { ok: false, error: err instanceof LdapError ? err.message : `Could not connect: ${(err as Error).message}` };
    }
  });

  // -- two-step sign-in (codes by email) and the mail server -------------------------------

  const signInView = () => {
    const smtp = mailer.config();
    const { codes } = settings.get<SignInSettings>('signin', DEFAULT_SIGNIN);
    const withoutEmail = db.all<{ display_name: string; role: string }>(
      `SELECT display_name, role FROM users WHERE disabled = 0 AND (email IS NULL OR email = '') ORDER BY display_name COLLATE NOCASE`,
    );
    return { codes, smtp: { ...smtp, password: '', hasPassword: !!smtp.password }, withoutEmail: withoutEmail.map((u) => ({ displayName: u.display_name, role: u.role })) };
  };

  app.get('/api/settings/signin', { preHandler: requireRole('admin') }, async () => signInView());

  app.put('/api/settings/signin', { preHandler: requireRole('admin') }, async (request) => {
    const body = SignInBody.parse(request.body);
    const before = mailer.config();
    const smtp: SmtpSettings = {
      ...body.smtp,
      password: body.smtp.password === undefined ? before.password : body.smtp.password ? vault.encrypt(body.smtp.password) : '',
    };
    if (body.codes !== 'off') {
      if (!smtp.host || !smtp.from) throw new HttpError(400, 'Set up the mail server first, and send a test email.');
      const self = db.get<{ email: string | null }>('SELECT email FROM users WHERE id = ?', request.user!.id);
      if (!self?.email) throw new HttpError(400, 'Add your own email address first (Users), so you can still sign in.');
    }
    settings.set('smtp', smtp);
    settings.set('signin', { codes: body.codes } satisfies SignInSettings);
    audit.record(actor(request), 'settings.signin_updated', undefined, { codes: body.codes, smtpHost: smtp.host });
    return signInView();
  });

  /** Send a test email to the signed-in administrator (with the saved mail server settings). */
  app.post('/api/settings/signin/test', { preHandler: requireRole('admin'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const self = db.get<{ email: string | null }>('SELECT email FROM users WHERE id = ?', request.user!.id);
    if (!self?.email) throw new HttpError(400, 'Add your own email address first (Users).');
    try {
      await mailer.send({ to: self.email, subject: 'Autoflow test email', text: 'The Orchestrator can send email: sign-in codes will arrive like this one.' });
      return { ok: true, sentTo: self.email };
    } catch (err) {
      return { ok: false, error: `Could not send: ${(err as Error).message}` };
    }
  });

  // -- audit log & downloads ---------------------------------------------------------------

  app.get('/api/audit', { preHandler: requireRole('admin') }, async (request) => {
    const { before } = request.query as { before?: string };
    const rows = db.all<{ id: number; ts: string; actor: string; action: string; target: string | null; details: string }>(
      `SELECT id, ts, actor, action, target, details FROM audit ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT 200`,
      ...(before ? [Number(before)] : []),
    );
    return { entries: rows.map((r) => ({ ...r, details: json(r.details, {}) })) };
  });

  /** Address and certificate fingerprint shown when adding a robot (to verify a self-signed certificate). */
  let fingerprint: string | null | undefined;
  app.get('/api/server-info', { preHandler: requireRole('viewer') }, async () => {
    if (fingerprint === undefined) fingerprint = config.tls ? ((await ownCertificate(config.port))?.fingerprint ?? null) : null;
    return { publicUrl: config.publicUrl, fingerprint };
  });

  app.get('/api/downloads', { preHandler: requireRole('viewer') }, async () => {
    const dir = join(config.dataDir, 'installers');
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => /\.(exe|msi|zip)$/i.test(f));
    } catch {
      /* no installers yet */
    }
    return {
      files: files
        .map((name) => {
          const stat = statSync(join(dir, name));
          return { name, size: stat.size, modified: stat.mtime.toISOString(), url: `/downloads/${encodeURIComponent(name)}` };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified)),
    };
  });
}
