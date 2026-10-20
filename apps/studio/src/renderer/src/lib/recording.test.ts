import type { Element } from '@autoflow/flow-types';
import { describe, expect, it } from 'vitest';
import {
  firstBrowserUrl,
  hasBrowserOpen,
  stepsFromRecording,
  type RecordedAction,
} from './recording';

const el = (id: string, name: string, css: string): Element => ({
  id,
  name,
  kind: 'web',
  selectors: [{ strategy: 'css', value: css }],
});

describe('stepsFromRecording', () => {
  const actions: RecordedAction[] = [
    { action: 'type', value: 'robot', element: el('a', 'Username box', '#user') },
    {
      action: 'type',
      value: null,
      password: true,
      press_enter: true,
      element: el('b', 'Password box', '#pass'),
    },
    { action: 'select', option: 'US Dollar', element: el('c', 'Currency list', '#cur') },
    { action: 'check', checked: false, element: el('d', 'Urgent checkbox', '#urgent') },
    { action: 'click', element: el('e', 'Submit button', '#go') },
    { action: 'click', element: el('f', 'Submit button', '#go') }, // same element again
    { action: 'switch_tab' },
    { action: 'goto', url: 'https://example.com/report' },
  ];

  it('makes one step per action and reuses identical elements', () => {
    const { steps, elements } = stepsFromRecording(actions, {
      startUrl: 'https://portal',
      addOpenBrowser: true,
    });
    expect(steps.map((s) => s.activity)).toEqual([
      'browser.open',
      'browser.type',
      'browser.type',
      'browser.select',
      'browser.check',
      'browser.click',
      'browser.click',
      'browser.switch_tab',
      'browser.go_to',
    ]);
    expect(elements.map((e) => e.name)).toEqual([
      'Username box',
      'Password box',
      'Currency list',
      'Urgent checkbox',
      'Submit button',
    ]);
    expect(steps[5]!.params!.element).toBe(steps[6]!.params!.element);
    expect(steps[3]!.params).toMatchObject({ option: 'US Dollar' });
    expect(steps[4]!.params).toMatchObject({ checked: false });
  });

  it('never stores passwords', () => {
    const { steps } = stepsFromRecording(actions, { addOpenBrowser: false });
    const pw = steps.find((s) => s.label?.includes('password'))!;
    expect(pw.params).toMatchObject({ text: '', press_enter: true });
  });

  it('turns work in Windows programs into desktop steps', () => {
    const box = (id: string, name: string, aid: string): Element => ({
      id,
      name,
      kind: 'desktop',
      context: { window: 'Demo ERP - Invoices', process: 'DemoErp.exe' },
      selectors: [
        {
          strategy: 'uia',
          value: `Edit #${aid}`,
          options: { automation_id: aid, control_type: 'Edit' },
        },
      ],
    });
    const { steps } = stepsFromRecording(
      [
        { action: 'launch', program: 'C:\\Apps\\DemoErp.exe', window: 'Demo ERP - Invoices' },
        { action: 'type', value: 'Initech', element: box('a', 'Customer box', 'txtCustomer') },
        { action: 'select', option: 'EUR', element: box('b', 'Currency list', 'cboCurrency') },
        { action: 'click', click: 'double', element: box('c', 'Invoice row', 'row1') },
        { action: 'keys', keys: 'Control+S' },
        { action: 'activate', window: 'Untitled - Notepad', program: 'notepad.exe' },
      ],
      { addOpenBrowser: true, startUrl: 'https://not-used' },
    );
    expect(steps.map((s) => [s.activity, s.params])).toEqual([
      ['browser.open', { url: 'https://not-used' }],
      ['desktop.launch', { program: 'C:\\Apps\\DemoErp.exe', window: 'Demo ERP - Invoices' }],
      ['desktop.type', { element: 'a', text: 'Initech' }],
      ['desktop.select', { element: 'b', option: 'EUR' }],
      ['desktop.click', { element: 'c', click: 'double' }],
      ['desktop.send_keys', { keys: 'Control+S' }],
      ['desktop.activate_window', { window: 'Untitled - Notepad', process: 'notepad.exe' }],
    ]);
  });

  it('records a click that downloaded a file as "Download file" into the Downloads folder', () => {
    const { steps } = stepsFromRecording(
      [{ action: 'download', element: el('g', 'Export to Excel link', '#export') }],
      { addOpenBrowser: false },
    );
    expect(steps.map((s) => [s.activity, s.params])).toEqual([['browser.download', { element: 'g' }]]);
  });

  it('reuses elements already in the flow and keeps names unique', () => {
    const existing = [el('x', 'Submit button', '#go'), el('y', 'Username box', '#other')];
    const { steps, elements } = stepsFromRecording(actions.slice(0, 1).concat(actions[4]!), {
      existingElements: existing,
      addOpenBrowser: false,
    });
    expect(steps[1]!.params!.element).toBe('x');
    expect(elements.map((e) => e.name)).toEqual(['Username box 2']);
  });
});

describe('flow helpers', () => {
  const flow = {
    id: 'f',
    name: 'f',
    steps: [
      {
        id: '1',
        activity: 'control.if',
        blocks: { then: [{ id: '2', activity: 'browser.open', params: { url: 'portal.local' } }] },
      },
    ],
  };
  it('finds the first browser address', () => {
    expect(firstBrowserUrl(flow)).toBe('portal.local');
    expect(hasBrowserOpen(flow)).toBe(true);
    expect(hasBrowserOpen({ id: 'g', name: 'g', steps: [] })).toBe(false);
  });
});
