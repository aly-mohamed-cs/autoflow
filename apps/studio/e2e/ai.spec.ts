import { _electron as electron, expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
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

/** A stand-in for the company's local model server (OpenAI-compatible). */
function fakeModel(dataDir: string) {
  return createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      const [system, user] = body.messages.map((m) => m.content);
      let content: unknown = 'The file was not found.';
      if (system!.startsWith('You design automations')) {
        content = {
          name: 'Read the orders file',
          description: 'Reads the daily orders file and logs it.',
          variables: [],
          steps: [
            { activity: 'files.read_text', label: 'Read orders', params: { file: join(dataDir, 'orders.txt') }, outputs: { text: 'orders' } },
            { activity: 'control.log', params: { message: 'Orders: {{orders}}' } },
          ],
        };
      } else if (system!.startsWith('You repair failed steps')) {
        const folder = JSON.parse(user!).screen.paths.file.folder as string;
        content = { fixable: true, explanation: 'The file is called orders-2026.txt.', params: { file: join(folder, 'orders-2026.txt') } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
    });
  });
}

test('describe an automation, then let the AI fix a failing step during the test run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoflow-ai-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'orders-2026.txt'), '17 orders');
  const model = fakeModel(dataDir);
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;

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
    const saved = await fetch(`${base}/api/settings/ai`, {
      method: 'PUT',
      headers: { ...json, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ enabled: true, baseUrl: modelUrl, model: 'fake', timeoutS: 30 }),
    });
    expect(saved.ok).toBe(true);

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
    await expect(win.getByText('Let the AI fix failed steps during test runs')).toBeVisible();

    // Describe it -> a draft built only from real steps.
    await win.getByRole('button', { name: 'Automations' }).click();
    await win.getByRole('button', { name: 'Describe it' }).click();
    await win.getByLabel('What should it do?').fill('Every morning read the orders file in the data folder and write it to the log.');
    await win.getByRole('button', { name: 'Draft it' }).click();
    await expect(win.getByText('Draft ready')).toBeVisible({ timeout: 15_000 });
    const canvas = win.getByRole('main');
    await expect(canvas.getByText('Read orders')).toBeVisible();

    // The drafted file name is wrong; the AI fixes the step during the test run.
    await win.getByRole('button', { name: 'Test run' }).click();
    await expect(win.getByText('Finished successfully')).toBeVisible({ timeout: 30_000 });
    const fix = win.getByRole('group', { name: 'AI fix' });
    await expect(fix).toContainText('The file is called orders-2026.txt.');
    await expect(win.getByText('Orders: 17 orders')).toBeVisible();
    await fix.getByRole('button', { name: 'Keep fix' }).click();
    await expect(fix).toHaveCount(0);

    await canvas.getByLabel('Read text file').click();
    const props = win.getByRole('complementary', { name: 'Properties' });
    await expect(props.getByRole('textbox', { name: 'File' })).toContainText('orders-2026.txt');
    await app.close();
  } finally {
    server.kill();
    model.close();
    await new Promise((r) => server.once('exit', r));
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temp folder; Windows may still hold a file briefly */
    }
  }
});
