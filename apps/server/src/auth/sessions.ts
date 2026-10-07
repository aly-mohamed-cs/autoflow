import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { now } from '../db.js';
import { hashToken, newToken } from '../security.js';
import { atLeast, type Role } from './roles.js';

export const SESSION_COOKIE = 'af_session';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  source: 'local' | 'ldap';
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export function createSession(db: Db, userId: string, hours: number, client: string): string {
  const { token, hash } = newToken('afs');
  const expires = new Date(Date.now() + hours * 3_600_000).toISOString();
  db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client) VALUES (?, ?, ?, ?, ?)', hash, userId, now(), expires, client.slice(0, 200));
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), userId);
  return token;
}

export function deleteSession(db: Db, token: string): void {
  db.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
}

export function sessionToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer afs_')) return header.slice(7);
  return request.cookies?.[SESSION_COOKIE] ?? null;
}

export function userForToken(db: Db, token: string | null): SessionUser | null {
  if (!token) return null;
  const row = db.get<{
    id: string; username: string; display_name: string; email: string | null; role: Role; source: 'local' | 'ldap'; disabled: number; expires_at: string;
  }>(
    `SELECT u.id, u.username, u.display_name, u.email, u.role, u.source, u.disabled, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    hashToken(token),
  );
  if (!row || row.disabled || row.expires_at < now()) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, email: row.email, role: row.role, source: row.source };
}

/** Route guard: signed in with at least the given role. */
export function requireRole(role: Role) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Please sign in.' });
    }
    if (!atLeast(request.user.role, role)) {
      return reply.code(403).send({ error: "You don't have permission to do this. Ask an administrator." });
    }
    // Cookie-authenticated changes must come from our own pages (basic CSRF protection).
    const viaCookie = !request.headers.authorization;
    if (viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-autoflow'] !== '1') {
      return reply.code(403).send({ error: 'Request blocked for security reasons. Reload the page.' });
    }
  };
}

export function pruneSessions(db: Db): void {
  db.run('DELETE FROM sessions WHERE expires_at < ?', now());
}
