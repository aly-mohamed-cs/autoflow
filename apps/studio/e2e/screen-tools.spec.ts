// Release C: the element inspector and the Screen steps' settings.
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchTarget } from './target';

const ERP = resolve(__dirname, '../../../testbed/desktop-erp/out/DemoErp.exe');

let app: ElectronApplication;
let win: Page;
let userData: string;
let erp: ChildProcess | null = null;

test.beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'autoflow-e2e-'));
  app = await electron.launch({
    ...launchTarget(),
    env: { ...process.env, AUTOFLOW_USER_DATA: userData },
  });
  win = await app.firstWindow();
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForFunction(
    () => window.autoflow.engine.status().then((s) => s.state === 'ready'),
    null,
    {
      timeout: 30_000,
    },
  );
});

test.afterEach(async () => {
  erp?.kill();
  erp = null;
  await app.close();
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* temp folder; Windows may still hold a file briefly */
  }
});

async function open(flow: Parameters<typeof window.autoflow.flows.save>[0]) {
  await win.evaluate((f) => window.autoflow.flows.save(f), flow);
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('button', { name: 'Automations' }).click();
  await win.getByText(flow.name).click();
  await expect(win.getByTestId('flow-canvas')).toBeVisible();
}

const inspector = () => win.getByRole('complementary', { name: 'Properties' });

test("browse a program's controls and use one as the step's element", async () => {
  test.skip(!existsSync(ERP), 'demo ERP not built (dotnet build in testbed/desktop-erp)');
  erp = spawn(ERP, [], { detached: false, stdio: 'ignore' });
  await open({
    id: 'flow_inspect',
    name: 'Inspect',
    steps: [{ id: 'c', activity: 'desktop.click', params: {} }],
  });
  await win.getByTestId('flow-canvas').locator('[data-step-id="c"]').click();
  await inspector().getByRole('button', { name: 'Other ways to choose an element' }).click();
  await win.getByRole('menuitem', { name: "Browse a program's controls…" }).click();

  const dialog = win.getByRole('dialog', { name: "Browse a program's controls" });
  await expect
    .poll(
      async () => {
        await dialog.getByRole('button', { name: 'Look for windows again' }).click();
        await expect(dialog.getByRole('combobox', { name: 'Window' })).toHaveText(
          'Choose a window',
        );
        await dialog.getByRole('combobox', { name: 'Window' }).click();
        const found = await win.getByRole('option', { name: /Demo ERP - Invoices/ }).count();
        if (!found) await win.keyboard.press('Escape');
        return found;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await win.getByRole('option', { name: /Demo ERP - Invoices/ }).click();

  // Open nodes until the Save button shows up, then use it.
  const tree = dialog.getByRole('tree', { name: 'Controls' });
  const save = tree.getByRole('treeitem', { name: /Save invoice/ });
  for (let i = 0; i < 4 && !(await save.count()); i++) {
    const closed = tree.getByRole('button', { name: 'Open' });
    const n = await closed.count();
    for (let j = 0; j < n; j++) await closed.nth(0).click();
  }
  await save.getByRole('button', { name: /Save invoice/ }).click();
  await dialog.getByRole('button', { name: 'Use this element' }).click();
  await expect(inspector().getByText('Save invoice button')).toBeVisible();
  await expect
    .poll(async () => {
      const flow = await win.evaluate(() => window.autoflow.flows.get('flow_inspect'));
      const id = flow?.steps?.[0]?.params?.element as string | undefined;
      return flow?.elements?.find((e) => e.id === id)?.selectors[0]?.options?.automation_id;
    })
    .toBe('btnSave');
});

test('Screen steps: a picture to capture, where to look, the part to read', async () => {
  await open({
    id: 'flow_screen',
    name: 'Screen',
    steps: [
      { id: 'img', activity: 'screen.click_image', params: {} },
      { id: 'txt', activity: 'screen.read_text', params: {}, outputs: { text: 'screen_text' } },
    ],
  });
  await win.getByTestId('flow-canvas').locator('[data-step-id="img"]').click();
  await expect(inspector().getByRole('heading', { name: 'Click image' })).toBeVisible();
  await expect(inspector().getByRole('button', { name: 'Capture' })).toBeVisible();
  await expect(inspector().getByRole('button', { name: 'From file' })).toBeVisible();
  await expect(inspector().getByText('Window title contains')).toHaveCount(0);
  await inspector().locator('#param-look_in').click();
  await win.getByRole('option', { name: 'A window' }).click();
  await expect(inspector().getByText('Window title contains')).toBeVisible();

  await win.getByTestId('flow-canvas').locator('[data-step-id="txt"]').click();
  await inspector().getByRole('button', { name: 'More options' }).click();
  await expect(inspector().getByRole('button', { name: 'Pick area' })).toBeVisible();
  await inspector().getByRole('textbox', { name: 'Only this part' }).fill('10, 40, 300, 120');
  await expect
    .poll(
      async () =>
        (await win.evaluate(() => window.autoflow.flows.get('flow_screen')))!.steps![1]!.params,
    )
    .toMatchObject({ region: '10, 40, 300, 120' });
});
