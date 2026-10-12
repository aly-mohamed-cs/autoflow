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
  await win.evaluate(() => {
    try {
      localStorage.removeItem('autoflow.editorView');
    } catch {
      /* ignore */
    }
  });
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
}

const saved = (id: string) => win.evaluate((flowId) => window.autoflow.flows.get(flowId), id);

/** Drag with the mouse from the middle of one element to the middle of another (or by an offset). */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(from.x + 10, from.y + 10, { steps: 4 });
  await win.mouse.move(to.x, to.y, { steps: 14 });
  await win.mouse.up();
}

/** Wait until the chart stops moving (it zooms to fit just after it opens), then measure. */
async function settledBox(locator: ReturnType<Page['locator']>) {
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

const middle = async (locator: ReturnType<Page['locator']>) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test('move steps around the flowchart, change their order by dropping on a +, switch direction, tidy up', async () => {
  const log = (id: string, message: string) => ({
    id,
    activity: 'control.log',
    params: { message },
  });
  await open({
    id: 'flow_moves',
    name: 'Moves',
    steps: [log('a', 'A'), log('b', 'B'), log('c', 'C')],
  });
  const canvas = win.getByTestId('flow-canvas');
  const b = canvas.locator('[data-step-id="b"]');
  await expect(b).toBeVisible();

  // Drag a card down: it stays where it was put, the order does not change.
  const before = await settledBox(b);
  const start = { x: before.x + 70, y: before.y + before.height / 2 };
  await drag(start, { x: start.x, y: start.y + 170 });
  await expect
    .poll(async () => (await saved('flow_moves'))?.layout?.offsets?.b?.y ?? 0)
    .toBeGreaterThan(60);
  expect((await b.boundingBox())!.y).toBeGreaterThan(before.y + 60);
  expect((await saved('flow_moves'))!.steps!.map((s) => s.id)).toEqual(['a', 'b', 'c']);

  // Let go of a card on a + : it moves to that place in the order.
  await canvas.getByRole('button', { name: 'fit view' }).click();
  const c = canvas.locator('[data-step-id="c"]');
  const cBox = await settledBox(c);
  await drag(
    { x: cBox.x + 70, y: cBox.y + cBox.height / 2 },
    await middle(canvas.locator('[data-slot="root:steps:0"]')),
  );
  await expect
    .poll(async () => (await saved('flow_moves'))!.steps!.map((s) => s.id))
    .toEqual(['c', 'a', 'b']);

  // Tidy up forgets the moves.
  await win.getByRole('button', { name: 'Tidy up' }).click();
  await expect
    .poll(async () => Object.keys((await saved('flow_moves'))?.layout?.offsets ?? {}))
    .toEqual([]);
  await expect(win.getByRole('button', { name: 'Tidy up' })).toBeDisabled();

  // Top to bottom: Start is above the first step.
  await win.getByRole('radio', { name: 'Top to bottom' }).click();
  await expect(canvas).toHaveAttribute('data-direction', 'vertical');
  await expect.poll(async () => (await saved('flow_moves'))?.layout?.direction).toBe('vertical');
  const startBox = (await canvas.getByText('Start', { exact: true }).boundingBox())!;
  expect(startBox.y).toBeLessThan((await canvas.locator('[data-step-id="c"]').boundingBox())!.y);
  if (process.env.CANVAS_SHOT)
    await win.screenshot({ path: process.env.CANVAS_SHOT.replace('.png', '-vertical.png') });
});

test('sub-processes: create one with an input, run it from the main process', async () => {
  await open({ id: 'flow_sub', name: 'With a sub-process', steps: [] });
  const library = win.getByRole('complementary', { name: 'Step library' });
  const inspector = win.getByRole('complementary', { name: 'Properties' });

  // A new sub-process opens with its name ready to type.
  await win.getByRole('button', { name: 'Sub-process', exact: true }).click();
  await win.getByRole('textbox', { name: 'Sub-process name' }).fill('Greet');
  await win.keyboard.press('Enter');
  await expect(win.getByRole('tab', { name: 'Greet' })).toHaveAttribute('aria-selected', 'true');

  // Its settings: an input called "who".
  await expect(inspector.getByRole('heading', { name: 'Sub-process' })).toBeVisible();
  await inspector.getByRole('button', { name: 'Add' }).click();
  await inspector.getByRole('textbox', { name: 'Input name' }).fill('who');

  // A step inside it.
  await library.getByRole('button', { name: 'Write to log' }).click();
  await inspector.getByRole('textbox', { name: 'Message' }).fill('Hello {{who}}');

  // The main process runs it, handing over a value.
  await win.getByRole('tab', { name: 'Main process' }).click();
  await expect(win.getByTestId('flow-canvas').locator('[data-step-id]')).toHaveCount(0);
  await library.getByRole('button', { name: 'Run sub-process' }).click();
  await inspector.locator('#param-process').click();
  await win.getByRole('option', { name: 'Greet' }).click();
  await inspector.getByRole('textbox', { name: 'Input who' }).fill('Ann');
  await expect(win.getByText('Saved')).toBeVisible({ timeout: 5_000 });

  await win.getByRole('button', { name: 'Test run' }).click();
  await expect(win.getByText('Finished successfully')).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText('Hello Ann')).toBeVisible();

  await expect
    .poll(async () => (await saved('flow_sub'))?.steps?.[0]?.params?.inputs)
    .toEqual({ who: 'Ann' });
  const flow = (await saved('flow_sub'))!;
  expect(flow.processes).toMatchObject([{ name: 'Greet', inputs: [{ name: 'who' }] }]);
  expect(flow.steps![0]).toMatchObject({
    activity: 'control.run_process',
    params: { process: flow.processes![0]!.id, inputs: { who: 'Ann' } },
  });
});

test('click steps take X, Y positions; settings appear only when they apply', async () => {
  await open({
    id: 'flow_clicks',
    name: 'Clicks',
    steps: [
      { id: 'at', activity: 'desktop.click_at', params: {} },
      { id: 'el', activity: 'desktop.click', params: {} },
    ],
  });
  const inspector = win.getByRole('complementary', { name: 'Properties' });
  await win.getByTestId('flow-canvas').locator('[data-step-id="at"]').click();
  await expect(inspector.getByRole('heading', { name: 'Click at position' })).toBeVisible();
  await expect(inspector.locator('#param-relative_to')).toHaveText('A window');
  await expect(inspector.getByText('Window title contains')).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Pick position' })).toBeVisible();
  await inspector.getByRole('textbox', { name: 'Position (X, Y)' }).fill('120, 45');

  await inspector.locator('#param-relative_to').click();
  await win.getByRole('option', { name: 'The whole screen' }).click();
  await expect(inspector.getByText('Window title contains')).toHaveCount(0);
  await expect
    .poll(async () => (await saved('flow_clicks'))!.steps![0]!.params)
    .toMatchObject({ position: '120, 45', relative_to: 'screen' });

  // A normal click can aim at a point inside its element.
  await win.getByTestId('flow-canvas').locator('[data-step-id="el"]').click();
  await expect(inspector.getByText('Point inside the element')).toBeVisible();
});
