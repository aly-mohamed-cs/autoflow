import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTarget } from './target';

test('the Flow view shows a flowchart, adds steps on connectors and switches to the list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoflow-canvas-'));
  const app = await electron.launch({
    ...launchTarget(),
    env: { ...process.env, AUTOFLOW_USER_DATA: dir },
  });
  try {
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.evaluate(() => {
      try {
        localStorage.removeItem('autoflow.editorView'); // start from the default (Flow)
      } catch {
        /* ignore */
      }
    });
    await win.waitForFunction(
      () => window.autoflow.engine.status().then((s) => s.state === 'ready'),
      null,
      { timeout: 30_000 },
    );
    await win.evaluate(() =>
      window.autoflow.flows.save({
        id: 'flow_canvas',
        name: 'Canvas demo',
        variables: [{ name: 'rows', type: 'table' }],
        steps: [
          {
            id: 'read',
            activity: 'excel.read',
            params: { file: 'C:\\Data\\orders.xlsx' },
            outputs: { table: 'rows' },
          },
          {
            id: 'check',
            activity: 'control.if',
            params: {
              condition: {
                match: 'all',
                rules: [{ left: '{{COUNT(rows)}}', op: 'greater', right: '0' }],
              },
            },
            blocks: {
              then: [
                {
                  id: 'loop',
                  activity: 'control.for_each',
                  params: { items: '{{rows}}', item_variable: 'row' },
                  blocks: {
                    body: [
                      {
                        id: 'note',
                        activity: 'control.log',
                        params: { message: 'Order {{row["Number"]}}' },
                      },
                    ],
                  },
                },
              ],
              else: [],
            },
          },
          { id: 'done', activity: 'control.log', params: { message: 'Finished' } },
        ],
      }),
    );
    await win.getByRole('button', { name: 'Settings' }).click();
    await win.getByRole('button', { name: 'Automations' }).click();
    await win.getByText('Canvas demo').click();

    const canvas = win.getByTestId('flow-canvas');
    await expect(canvas.getByText('Start', { exact: true })).toBeVisible();
    await expect(canvas.getByText('End', { exact: true })).toBeVisible();
    await expect(canvas.getByText('Yes', { exact: true })).toBeVisible();
    await expect(canvas.getByText('No', { exact: true })).toBeVisible();
    await expect(canvas.getByText('next')).toBeVisible(); // the loop's arrow back
    await expect(canvas.locator('[data-step-id]')).toHaveCount(5);
    if (process.env.CANVAS_SHOT) await win.screenshot({ path: process.env.CANVAS_SHOT });

    // + on the connector right after Start inserts a step first in the flow.
    await canvas
      .locator('[data-slot="root:steps:0"]')
      .getByRole('button', { name: 'Add a step here' })
      .click();
    await win.getByLabel('Search steps').fill('wait');
    await win.getByRole('option', { name: /^Wait(?! for)/ }).click();
    await expect(
      win.getByRole('complementary', { name: 'Properties' }).getByRole('heading', { name: 'Wait' }),
    ).toBeVisible();
    await expect
      .poll(
        () =>
          win.evaluate(() =>
            window.autoflow.flows.get('flow_canvas').then((f) => f!.steps![0]!.activity),
          ),
        { timeout: 10_000 },
      )
      .toBe('control.wait');

    // Steps dragged from the library drop onto a connector (here: right after Start).
    const library = win.getByRole('complementary', { name: 'Step library' });
    const source = library.getByRole('button', { name: 'Write to log' });
    const slot = canvas.locator('[data-slot="root:steps:0"]');
    const from = (await source.boundingBox())!;
    await win.mouse.move(from.x + 20, from.y + from.height / 2);
    await win.mouse.down();
    await win.mouse.move(from.x + 60, from.y + from.height / 2, { steps: 5 });
    const to = (await slot.boundingBox())!;
    await win.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await win.mouse.up();
    await expect
      .poll(
        () =>
          win.evaluate(() =>
            window.autoflow.flows
              .get('flow_canvas')
              .then((f) => f!.steps!.slice(0, 2).map((s) => s.activity)),
          ),
        { timeout: 10_000 },
      )
      .toEqual(['control.log', 'control.wait']);

    // The empty "No" lane offers a place to add a step.
    await expect(canvas.getByRole('button', { name: 'Add step' })).toBeVisible();

    // "Fit view" shows the whole flow; selecting a step on the canvas opens it in the settings panel.
    await canvas.getByRole('button', { name: 'fit view' }).click();
    if (process.env.CANVAS_SHOT)
      await win.screenshot({ path: process.env.CANVAS_SHOT.replace('.png', '-fit.png') });
    await canvas.getByLabel('Write to log').last().click();
    await expect(
      win
        .getByRole('complementary', { name: 'Properties' })
        .getByRole('heading', { name: 'Write to log' }),
    ).toBeVisible();

    // The list is still there for long recordings.
    await win.getByRole('radio', { name: 'List' }).click();
    await expect(win.getByRole('list', { name: 'Steps' }).first()).toBeVisible();
    await expect(canvas).toHaveCount(0);
    await win.getByRole('radio', { name: 'Flow' }).click();
    await expect(win.getByTestId('flow-canvas')).toBeVisible();
  } finally {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temp folder; Windows may still hold a file briefly */
    }
  }
});
