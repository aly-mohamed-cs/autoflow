import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTarget } from './target';

test('add a credential, choose it in a step and use it in a test run', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'autoflow-cred-'));
  const app = await electron.launch({ ...launchTarget(), env: { ...process.env, AUTOFLOW_USER_DATA: userData } });
  try {
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.waitForFunction(() => window.autoflow.engine.status().then((s) => s.state === 'ready'), null, { timeout: 30_000 });

    // Add it on the Credentials page.
    await win.getByRole('button', { name: 'Credentials' }).click();
    await win.getByRole('button', { name: 'Add credential' }).click();
    await win.locator('#cred-name').fill('Vendor portal');
    await win.locator('#cred-user').fill('robot01');
    await win.locator('#cred-pass').fill('test-only-password');
    await win.getByRole('button', { name: 'Save' }).click();
    await expect(win.getByText('Credential saved')).toBeVisible();
    await expect(win.getByText('robot01 · updated')).toBeVisible();

    // Choose it in "Get credential".
    await win.getByRole('button', { name: 'Automations' }).click();
    await win.getByRole('button', { name: 'New automation' }).click();
    await win.getByLabel('Name').fill('Sign in');
    await win.getByRole('button', { name: 'Create' }).click();
    const library = win.getByRole('complementary', { name: 'Step library' });
    const props = win.getByRole('complementary', { name: 'Properties' });
    await library.getByRole('button', { name: 'Get credential' }).click();
    await props.locator('#param-credential').click();
    await win.getByRole('option', { name: 'Vendor portal' }).click();
    await expect(props.locator('#param-credential')).toHaveText('Vendor portal');
    await library.getByRole('button', { name: 'Write to log' }).click();
    await props.getByRole('textbox', { name: 'Message' }).fill('User {{login.username}}');
    await expect(win.getByText('Saved', { exact: true })).toBeVisible({ timeout: 5_000 });

    await win.getByRole('button', { name: 'Test run' }).click();
    await expect(win.getByText('Finished successfully')).toBeVisible({ timeout: 30_000 });
    await expect(win.getByText('User robot01')).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('add a credential right from the step that needs it', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'autoflow-cred-'));
  const app = await electron.launch({ ...launchTarget(), env: { ...process.env, AUTOFLOW_USER_DATA: userData } });
  try {
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.waitForFunction(() => window.autoflow.engine.status().then((s) => s.state === 'ready'), null, { timeout: 30_000 });
    await win.getByRole('button', { name: 'New automation' }).click();
    await win.getByLabel('Name').fill('Sign in');
    await win.getByRole('button', { name: 'Create' }).click();
    const library = win.getByRole('complementary', { name: 'Step library' });
    const props = win.getByRole('complementary', { name: 'Properties' });
    await library.getByRole('button', { name: 'Get credential' }).click();
    await props.getByRole('button', { name: 'Add a credential' }).click();
    const dialog = win.getByRole('dialog', { name: 'Add credential' });
    await dialog.locator('#cred-name').fill('ERP login');
    await dialog.locator('#cred-user').fill('erp-robot');
    await dialog.locator('#cred-pass').fill('test-only-password');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(props.locator('#param-credential')).toHaveText('ERP login');

    await library.getByRole('button', { name: 'Write to log' }).click();
    await props.getByRole('textbox', { name: 'Message' }).fill('As {{login.username}}');
    await expect(win.getByText('Saved', { exact: true })).toBeVisible({ timeout: 5_000 });
    await win.getByRole('button', { name: 'Test run' }).click();
    await expect(win.getByText('As erp-robot')).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
