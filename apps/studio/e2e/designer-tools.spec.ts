// Release B: Brity-style designer conveniences.
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTarget } from './target';

let app: ElectronApplication;
let win: Page;
let userData: string;

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

const saved = (id: string) => win.evaluate((flowId) => window.autoflow.flows.get(flowId), id);
const log = (id: string, message: string) => ({ id, activity: 'control.log', params: { message } });
const step = (id: string) => win.getByTestId('flow-canvas').locator(`[data-step-id="${id}"]`);
const inspector = () => win.getByRole('complementary', { name: 'Properties' });

test('select several steps, group them, copy and paste, fold the group', async () => {
  await open({
    id: 'flow_tools',
    name: 'Tools',
    steps: [log('a', 'A'), log('b', 'B'), log('c', 'C')],
  });
  await step('a').click();
  await step('b').click({ modifiers: ['Control'] });
  await expect(inspector().getByRole('heading', { name: '2 steps selected' })).toBeVisible();

  await win.keyboard.press('Control+G');
  await expect
    .poll(async () => (await saved('flow_tools'))!.steps!.map((s) => s.activity))
    .toEqual(['control.group', 'control.log']);
  const group = (await saved('flow_tools'))!.steps![0]!;
  expect(group.blocks!.body!.map((s) => s.id)).toEqual(['a', 'b']);

  // Copy the group, paste it after C (the pasted copy gets new ids).
  await step(group.id).click();
  await win.keyboard.press('Control+C');
  await step('c').click();
  await win.keyboard.press('Control+V');
  await expect.poll(async () => (await saved('flow_tools'))!.steps!.length).toBe(3);
  const after = (await saved('flow_tools'))!.steps!;
  expect(after.map((s) => s.activity)).toEqual(['control.group', 'control.log', 'control.group']);
  expect(after[2]!.id).not.toBe(group.id);
  expect(after[2]!.blocks!.body!.map((s) => s.params!.message)).toEqual(['A', 'B']);

  // Fold the first group away.
  await step(group.id).getByRole('button', { name: 'Fold' }).click();
  await expect(step(group.id)).toContainText('2 steps inside');
  await expect(step('a')).toHaveCount(0);
  await expect.poll(async () => (await saved('flow_tools'))!.layout?.collapsed).toEqual([group.id]);

  // Shift + drag a box around everything: all top-level steps get selected.
  const canvas = win.getByTestId('flow-canvas');
  await canvas.getByRole('button', { name: 'fit view' }).click();
  const box = (await canvas.boundingBox())!;
  await win.keyboard.down('Shift');
  await win.mouse.move(box.x + 8, box.y + 8);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width - 200, box.y + box.height - 8, { steps: 8 });
  await win.mouse.up();
  await win.keyboard.up('Shift');
  await expect(inspector().getByRole('heading', { name: /steps selected/ })).toBeVisible();
});

test('find a step, change its kind, Switch / case lanes', async () => {
  await open({
    id: 'flow_find',
    name: 'Finder',
    steps: [
      log('a', 'Start'),
      {
        id: 'sw',
        activity: 'control.switch',
        params: { value: '{{status}}', cases: ['Paid'] },
        blocks: { case_1: [log('p', 'Paid one')], default: [] },
      },
      log('z', 'Invoice archived'),
    ],
    variables: [{ name: 'status', default: 'Paid' }],
  });
  const canvas = win.getByTestId('flow-canvas');
  await expect(canvas.getByText('Paid', { exact: true })).toBeVisible();
  await expect(canvas.getByText('Otherwise', { exact: true })).toBeVisible();

  // A new case gets its own lane; steps stay with their case.
  await step('sw').click();
  await inspector().locator('#param-cases').fill('Late');
  await inspector().locator('#param-cases').press('Enter');
  await expect(canvas.getByText('Late', { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await saved('flow_find'))!.steps![1]!.params!.cases)
    .toEqual(['Paid', 'Late']);
  expect((await saved('flow_find'))!.steps![1]!.blocks!.case_1!.map((s) => s.id)).toEqual(['p']);

  // Ctrl+F finds a step by what it does.
  await win.getByTestId('flow-canvas').click({ position: { x: 20, y: 20 } });
  await win.keyboard.press('Control+F');
  await win.getByRole('textbox', { name: 'Find a step' }).fill('archived');
  await win.keyboard.press('Enter');
  await expect(step('z')).toHaveAttribute('aria-pressed', 'true');

  // Change "Write to log" into "Show message": the message is kept.
  await inspector().getByRole('button', { name: 'Change step type' }).click();
  await win.getByLabel('Search steps').fill('show message');
  await win.getByRole('option', { name: /^Show message/ }).click();
  await expect(inspector().getByRole('heading', { name: 'Show message' })).toBeVisible();
  await expect
    .poll(async () => (await saved('flow_find'))!.steps![2])
    .toMatchObject({
      id: 'z',
      activity: 'control.message',
      params: { message: 'Invoice archived' },
    });

  // A message nobody answers in a test closes by itself.
  await inspector().locator('#param-close_after').fill('0.5');

  // The test run takes the Paid lane.
  await win.getByRole('button', { name: 'Test run' }).click();
  await expect(win.getByText('Finished successfully')).toBeVisible({ timeout: 30_000 });
  await expect(
    win.getByRole('region', { name: 'Run and problems' }).getByText('Paid one'),
  ).toBeVisible();
});

test('the debug console works out formulas with the values of a paused run', async () => {
  await open({
    id: 'flow_console',
    name: 'Console',
    variables: [{ name: 'amount', type: 'number', default: 21 }],
    steps: [log('a', 'Before'), log('b', 'Amount {{amount}}')],
  });
  await step('b').click();
  await win.keyboard.press('F9'); // pause here when testing
  await win.getByRole('button', { name: 'Test run' }).click();
  await expect(step('b')).toContainText('Amount');
  await win.getByRole('tab', { name: /Console/ }).click();
  await expect
    .poll(async () => win.evaluate(() => document.body.innerText.includes('Paused')))
    .toBe(true);
  await win.getByRole('textbox', { name: 'Formula to work out' }).fill('amount * 2');
  await win.keyboard.press('Enter');
  await expect(win.getByText('42', { exact: true })).toBeVisible();
  await win.getByRole('button', { name: 'Stop' }).first().click();
});
