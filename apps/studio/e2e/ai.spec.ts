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
    if (req.method === 'GET') return void res.writeHead(404).end(); // not Ollama
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      const [system, user] = body.messages.map((m) => m.content);
      const last = body.messages.at(-1)!.content;
      let content: unknown = 'The file was not found.';
      if (system!.startsWith('You are the assistant inside Autoflow')) {
        const broken = /\[(s[0-9a-z]+)\] message:/.exec(last);
        if (last.startsWith('Studio checked the steps') && broken) {
          // The check found the formula typo below: fix that step.
          content = { message: 'Fixed the log message.', actions: [{ type: 'update_step', step: broken[1], params: { message: 'Orders: {{orders}}' } }] };
        } else if (last.includes('something odd')) {
          content = { result: 1 }; // not the asked-for shape
        } else if (last.includes('Done')) {
          content = { message: 'Added it.', actions: [{ type: 'add_steps', after: 'end', steps: [{ activity: 'control.log', label: 'Say done', params: { message: 'Done' } }] }] };
        } else {
          content = {
            message: 'I added the steps. Check the file name, then test it.',
            actions: [
              { type: 'new_automation', name: 'Read the orders file', description: 'Reads the daily orders file and logs it.' },
              {
                type: 'add_steps',
                after: 'start',
                steps: [
                  { activity: 'files.read_text', label: 'Read orders', params: { file: join(dataDir, 'orders.txt') }, outputs: { text: 'orders' } },
                  { activity: 'control.log', label: 'Log orders', params: { message: 'Orders: {{orders +}}' } },
                ],
              },
            ],
          };
        }
      } else if (system!.startsWith('You repair failed steps')) {
        const folder = JSON.parse(user!).screen.paths.file.folder as string;
        content = { fixable: true, explanation: 'The file is called orders-2026.txt.', params: { file: join(folder, 'orders-2026.txt') } };
      } else if (system!.startsWith("Summarise the user's text")) {
        content = `Summary: ${user}`;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
    });
  });
}

test('build an automation in the AI chat, let the AI fix a failing step, then use the AI step', async () => {
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

    // Build with AI -> the assistant builds the automation in the chat; Studio's check sends its
    // formula typo back and the assistant fixes it.
    await win.getByRole('button', { name: 'Automations' }).click();
    await win.getByRole('button', { name: 'Build with AI' }).click();
    await win.getByLabel('What should it do?').fill('Every morning read the orders file in the data folder and write it to the log.');
    await win.getByRole('button', { name: 'Start building' }).click();
    const chat = win.getByRole('complementary', { name: 'AI assistant' });
    await expect(chat.getByText('I added the steps.')).toBeVisible({ timeout: 15_000 });
    await expect(chat.getByText('Studio checked the new steps')).toBeVisible();
    await expect(chat.getByText('Fixed the log message.')).toBeVisible({ timeout: 15_000 });
    await expect(win.getByLabel('Automation name')).toHaveValue('Read the orders file');
    const canvas = win.getByRole('main');
    await expect(canvas.getByText('Read orders', { exact: true })).toBeVisible();
    await expect(canvas.getByText('Log orders', { exact: true })).toBeVisible();

    // Another change, then Undo from the chat.
    await chat.getByLabel('Message to the AI assistant').fill('Also log Done at the end');
    await chat.getByLabel('Message to the AI assistant').press('Enter');
    const added = chat.getByRole('group', { name: 'Assistant answer' }).filter({ hasText: 'Added it.' });
    await expect(added).toBeVisible({ timeout: 15_000 });
    await expect(canvas.getByText('Say done', { exact: true })).toBeVisible();
    await added.getByRole('button', { name: 'Undo' }).click();
    await expect(canvas.getByText('Say done', { exact: true })).toHaveCount(0);
    await expect(added.getByText('Undone')).toBeVisible();
    // An answer that can't be used says so and shows what the model wrote.
    await chat.getByLabel('Message to the AI assistant').fill('Say something odd');
    await chat.getByLabel('Message to the AI assistant').press('Enter');
    const odd = chat.getByRole('group', { name: 'Assistant answer' }).filter({ hasText: "didn't fit" });
    await expect(odd).toBeVisible({ timeout: 15_000 });
    await odd.getByText('What the AI model answered').click();
    await expect(odd.getByText('{"result":1}')).toBeVisible();
    await chat.getByRole('button', { name: 'Close the AI assistant' }).click();

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

    // The AI step: the Studio asks the model through the Orchestrator during a test run.
    const library = win.getByRole('complementary', { name: 'Step library' });
    await library.getByRole('button', { name: 'Ask the AI assistant' }).click();
    await props.locator('#param-task').click();
    await win.getByRole('option', { name: 'Summarise' }).click();
    await props.getByRole('textbox', { name: 'Text' }).fill('{{orders}}');
    await library.getByRole('button', { name: 'Write to log' }).click();
    await props.getByRole('textbox', { name: 'Message' }).fill('AI says: {{ai_answer}}');
    await expect(win.getByText('Saved')).toBeVisible({ timeout: 5_000 });
    await win.getByRole('button', { name: 'Test run' }).click();
    await expect(win.getByText('AI says: Summary: 17 orders')).toBeVisible({ timeout: 30_000 });
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
