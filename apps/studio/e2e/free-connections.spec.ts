import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTarget } from './target';

let app: ElectronApplication;
let win: Page;
let userData: string;

test.beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'autoflow-free-'));
  app = await electron.launch({ ...launchTarget(), env: { ...process.env, AUTOFLOW_USER_DATA: userData } });
  win = await app.firstWindow();
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForFunction(() => window.autoflow.engine.status().then((s) => s.state === 'ready'), null, { timeout: 30_000 });
});

test.afterEach(async () => {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
});

async function settled(locator: Locator) {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const box = await locator.boundingBox();
    const now = JSON.stringify(box);
    if (box && now === last) return box;
    last = now;
    await win.waitForTimeout(100);
  }
  throw new Error('The chart kept moving');
}

/** Drag a connector from one dot to another. */
async function drawConnector(from: Locator, to: Locator) {
  const a = await settled(from);
  const b = await settled(to);
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await win.mouse.down();
  await win.mouse.move(a.x + 40, a.y + 10, { steps: 5 });
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 });
  await win.mouse.up();
}

const card = (text: string) => win.locator('[data-step-id]', { hasText: text });
const dot = (stepId: string, handle: string) =>
  win.locator(`.react-flow__node[data-id="s:${stepId}"] .react-flow__handle[data-handleid="${handle}"]`);

test('steps are connected by hand, can stay unconnected, and only connected ones run', async () => {
  await win.getByRole('button', { name: 'New automation' }).click();
  await win.getByLabel('Name').fill('Free');
  await win.getByRole('button', { name: 'Create' }).click();
  const canvas = win.getByTestId('flow-canvas');
  await expect(canvas).toHaveAttribute('data-free', '1');
  const library = win.getByRole('complementary', { name: 'Step library' });
  const props = win.getByRole('complementary', { name: 'Properties' });
  const log = async (text: string) => {
    await library.getByRole('button', { name: 'Write to log' }).click();
    await props.getByRole('textbox', { name: 'Message' }).fill(text);
    await expect(card(text)).toBeVisible();
  };

  // The first step is connected to Start, the next one after the selected step.
  await log('one');
  await log('two');
  // Nothing selected: the new step stays on its own.
  await canvas.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
  await log('spare');
  await expect(card('spare')).toContainText('not connected');
  await expect(card('one')).not.toContainText('not connected');

  await win.getByRole('button', { name: 'Test run' }).click();
  await expect(win.getByText('Finished successfully')).toBeVisible({ timeout: 30_000 });
  // The run log shows the messages of the connected steps only ("spare" never ran).
  const runPanel = win.getByRole('region', { name: 'Run and problems' });
  await expect(runPanel.getByText('two', { exact: true })).toBeVisible();
  await expect(runPanel.getByText('spare', { exact: true })).toHaveCount(0);

  // A step dragged from the library onto an empty spot lands there, unconnected.
  const source = library.getByRole('button', { name: 'Set variable' });
  const from = (await source.boundingBox())!;
  const pane = (await settled(canvas))!;
  await win.mouse.move(from.x + 20, from.y + from.height / 2);
  await win.mouse.down();
  await win.mouse.move(from.x + 60, from.y + from.height / 2, { steps: 5 });
  await win.mouse.move(pane.x + 120, pane.y + pane.height - 120, { steps: 15 });
  await win.mouse.up();
  await expect(win.locator('[data-step-id]', { hasText: 'Set variable' })).toContainText('not connected');

  // Connect "two" to "spare" by hand.
  const ids = {
    one: (await card('one').getAttribute('data-step-id'))!,
    two: (await card('two').getAttribute('data-step-id'))!,
    spare: (await card('spare').getAttribute('data-step-id'))!,
  };
  await drawConnector(dot(ids.two, 'out'), dot(ids.spare, 'in'));
  await expect(card('spare')).not.toContainText('not connected');

  // Take out the connector between "one" and "two": both after it are on their own now.
  await win.locator(`[data-link="${ids.one}:next"]`).hover();
  await win.locator(`[data-link="${ids.one}:next"]`).getByRole('button', { name: 'Remove this connector' }).click();
  await expect(card('two')).toContainText('not connected');
  await expect(card('spare')).toContainText('not connected');

  // ...and back: drag from "one" again.
  await drawConnector(dot(ids.one, 'out'), dot(ids.two, 'in'));
  await expect(card('spare')).not.toContainText('not connected');
});

test('a Decision has a Yes and a No to connect, and the List view shows the run order', async () => {
  await win.getByRole('button', { name: 'New automation' }).click();
  await win.getByLabel('Name').fill('Decide');
  await win.getByRole('button', { name: 'Create' }).click();
  const library = win.getByRole('complementary', { name: 'Step library' });
  await library.getByRole('button', { name: 'Decision' }).click();
  const decision = (await win.locator('[data-step-id]').first().getAttribute('data-step-id'))!;
  await expect(dot(decision, 'yes')).toBeVisible();
  await expect(dot(decision, 'no')).toBeVisible();
  // The next steps go on Yes, then on No.
  await library.getByRole('button', { name: 'Write to log' }).click();
  await win.getByRole('complementary', { name: 'Properties' }).getByRole('textbox', { name: 'Message' }).fill('on yes');
  await win.locator(`[data-step-id="${decision}"]`).click();
  await library.getByRole('button', { name: 'Write to log' }).click();
  await win.getByRole('complementary', { name: 'Properties' }).getByRole('textbox', { name: 'Message' }).fill('on no');
  await expect(win.locator(`[data-link="${decision}:yes"]`)).toHaveCount(1);
  await expect(win.locator(`[data-link="${decision}:no"]`)).toHaveCount(1);

  await win.getByRole('radio', { name: 'List' }).or(win.getByRole('button', { name: 'List', exact: true })).first().click();
  await expect(win.getByText('Free connections: the steps in the order they run.')).toBeVisible();
  await expect(win.getByRole('region', { name: 'Not connected' })).toHaveCount(0);
});

test('the switch turns free connections off again when the steps are in one line', async () => {
  await win.getByRole('button', { name: 'New automation' }).click();
  await win.getByLabel('Name').fill('Line');
  await win.getByRole('button', { name: 'Create' }).click();
  const library = win.getByRole('complementary', { name: 'Step library' });
  await library.getByRole('button', { name: 'Write to log' }).click();
  await library.getByRole('button', { name: 'Write to log' }).click();
  const toggle = win.getByRole('switch', { name: 'Free connections' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(win.getByTestId('flow-canvas')).not.toHaveAttribute('data-free', '1');
  await toggle.click();
  await expect(win.getByTestId('flow-canvas')).toHaveAttribute('data-free', '1');
  await expect(win.locator('.react-flow__edge')).not.toHaveCount(0);
});
