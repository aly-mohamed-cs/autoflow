// Studio's connection to the company Orchestrator: sign in, publish automations.
import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import type { Encryptor } from './storage';

export interface OrchestratorInfo {
  url: string;
  username: string;
  displayName: string;
  role: string;
}

interface Saved extends OrchestratorInfo {
  token: string; // encrypted with safeStorage (DPAPI), base64
  fingerprint?: string; // pinned self-signed certificate
}

export class UntrustedCertificateError extends Error {
  constructor(readonly fingerprint: string) {
    super('UNTRUSTED_CERTIFICATE');
  }
}

export class Orchestrator {
  private readonly file: string;

  constructor(
    userData: string,
    private readonly crypto: Encryptor,
  ) {
    this.file = join(userData, 'orchestrator.json');
  }

  async info(): Promise<OrchestratorInfo | null> {
    const saved = await this.read();
    return saved ? { url: saved.url, username: saved.username, displayName: saved.displayName, role: saved.role } : null;
  }

  /** Address and pinned certificate (if any), for the in-app updater. */
  async connection(): Promise<{ url: string; fingerprint?: string } | null> {
    const saved = await this.read();
    return saved ? { url: saved.url, fingerprint: saved.fingerprint } : null;
  }

  async connect(rawUrl: string, username: string, password: string, trustFingerprint?: string): Promise<OrchestratorInfo> {
    const url = normalize(rawUrl);
    const res = await this.call<{ token: string; user: { username: string; displayName: string; role: string } }>(
      { url, fingerprint: trustFingerprint },
      'POST',
      '/api/auth/login',
      { username, password, client: 'studio' },
    );
    const saved: Saved = {
      url,
      username: res.user.username,
      displayName: res.user.displayName,
      role: res.user.role,
      token: this.crypto.encryptString(res.token).toString('base64'),
      fingerprint: trustFingerprint,
    };
    await fs.writeFile(this.file, JSON.stringify(saved, null, 2), 'utf8');
    return { url, username: saved.username, displayName: saved.displayName, role: saved.role };
  }

  async disconnect(): Promise<void> {
    const saved = await this.read();
    if (saved) await this.request('POST', '/api/auth/logout', {}).catch(() => undefined);
    await fs.rm(this.file, { force: true });
  }

  /** Call the API as the signed-in user. */
  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const saved = await this.read();
    if (!saved) throw new Error('Studio is not connected to an Orchestrator. Connect it in Settings.');
    const token = this.crypto.decryptString(Buffer.from(saved.token, 'base64'));
    return this.call<T>({ url: saved.url, fingerprint: saved.fingerprint, token }, method, path, body, timeoutMs);
  }

  private async read(): Promise<Saved | null> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as Saved;
    } catch {
      return null;
    }
  }

  private call<T>(
    target: { url: string; fingerprint?: string; token?: string },
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    const u = new URL(path, target.url);
    const isHttps = u.protocol === 'https:';
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const req = (isHttps ? https : http).request(
        u,
        {
          method,
          timeout: timeoutMs,
          headers: {
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
            ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
          },
          // Self-signed company certificates are pinned by fingerprint instead of a CA.
          ...(isHttps && target.fingerprint ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let data: unknown = null;
            try {
              data = text ? JSON.parse(text) : null;
            } catch {
              data = { error: text.slice(0, 200) };
            }
            if ((res.statusCode ?? 500) >= 400) {
              const message = (data as { error?: string } | null)?.error ?? `The Orchestrator answered ${res.statusCode}.`;
              reject(new Error(res.statusCode === 401 && target.token ? 'Your Orchestrator sign-in expired. Connect again in Settings.' : message));
            } else {
              resolve(data as T);
            }
          });
        },
      );
      req.on('socket', (socket) => {
        if (!isHttps || !target.fingerprint) return;
        socket.on('secureConnect', () => {
          const cert = (socket as TLSSocket).getPeerX509Certificate();
          if (cert?.fingerprint256 !== target.fingerprint) {
            req.destroy(new Error('The Orchestrator certificate changed. If IT renewed it, connect again in Settings.'));
          }
        });
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (isHttps && !target.fingerprint && /self.signed|unable to verify|UNABLE_TO_GET_ISSUER|DEPTH_ZERO/i.test(`${err.code} ${err.message}`)) {
          fetchFingerprint(u).then((fp) => reject(new UntrustedCertificateError(fp)), () => reject(err));
          return;
        }
        reject(friendlyNetworkError(err, u));
      });
      req.on('timeout', () => req.destroy(new Error('The Orchestrator did not answer in time.')));
      if (payload) req.write(payload);
      req.end();
    });
  }
}

function normalize(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function fetchFingerprint(u: URL): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(u, { method: 'HEAD', rejectUnauthorized: false, timeout: 10_000 }, (res) => {
      res.resume();
    });
    req.on('socket', (socket) =>
      socket.on('secureConnect', () => {
        const fp = (socket as TLSSocket).getPeerX509Certificate()?.fingerprint256;
        req.destroy();
        if (fp) resolve(fp);
        else reject(new Error('no certificate'));
      }),
    );
    req.on('error', () => undefined);
    req.end();
  });
}

function friendlyNetworkError(err: NodeJS.ErrnoException, u: URL): Error {
  if (err.code === 'ENOTFOUND') return new Error(`Can't find the server “${u.hostname}”. Check the address.`);
  if (err.code === 'ECONNREFUSED') return new Error(`Nothing is answering at ${u.host}. Check the address and port, and that the Orchestrator is running.`);
  if (err.code === 'ETIMEDOUT') return new Error(`The connection to ${u.host} timed out. Check the network.`);
  return err;
}
