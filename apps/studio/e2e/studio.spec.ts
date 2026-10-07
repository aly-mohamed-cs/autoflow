import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let win: Page;
let userData: string;

test.beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'autoflow-e2e-'));
  app = await electron.launch({ args: ['.'], env: { ...process.env, AUTOFLOW_USER_DATA: userData } });
  win = await app.firstWindow();
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForFunction(() => window.autoflow.engine.status().then((s) => s.state === 'ready'), null, { timeout: 30_000 });
});

test.afterEach(async () => {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
});

async function newFlow(name: string, template = 'New automation') {
  if (template === 'New automation') await win.getByRole('button', { name: 'New automation' }).click();
  else await win.getByText(template).first().click();
  await win.getByLabel('Name').fill(name);
  await win.getByRole('button', { name: 'Create' }).click();
}

test('a template opens with its steps and highlights what to fill in', async () => {
  await newFlow('Enter vendor invoices', 'Excel rows into a website');
  await expect(win.locator('[data-step-id]')).toHaveCount(9);
  await expect(win.getByText(/to fix/).first()).toBeVisible({ timeout: 10_000 });
  await win.getByRole('button', { name: 'Back to all automations' }).click();
  await expect(win.getByText('Enter vendor invoices')).toBeVisible();
});

test('build a flow in the UI, test-run it and see results', async () => {
  await newFlow('Smoke test');
  const library = win.getByRole('complementary', { name: 'Step library' });
  const inspector = win.getByRole('complementary', { name: 'Properties' });

  await library.getByRole('button', { name: 'Set variable' }).click();
  await inspector.locator('#param-variable').fill('greeting');
  await inspector.locator('#param-variable').press('Enter');
  await inspector.getByRole('textbox', { name: 'New value' }).fill('Hello from Autoflow');

  await library.getByRole('button', { name: 'Write to log' }).click();
  await inspector.getByRole('textbox', { name: 'Message' }).fill('Message: {{UPPER(greeting)}}');
  await expect(win.getByText('Saved')).toBeVisible({ timeout: 5_000 });

  await win.getByRole('button', { name: 'Test run' }).click();
  await expect(win.getByText('Finished successfully')).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText('Message: HELLO FROM AUTOFLOW')).toBeVisible();

  await win.getByRole('tab', { name: /Variables/ }).click();
  await expect(win.getByRole('cell', { name: 'greeting' })).toBeVisible();

  // Undo removes the last step.
  await win.locator('main').click({ position: { x: 600, y: 600 } });
  await win.keyboard.press('Control+Z');
  await win.keyboard.press('Control+Z');
  await expect(win.locator('[data-step-id]')).toHaveCount(1);
});

test('a failing step shows a friendly error on the step', async () => {
  await newFlow('Failing');
  const library = win.getByRole('complementary', { name: 'Step library' });
  const inspector = win.getByRole('complementary', { name: 'Properties' });
  await library.getByRole('button', { name: 'Read text file' }).click();
  await inspector.getByRole('textbox', { name: 'File' }).fill('C:\does\not\exist.txt');
  await expect(win.getByText('Saved')).toBeVisible({ timeout: 5_000 });
  await win.getByRole('button', { name: 'Test run' }).click();
  await expect(win.getByText(/Run failed/)).toBeVisible({ timeout: 30_000 });
  await expect(inspector.getByText('This step failed in the last test run')).toBeVisible();
  await expect(inspector.getByText(/does not exist/)).toBeVisible();
});
