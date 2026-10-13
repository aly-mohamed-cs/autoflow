// Autoflow Orchestrator entry point.
//   node dist/index.js                       start the server
//   node dist/index.js backup <file.db>      consistent copy of the database
//   node dist/index.js reset-password <user> set a new password for a local user (prints it)
//   node dist/index.js sign-in-codes off     turn off sign-in codes by email (e.g. mail server down)
import { randomBytes } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp, createServices, VERSION } from './app.js';
import { pruneSessions } from './auth/sessions.js';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { hashPassword, Vault } from './security.js';

async function main(argv: string[]): Promise<void> {
  const config = loadConfig();
  const db = new Db(join(config.dataDir, 'autoflow.db'));
  const applied = db.migrate();
  const [command, arg] = argv;

  if (command === 'backup') {
    if (!arg) throw new Error('Usage: backup <target-file>');
    db.backupTo(arg);
    console.log(`Database copied to ${arg}`);
    return;
  }
  if (command === 'sign-in-codes') {
    // Break-glass: e.g. the mail server is down and nobody can get a code.
    if (arg !== 'off') throw new Error('Usage: sign-in-codes off');
    db.run(`INSERT INTO settings (key, value) VALUES ('signin', '{"codes":"off"}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    console.log('Sign-in codes by email are off. Turn them on again in the dashboard (Settings → Sign-in).');
    return;
  }
  if (command === 'reset-password') {
    const user = db.get<{ id: string; source: string }>('SELECT id, source FROM users WHERE username = ?', arg ?? '');
    if (!user || user.source !== 'local') throw new Error(`No local user called "${arg}".`);
    const password = randomBytes(12).toString('base64url');
    db.run('UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?', hashPassword(password), user.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
    console.log(`New password for ${arg}: ${password}`);
    return;
  }

  const svc = createServices(config, db, Vault.open(config.dataDir));
  const app = await buildApp(svc);
  if (applied) app.log.info(`Database updated (${applied} migration${applied > 1 ? 's' : ''})`);
  if (!config.tls && !config.insecureHttp) {
    app.log.warn('No TLS certificate found: serving plain HTTP. Run install-server.ps1 to create one.');
  }

  svc.gateway.start();
  svc.scheduler.start();
  svc.queues.pump();
  const maintenance = setInterval(() => runMaintenance(svc.db, config.dataDir, config.retentionDays), 6 * 3_600_000);
  runMaintenance(db, config.dataDir, config.retentionDays);

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Autoflow Orchestrator ${VERSION} ready at ${config.publicUrl}`);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: shutting down`);
    clearInterval(maintenance);
    svc.scheduler.stop();
    svc.gateway.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Drop sessions that expired and run history older than the retention period. */
export function runMaintenance(db: Db, dataDir: string, retentionDays: number): void {
  try {
    pruneSessions(db);
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const old = db.all<{ id: string }>(`SELECT id FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?`, cutoff);
    for (const { id } of old) {
      db.run('DELETE FROM jobs WHERE id = ?', id); // events and artifact rows cascade
      rmSync(join(dataDir, 'artifacts', id), { recursive: true, force: true });
    }
    // Artifact folders whose job no longer exists (e.g. after a crash).
    const dir = join(dataDir, 'artifacts');
    for (const name of safeList(dir)) {
      if (!db.get('SELECT 1 FROM jobs WHERE id = ?', name) && statSync(join(dir, name)).mtimeMs < Date.now() - 86_400_000) {
        rmSync(join(dir, name), { recursive: true, force: true });
      }
    }
  } catch (err) {
    console.error('maintenance failed', err);
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
