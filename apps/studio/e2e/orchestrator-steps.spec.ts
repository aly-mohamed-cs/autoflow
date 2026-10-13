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

test.skip(!existsSync(SERVER), 'build the server first');

test('shared values and queue items in a test run, picked from the Orchestrator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoflow-orch-'));
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
    await call('PUT', '/api/assets', { name: 'Portal address', kind: 'text', value: 'https://vendors.example' });
    const { id: queueId } = await call('POST', '/api/queues', { name: 'Customers' });
    await call('POST', `/api/queues/${queueId}/items`, { items: [{ reference: 'C-1', data: { name: 'Ann' } }] });
    await call('POST', '/api/notices', { message: 'Robots are updated tonight at 22:00.', tone: 'warning' });

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
    await expect(win.getByRole('region', { name: 'Notices' })).toContainText('Robots are updated tonight at 22:00.');
    await win.getByRole('button', { name: 'New automation' }).click();
    await win.getByLabel('Name').fill('Greet customers');
    await win.getByRole('button', { name: 'Create' }).click();
    const library = win.getByRole('complementary', { name: 'Step library' });
    const props = win.getByRole('complementary', { name: 'Properties' });

    // The pickers list what is on the Orchestrator.
    await library.getByRole('button', { name: 'Get shared value' }).click();
    await props.locator('#param-name').click();
    await win.getByRole('option', { name: 'Portal address' }).click();
    await library.getByRole('button', { name: 'Get next queue item' }).click();
    await props.locator('#param-queue').click();
    await win.getByRole('option', { name: 'Customers' }).click();
    await library.getByRole('button', { name: 'Write to log' }).click();
    await props.getByRole('textbox', { name: 'Message' }).fill('Open {{shared_value}} for {{queue_item["name"]}}');
    await expect(win.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await win.getByRole('button', { name: 'Test run' }).click();
    await expect(win.getByText('Finished successfully')).toBeVisible({ timeout: 30_000 });
    await expect(win.getByText('Open https://vendors.example for Ann')).toBeVisible();

    // The test run didn't finish the item: it is back in the queue, and the try doesn't count.
    await expect
      .poll(async () => (await call('GET', `/api/queues/${queueId}/items`)).items[0], { timeout: 10_000 })
      .toMatchObject({ status: 'new', attempts: 0 });
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
