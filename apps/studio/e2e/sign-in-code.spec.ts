import { _electron as electron, expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchTarget } from './target';

const SERVER = resolve(__dirname, '..', '..', 'server', 'dist', 'index.js');

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });

/** Just enough of an SMTP server to receive the Orchestrator's emails. */
function fakeSmtp() {
  const mails: string[] = [];
  const server = createServer((socket) => {
    let data = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = data ? buffer.indexOf('\r\n.\r\n') : buffer.indexOf('\r\n')) >= 0) {
        if (data) {
          mails.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          data = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const verb = buffer.slice(0, 4).toUpperCase();
        buffer = buffer.slice(end + 2);
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake\r\n250 OK\r\n');
        else if (verb === 'DATA') {
          data = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  return { server, mails };
}

test.skip(!existsSync(SERVER), 'build the server first');

test('connect Studio when the Orchestrator asks for a code from an email', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoflow-code-'));
  const smtp = fakeSmtp();
  await new Promise<void>((r) => smtp.server.listen(0, '127.0.0.1', r));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env,
      AUTOFLOW_DATA_DIR: join(dir, 'server'),
      AUTOFLOW_INSECURE_HTTP: '1',
      AUTOFLOW_PORT: String(port),
      AUTOFLOW_HOST: '127.0.0.1',
      AUTOFLOW_PUBLIC_URL: base,
      AUTOFLOW_VAULT_KEY: randomBytes(32).toString('base64'),
    },
    stdio: 'ignore',
  });
  try {
    await expect.poll(() => fetch(`${base}/health`).then((r) => r.ok).catch(() => false), { timeout: 20_000 }).toBe(true);
    const json = { 'Content-Type': 'application/json' };
    await fetch(`${base}/api/setup`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'builder', displayName: 'Bea Builder', password: 'a long test password' }) });
    const { token } = (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'builder', password: 'a long test password' }) }).then((r) =>
      r.json(),
    )) as { token: string };
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method, headers: { ...json, Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }).then(
        (r) => r.json() as Promise<any>,
      );
    const me = (await call('GET', '/api/auth/me')).user;
    await call('PATCH', `/api/users/${me.id}`, { email: 'bea@company.local' });
    const smtpPort = (smtp.server.address() as { port: number }).port;
    const saved = await call('PUT', '/api/settings/signin', { codes: 'admins', smtp: { host: '127.0.0.1', port: smtpPort, security: 'none', from: 'autoflow@company.local' } });
    expect(saved.codes).toBe('admins');

    const app = await electron.launch({ ...launchTarget(), env: { ...process.env, AUTOFLOW_USER_DATA: join(dir, 'studio') } });
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.waitForFunction(() => window.autoflow.engine.status().then((s) => s.state === 'ready'), null, { timeout: 30_000 });

    await win.getByRole('button', { name: 'Settings' }).click();
    await win.getByLabel('Orchestrator address').fill(base);
    await win.getByLabel('Username').fill('builder');
    await win.getByLabel('Password').fill('a long test password');
    await win.getByRole('button', { name: 'Connect' }).click();
    await expect(win.getByText('sent a 6-digit code to b***@company.local')).toBeVisible();
    await expect.poll(() => smtp.mails.length).toBe(1);
    const code = /code is (\d{6})/.exec(smtp.mails[0]!)![1]!;

    await win.getByLabel('Code from the email').fill(code === '000000' ? '111111' : '000000');
    await win.getByRole('button', { name: 'Connect' }).click();
    await expect(win.getByText('That code is not right. Check the newest email.')).toBeVisible();
    await win.getByLabel('Code from the email').fill(code);
    await win.getByRole('button', { name: 'Connect' }).click();
    await expect(win.getByText('Connected', { exact: true })).toBeVisible();
    await app.close();
  } finally {
    server.kill();
    smtp.server.close();
    await new Promise((r) => server.once('exit', r));
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temp folder; Windows may still hold a file briefly */
    }
  }
});
