import { _electron as electron, expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { launchTarget } from './target';
import { join, resolve } from 'node:path';

const SERVER = resolve(__dirname, '..', '..', 'server', 'dist', 'index.js');

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });

test.skip(!existsSync(SERVER), 'build the server first');

test('connect to the Orchestrator and publish an automation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoflow-pub-'));
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
    await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'builder', displayName: 'Bea Builder', password: 'a long test password' }),
    });

    const app = await electron.launch({ ...launchTarget(), env: { ...process.env, AUTOFLOW_USER_DATA: join(dir, 'studio') } });
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.waitForFunction(() => window.autoflow.engine.status().then((s) => s.state === 'ready'), null, { timeout: 30_000 });

    await win.getByRole('button', { name: 'Settings' }).click();
    await win.getByLabel('Orchestrator address').fill(base);
    await win.getByLabel('Username').fill('builder');
    await win.getByLabel('Password').fill('a long test password');
    await win.getByRole('button', { name: 'Connect' }).click();
    await expect(win.getByText('Connected', { exact: true })).toBeVisible();

    await win.getByRole('button', { name: 'Automations' }).click();
    await win.getByRole('button', { name: 'New automation' }).click();
    await win.getByLabel('Name').fill('Publish me');
    await win.getByRole('button', { name: 'Create' }).click();
    const library = win.getByRole('complementary', { name: 'Step library' });
    await library.getByRole('button', { name: 'Write to log' }).click();
    await win.getByRole('complementary', { name: 'Properties' }).getByRole('textbox', { name: 'Message' }).fill('Hello robots');
    await expect(win.getByText('Saved')).toBeVisible({ timeout: 5_000 });
    await expect(win.getByText(/to fix/)).toHaveCount(0, { timeout: 5_000 });

    await win.getByRole('button', { name: 'Publish' }).click();
    await win.getByLabel('What changed?').fill('First version');
    await win.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
    await expect(win.getByText('Published version 1')).toBeVisible();
    await win.getByRole('button', { name: 'Done' }).click();

    // Quick launch: assign Ctrl+Alt+1 to the automation and start it like the shortcut would.
    await win.getByRole('button', { name: 'Settings' }).click();
    await win.getByRole('button', { name: 'Add shortcut' }).click();
    await win.getByText('Choose an automation').click();
    await win.getByRole('option', { name: 'Publish me' }).click();
    await expect(win.getByRole('button', { name: 'Shortcut', exact: true })).toHaveText('Ctrl+Alt+1');
    await expect
      .poll(() => app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Alt+1')))
      .toBe(true);
    await win.getByRole('button', { name: 'Run now', exact: true }).click();
    await app.close();

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'builder', password: 'a long test password' }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    const flows = await fetch(`${base}/api/flows`, { headers: { Authorization: `Bearer ${login.token}` } }).then((r) => r.json() as Promise<{ flows: { name: string; latestVersion: number }[] }>);
    expect(flows.flows).toEqual([expect.objectContaining({ name: 'Publish me', latestVersion: 1 })]);
    const jobs = await fetch(`${base}/api/jobs`, { headers: { Authorization: `Bearer ${login.token}` } }).then(
      (r) => r.json() as Promise<{ jobs: { trigger: string; triggeredBy: string }[] }>,
    );
    expect(jobs.jobs).toEqual([expect.objectContaining({ trigger: 'hotkey', triggeredBy: 'Bea Builder (hotkey)' })]);
  } finally {
    server.kill();
    await new Promise((r) => server.once('exit', r));
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temp folder; Windows may still hold a file briefly */
    }
  }
});
