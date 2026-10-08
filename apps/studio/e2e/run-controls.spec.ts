import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTarget } from './target';

test('pause and stop a test run, also from the floating bar while another program is in front', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoflow-runctl-'));
  const app = await electron.launch({ ...launchTarget(), env: { ...process.env, AUTOFLOW_USER_DATA: dir } });
  try {
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.waitForFunction(() => window.autoflow.engine.status().then((s) => s.state === 'ready'), null, { timeout: 30_000 });
    await win.evaluate(() =>
      window.autoflow.flows.save({
        id: 'flow_run_controls',
        name: 'Long wait',
        steps: [
          { id: 'wait', activity: 'control.wait', params: { seconds: 60 } },
          { id: 'log', activity: 'control.log', params: { message: 'after the wait' } },
        ],
      }),
    );
    await win.getByRole('button', { name: 'Settings' }).click();
    await win.getByRole('button', { name: 'Automations' }).click();
    await win.getByText('Long wait').click();

    const studio = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isFocusable()).length);
    const barShown = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => !w.isFocusable() && w.isVisible()));
    const stopKey = () => app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Shift+F12'));

    await win.getByRole('button', { name: 'Test run' }).click();
    await expect(win.getByText(/Running \d/)).toBeVisible();
    await expect.poll(stopKey).toBe(true); // the shortcut keys work while a run is going

    // Pause happens inside the 60-second wait, not after it.
    await win.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(win.getByText(/Paused \d/)).toBeVisible({ timeout: 5_000 });
    await win.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(win.getByText(/Running \d/)).toBeVisible({ timeout: 5_000 });

    // With another program in front (Studio minimized), the floating bar appears; Stop works from it.
    expect(await studio()).toBe(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isFocusable())!.minimize());
    await expect.poll(barShown).toBe(true);
    const bar = app.windows().find((page) => page.url().includes('view=runbar'))!;
    await expect(bar.getByText('Test run in progress')).toBeVisible();
    await bar.getByRole('button', { name: 'Stop', exact: true }).click();

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isFocusable())!.restore());
    await expect(win.getByText('Run stopped')).toBeVisible({ timeout: 5_000 });
    await expect.poll(stopKey).toBe(false); // keys released and the bar gone when the run ends
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temp folder; Windows may still hold a file briefly */
    }
  }
});
