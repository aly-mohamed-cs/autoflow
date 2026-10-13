import { _electron as electron, expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test.skip(!existsSync(SERVER), 'build the server first');

test('my work plan: run a published automation on this PC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoflow-plan-'));
  const out = join(dir, 'out');
  mkdirSync(out);
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
    const flow = {
      id: 'flow_morning',
      name: 'Morning report',
      steps: [{ id: 'w', activity: 'files.write_text', params: { file: join(out, 'report.txt'), text: 'Made on this PC' } }],
    };
    const published = await fetch(`${base}/api/flows/flow_morning/versions`, { method: 'POST', headers: { ...json, Authorization: `Bearer ${token}` }, body: JSON.stringify({ flow }) });
    expect(published.ok).toBe(true);

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

    await win.getByRole('button', { name: 'My work plan' }).click();
    await win.getByRole('combobox', { name: 'Published automation' }).click();
    await win.getByRole('option', { name: 'Morning report' }).click();
    await win.getByRole('button', { name: 'Add to my work plan' }).click();
    const plan = win.getByRole('list', { name: 'My work plan' });
    await expect(plan.getByText('Morning report')).toBeVisible();

    // A schedule shows when it runs next.
    await plan.getByRole('combobox', { name: 'When it runs' }).click();
    await win.getByRole('option', { name: 'Monday to Friday at' }).click();
    await expect(plan.getByText(/^Next: /)).toBeVisible();

    await plan.getByRole('button', { name: 'Run on this PC' }).click();
    await expect(win.getByRole('list', { name: 'Recent runs on this PC' }).getByText('Finished')).toBeVisible({ timeout: 30_000 });
    expect(readFileSync(join(out, 'report.txt'), 'utf8')).toBe('Made on this PC');

    // The editor's test runs are not mixed up with it.
    await win.getByRole('button', { name: 'Automations' }).click();
    await expect(win.getByText('Finished successfully')).toHaveCount(0);
    await app.close();
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
