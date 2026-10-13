// The server health page: what an administrator checks when something seems wrong.
import { readdirSync, statfsSync, statSync } from 'node:fs';
import { cpus, freemem, hostname, release, totalmem, uptime, version as osVersion } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import type { Services } from '../app.js';

export interface Check {
  name: string;
  status: 'ok' | 'warning' | 'problem';
  message: string;
}

const STARTED = Date.now();
const DAY = 86_400_000;

/** The certificate this server presents (works for .pfx too, which Node can't read directly). */
export function ownCertificate(port: number): Promise<{ fingerprint: string; validTo: string } | null> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerX509Certificate();
      socket.end();
      resolve(cert ? { fingerprint: cert.fingerprint256, validTo: new Date(cert.validTo).toISOString() } : null);
    });
    socket.on('error', () => resolve(null));
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(null);
    });
  });
}

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function newestBackup(dataDir: string): string | null {
  try {
    const dirs = readdirSync(join(dataDir, 'backups'), { withFileTypes: true }).filter((d) => d.isDirectory());
    const times = dirs.map((d) => statSync(join(dataDir, 'backups', d.name)).mtimeMs);
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  } catch {
    return null;
  }
}

export async function serverHealth(svc: Services, version: string) {
  const { db, config, gateway } = svc;
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], message: string) => checks.push({ name, status, message });

  // Disk and database
  let disk: { free: number; total: number } | null = null;
  try {
    const s = statfsSync(config.dataDir);
    disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    /* not available */
  }
  if (disk) {
    const share = disk.free / disk.total;
    add('Disk space', share < 0.05 ? 'problem' : share < 0.15 ? 'warning' : 'ok',
      `${(disk.free / 1e9).toFixed(1)} GB free (${Math.round(share * 100)}%) where the data is kept.`);
  }
  const database = { size: size(db.path) + size(`${db.path}-wal`) };

  // Backups
  const lastBackup = newestBackup(config.dataDir);
  if (!lastBackup) add('Backups', 'warning', 'No backup found in the data folder. Set up the nightly backup (SERVER-SETUP.md).');
  else {
    const age = Date.now() - Date.parse(lastBackup);
    add('Backups', age > 2 * DAY ? 'warning' : 'ok', age > 2 * DAY ? `The newest backup is ${Math.floor(age / DAY)} days old.` : 'A backup was made in the last two days.');
  }

  // Certificate
  let certificate: { validTo: string } | null = null;
  if (config.tls) {
    certificate = await ownCertificate(config.port);
    if (certificate) {
      const left = Math.floor((Date.parse(certificate.validTo) - Date.now()) / DAY);
      add('Certificate', left < 0 ? 'problem' : left < 30 ? 'warning' : 'ok',
        left < 0 ? 'The HTTPS certificate has expired: Studio and robots will refuse to connect.' : `The HTTPS certificate is valid for ${left} more days.`);
    }
  } else {
    add('Certificate', 'warning', 'The server uses plain HTTP. Run install-server.ps1 to set up HTTPS.');
  }

  // Robots and work
  const robots = db.all<{ id: string; enabled: number }>('SELECT id, enabled FROM robots');
  const online = robots.filter((r) => gateway.isOnline(r.id)).length;
  const enabled = robots.filter((r) => r.enabled).length;
  const jobs = db.get<{ queued: number; running: number; oldest: string | null }>(
    `SELECT SUM(status = 'queued') AS queued, SUM(status = 'running') AS running, MIN(CASE WHEN status = 'queued' THEN queued_at END) AS oldest FROM jobs WHERE status IN ('queued', 'running')`,
  ) ?? { queued: 0, running: 0, oldest: null };
  const waitingMin = jobs.oldest ? Math.floor((Date.now() - Date.parse(jobs.oldest)) / 60_000) : 0;
  if (!robots.length) add('Robots', 'warning', 'No robot is enrolled yet.');
  else add('Robots', online === 0 ? 'problem' : online < enabled ? 'warning' : 'ok', `${online} of ${enabled} robots are online.`);
  add('Waiting runs', waitingMin > 30 ? 'warning' : 'ok',
    jobs.queued ? `${jobs.queued} runs are waiting for a robot; the oldest for ${waitingMin} minutes.` : 'No runs are waiting for a robot.');
  const failed24h = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND finished_at > ?`, new Date(Date.now() - DAY).toISOString())?.n ?? 0;
  const done24h = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE finished_at > ?`, new Date(Date.now() - DAY).toISOString())?.n ?? 0;
  add('Failed runs', done24h >= 5 && failed24h / done24h > 0.25 ? 'warning' : 'ok', `${failed24h} of ${done24h} runs in the last 24 hours failed.`);
  const brokenTriggers = db.all<{ name: string; last_error: string }>('SELECT name, last_error FROM event_triggers WHERE enabled = 1 AND last_error IS NOT NULL');
  const unwatched = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM event_triggers WHERE enabled = 1 AND watcher_robot_id IS NULL')?.n ?? 0;
  if (brokenTriggers.length || unwatched) {
    add('Event triggers', 'warning', [
      ...brokenTriggers.map((t) => `“${t.name}”: ${t.last_error}`),
      ...(unwatched ? [`${unwatched} trigger${unwatched > 1 ? 's have' : ' has'} no online robot to watch ${unwatched > 1 ? 'them' : 'it'}.`] : []),
    ].join(' '));
  }
  const backlog = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM queue_items WHERE status = 'new'`)?.n ?? 0;

  const memory = { total: totalmem(), free: freemem(), server: process.memoryUsage().rss };
  if (memory.free / memory.total < 0.05) add('Memory', 'warning', 'The server computer is almost out of memory.');

  return {
    version,
    node: process.version,
    host: { name: hostname(), os: `${osVersion()} ${release()}`, cpus: cpus().length, uptimeS: Math.round(uptime()) },
    startedAt: new Date(STARTED).toISOString(),
    memory,
    disk,
    database,
    lastBackup,
    certificate,
    robots: { total: robots.length, enabled, online },
    jobs: { queued: Number(jobs.queued ?? 0), running: Number(jobs.running ?? 0), failed24h, finished24h: done24h },
    queueBacklog: backlog,
    checks,
  };
}
