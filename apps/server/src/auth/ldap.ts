// Active Directory sign-in. Users sign in with their normal Windows account; their AD
// groups decide their Autoflow role.
import { Client } from 'ldapts';
import { ROLES, type Role } from './roles.js';

export interface LdapSettings {
  enabled: boolean;
  /** ldaps://dc01.company.local:636 (or ldap:// with startTLS) */
  url: string;
  /** Windows domain for user@domain sign-in, e.g. company.local */
  domain: string;
  /** Where to look users up, e.g. DC=company,DC=local */
  baseDn: string;
  startTls: boolean;
  /** Accept self-signed domain controller certificates (not recommended). */
  allowInvalidCert: boolean;
  /** Group DN or name (CN) per role. A user gets the highest matching role. */
  groupRoles: Record<Role, string[]>;
  /** Role for authenticated users in none of the groups; null = no access. */
  defaultRole: Role | null;
}

export const DEFAULT_LDAP: LdapSettings = {
  enabled: false,
  url: '',
  domain: '',
  baseDn: '',
  startTls: false,
  allowInvalidCert: false,
  groupRoles: { admin: [], builder: [], operator: [], viewer: [] },
  defaultRole: null,
};

export interface LdapUser {
  username: string;
  displayName: string;
  email: string | null;
  groups: string[];
  role: Role | null;
}

export class LdapError extends Error {}

export async function ldapAuthenticate(settings: LdapSettings, username: string, password: string): Promise<LdapUser> {
  if (!password) throw new LdapError('Enter your password.');
  const account = username.includes('\\') ? username.split('\\')[1]! : username.split('@')[0]!;
  const client = new Client({
    url: settings.url,
    timeout: 10_000,
    connectTimeout: 10_000,
    tlsOptions: { rejectUnauthorized: !settings.allowInvalidCert },
  });
  try {
    if (settings.startTls) await client.startTLS({ rejectUnauthorized: !settings.allowInvalidCert });
    try {
      await client.bind(`${account}@${settings.domain}`, password);
    } catch {
      throw new LdapError('Wrong username or password.');
    }
    const { searchEntries } = await client.search(settings.baseDn, {
      scope: 'sub',
      filter: `(&(objectClass=user)(sAMAccountName=${escapeFilter(account)}))`,
      attributes: ['sAMAccountName', 'displayName', 'mail', 'memberOf', 'userAccountControl'],
      sizeLimit: 2,
    });
    const entry = searchEntries[0];
    if (!entry) throw new LdapError('Your account was not found in the directory.');
    const groups = toArray(entry.memberOf).map(String);
    return {
      username: String(entry.sAMAccountName ?? account),
      displayName: String(entry.displayName ?? account),
      email: entry.mail ? String(entry.mail) : null,
      groups,
      role: roleForGroups(groups, settings),
    };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/** Highest role whose configured groups intersect the user's groups. */
export function roleForGroups(groups: string[], settings: Pick<LdapSettings, 'groupRoles' | 'defaultRole'>): Role | null {
  const normalized = new Set<string>();
  for (const dn of groups) {
    normalized.add(dn.toLowerCase());
    const cn = /^CN=([^,]+)/i.exec(dn)?.[1];
    if (cn) normalized.add(cn.toLowerCase());
  }
  for (const role of [...ROLES].reverse()) {
    if ((settings.groupRoles[role] ?? []).some((g) => normalized.has(g.trim().toLowerCase()))) return role;
  }
  return settings.defaultRole;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** RFC 4515 escaping so a username can't change the LDAP query. */
export function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
