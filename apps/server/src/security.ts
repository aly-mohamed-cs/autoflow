import { execFileSync } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// -- passwords (local accounts) -------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [algo, n, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// -- tokens (sessions, robots, webhooks, enrollment keys) -------------------------------

/** A random token for the client, and the hash we store (tokens are never stored). */
export function newToken(prefix: string): { token: string; hash: string } {
  const token = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

// -- vault (credentials for robots) ------------------------------------------------------

/**
 * AES-256-GCM encryption of credential passwords. The 32-byte key lives in
 * <data>/vault.key, protected with Windows DPAPI (machine scope) by the installer,
 * so a copied database or key file is useless on another computer.
 */
export class Vault {
  private constructor(private readonly key: Buffer) {}

  static open(dataDir: string, env: NodeJS.ProcessEnv = process.env): Vault {
    if (env.AUTOFLOW_VAULT_KEY) return new Vault(Buffer.from(env.AUTOFLOW_VAULT_KEY, 'base64'));
    const protectedFile = join(dataDir, 'vault.key.dpapi');
    if (existsSync(protectedFile)) return new Vault(dpapiUnprotect(readFileSync(protectedFile, 'utf8').trim()));
    const plainFile = join(dataDir, 'vault.key');
    if (!existsSync(plainFile)) {
      mkdirSync(dirname(plainFile), { recursive: true });
      writeFileSync(plainFile, randomBytes(32).toString('base64'), { mode: 0o600 });
      console.warn(
        `[vault] Created ${plainFile}. Run deploy\\windows\\install-server.ps1 to protect it with Windows DPAPI.`,
      );
    }
    return new Vault(Buffer.from(readFileSync(plainFile, 'utf8').trim(), 'base64'));
  }

  static fromKey(key: Buffer): Vault {
    return new Vault(key);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unknown secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** Decrypt a DPAPI (LocalMachine) blob using PowerShell; Node has no DPAPI binding. */
function dpapiUnprotect(base64: string): Buffer {
  if (process.platform !== 'win32') throw new Error('vault.key.dpapi can only be read on Windows');
  const script =
    'Add-Type -AssemblyName System.Security; ' +
    `$b=[Convert]::FromBase64String('${base64.replace(/[^A-Za-z0-9+/=]/g, '')}'); ` +
    '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine); ' +
    '[Convert]::ToBase64String($p)';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return Buffer.from(out.trim(), 'base64');
}
