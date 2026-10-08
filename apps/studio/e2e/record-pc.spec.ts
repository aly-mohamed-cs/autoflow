import { _electron as electron, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchTarget } from './target';

// Real mouse and keyboard input in a WinForms app: needs Windows, the built demo ERP
// (engine/tests/test_desktop.py builds it) and the engine's Python environment.
const DEMO_ERP = resolve(__dirname, '..', '..', '..', 'testbed', 'desktop-erp', 'out', 'DemoErp.exe');
const PYTHON = resolve(__dirname, '..', '..', '..', 'engine', '.venv', 'Scripts', 'python.exe');

test.skip(process.platform !== 'win32' || !existsSync(DEMO_ERP) || !existsSync(PYTHON), 'needs Windows and the demo ERP');

test('record work in a Windows program and get desktop steps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoflow-recpc-'));
  const app = await electron.launch({ ...launchTarget(), env: { ...process.env, AUTOFLOW_USER_DATA: dir } });
  try {
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.waitForFunction(() => window.autoflow.engine.status().then((s) => s.state === 'ready'), null, { timeout: 30_000 });
    await win.getByRole('button', { name: 'New automation' }).click();
    await win.getByLabel('Name').fill('Recorded ERP entry');
    await win.getByRole('button', { name: 'Create' }).click();

    await win.getByRole('button', { name: 'Record' }).click();
    await expect(win.getByRole('radio', { name: /Anything on this PC/ })).toHaveAttribute('aria-checked', 'true');
    await win.getByRole('button', { name: 'Start recording' }).click();
    // Studio steps aside while the person works in other programs.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()), { timeout: 15_000 }).toBe(true);

    const person = spawnSync(PYTHON, [join(__dirname, 'helpers', 'fill_demo_erp.py'), DEMO_ERP], { encoding: 'utf8', timeout: 90_000 });
    expect(person.status, person.stderr).toBe(0);
    await expect(win.getByText(/3 steps so far|[4-9] steps so far/)).toBeAttached({ timeout: 10_000 });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore());
    await win.getByRole('button', { name: 'Stop & add steps' }).click();
    await expect(win.getByText(/Added \d+ recorded steps/)).toBeVisible({ timeout: 15_000 });

    const canvas = win.getByRole('main');
    await expect(canvas.getByText('Initech')).toBeVisible();
    await expect(canvas.getByText('INV-77')).toBeVisible();
    // The program was started during the recording, so the robot starts it too.
    await expect(win.getByLabel('Open application')).toContainText('DemoErp.exe');
    await expect(win.getByLabel('Click in application')).toContainText('Save invoice button');
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temp folder; Windows may still hold a file briefly */
    }
  }
});
