import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  /** Address people and robots use to reach the server, e.g. https://rpa.company.local:8443 */
  publicUrl: string;
  tls: { pfx?: string; passphrase?: string; cert?: string; key?: string } | null;
  dashboardDir: string;
  sessionHours: number;
  /** Keep screenshots and run logs this many days. */
  retentionDays: number;
  /** Allow plain http (development only). */
  insecureHttp: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Settings come from <dataDir>/config.json (written by install-server.ps1),
 * overridable by AUTOFLOW_* environment variables.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const serverRoot = resolve(here, '..');
  const dataDir = resolve(env.AUTOFLOW_DATA_DIR ?? join(serverRoot, '..', '..', 'data'));
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'config.json');
  // Windows PowerShell 5.1 saves UTF-8 with a byte-order mark, which JSON.parse rejects.
  const fromFile = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<Config>) : {};
  const port = Number(env.AUTOFLOW_PORT ?? fromFile.port ?? 8443);
  const insecureHttp = (env.AUTOFLOW_INSECURE_HTTP ?? String(fromFile.insecureHttp ?? false)) === 'true' || env.AUTOFLOW_INSECURE_HTTP === '1';
  const tls = insecureHttp ? null : (fromFile.tls ?? defaultTls(dataDir));
  return {
    dataDir,
    host: env.AUTOFLOW_HOST ?? fromFile.host ?? '0.0.0.0',
    port,
    publicUrl: env.AUTOFLOW_PUBLIC_URL ?? fromFile.publicUrl ?? `${insecureHttp ? 'http' : 'https'}://localhost:${port}`,
    tls,
    dashboardDir: resolve(env.AUTOFLOW_DASHBOARD_DIR ?? fromFile.dashboardDir ?? join(serverRoot, '..', 'dashboard', 'dist')),
    sessionHours: Number(fromFile.sessionHours ?? 12),
    retentionDays: Number(env.AUTOFLOW_RETENTION_DAYS ?? fromFile.retentionDays ?? 90),
    insecureHttp,
  };
}

function defaultTls(dataDir: string): Config['tls'] {
  const pfx = join(dataDir, 'tls', 'server.pfx');
  return existsSync(pfx) ? { pfx, passphrase: readPassphrase(dataDir) } : null;
}

function readPassphrase(dataDir: string): string | undefined {
  const file = join(dataDir, 'tls', 'passphrase.txt');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined;
}
