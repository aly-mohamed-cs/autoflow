// Starting points offered when creating an automation. Each builds a fresh flow
// with new step ids; settings the user must fill in are left empty so the
// editor highlights them.
import type { Flow, Step } from '@autoflow/flow-types';
import { newStepId } from './flowOps';

export interface Template {
  id: string;
  title: string;
  description: string;
  icon: string;
  category: string;
  build(): Pick<Flow, 'steps' | 'variables' | 'flowchart'>;
}

const s = (
  activity: string,
  params: Record<string, unknown> = {},
  extra: Partial<Step> = {},
): Step => ({
  id: newStepId(),
  activity,
  params,
  ...extra,
});

export const TEMPLATES: Template[] = [
  {
    id: 'blank',
    title: 'Start from scratch',
    description: 'An empty automation. Add steps from the panel on the left and connect them as you like.',
    icon: 'plus',
    category: 'Control',
    // Free connections: steps are connected by hand (and may stay unconnected).
    build: () => ({ steps: [], variables: [], flowchart: { links: [], positions: { start: { x: 0, y: 0 } } } }),
  },
  {
    id: 'excel-to-web',
    title: 'Excel rows into a website',
    description: 'Read a sheet, type each row into a web form, and write the result back to Excel.',
    icon: 'sheet',
    category: 'Excel',
    build: () => ({
      variables: [
        {
          name: 'excel_file',
          type: 'file',
          is_input: true,
          description: 'The Excel file to process',
        },
      ],
      steps: [
        s('control.comment', {
          text: 'Pick the Excel file under "Start values", then pick the form fields on the website.',
        }),
        s('excel.read', { file: '{{excel_file}}' }, { outputs: { table: 'rows' } }),
        s('browser.open', { url: '' }),
        s(
          'control.for_each',
          { items: '{{rows}}', item_variable: 'row', index_variable: 'row_number' },
          {
            blocks: {
              body: [
                s('browser.type', { element: '', text: '' }),
                s('browser.click', { element: '' }),
                s('browser.get_text', { element: '' }, { outputs: { text: 'result' } }),
                s('excel.update_row', {
                  file: '{{excel_file}}',
                  row_number: '{{row_number}}',
                  values: { Result: '{{result}}' },
                }),
              ],
            },
          },
        ),
        s('browser.close'),
      ],
    }),
  },
  {
    id: 'excel-to-desktop',
    title: 'Excel rows into a desktop app',
    description:
      'Type each row of a sheet into a Windows application (ERP, accounting...) and save the result.',
    icon: 'app-window',
    category: 'Desktop',
    build: () => ({
      variables: [
        {
          name: 'excel_file',
          type: 'file',
          is_input: true,
          description: 'The Excel file to process',
        },
      ],
      steps: [
        s('control.comment', {
          text: 'Pick the program, then use "Pick on screen" on each field: point at it and press Ctrl.',
        }),
        s('excel.read', { file: '{{excel_file}}' }, { outputs: { table: 'rows' } }),
        s('desktop.launch', { program: '', window: '' }),
        s(
          'control.for_each',
          { items: '{{rows}}', item_variable: 'row', index_variable: 'row_number' },
          {
            blocks: {
              body: [
                s('desktop.type', { element: '', text: '' }),
                s('desktop.click', { element: '' }),
                s('desktop.wait_for', { element: '', state: 'text contains', text: '' }),
                s('desktop.get_text', { element: '' }, { outputs: { text: 'result' } }),
                s('excel.update_row', {
                  file: '{{excel_file}}',
                  row_number: '{{row_number}}',
                  values: { Result: '{{result}}' },
                }),
              ],
            },
          },
        ),
      ],
    }),
  },
  {
    id: 'merge-reports',
    title: 'Combine Excel reports',
    description:
      'Stack every Excel file in a folder into one table, total it, and save a summary workbook.',
    icon: 'merge',
    category: 'Data',
    build: () => ({
      variables: [
        {
          name: 'reports_folder',
          type: 'file',
          is_input: true,
          description: 'Folder with the reports',
        },
        { name: 'all_rows', type: 'table' },
      ],
      steps: [
        s(
          'files.list',
          { folder: '{{reports_folder}}', pattern: '*.xlsx' },
          { outputs: { files: 'report_files' } },
        ),
        s(
          'control.for_each',
          { items: '{{report_files}}', item_variable: 'report' },
          {
            blocks: {
              body: [
                s('excel.read', { file: '{{report}}' }, { outputs: { table: 'report_rows' } }),
                s(
                  'data.append_tables',
                  { first: '{{all_rows}}', second: '{{report_rows}}' },
                  { outputs: { table: 'all_rows' } },
                ),
              ],
            },
          },
        ),
        s(
          'data.group',
          {
            table: '{{all_rows}}',
            group_by: [],
            calculations: [{ column: '', function: 'sum', result_column: '' }],
          },
          { outputs: { table: 'summary' } },
        ),
        s('excel.write_table', { table: '{{summary}}', file: '', sheet: 'Summary' }),
        s('control.log', {
          message: 'Combined {{COUNT(report_files)}} reports into {{COUNT(all_rows)}} rows.',
        }),
      ],
    }),
  },
  {
    id: 'process-folder',
    title: 'Process new files in a folder',
    description: 'Wait for files to arrive, handle each one, then move it to a "done" folder.',
    icon: 'folder-input',
    category: 'Files',
    build: () => ({
      variables: [
        { name: 'inbox_folder', type: 'file', is_input: true, description: 'Folder to watch' },
      ],
      steps: [
        s(
          'files.list',
          { folder: '{{inbox_folder}}', pattern: '*.*', sort_by: 'oldest' },
          { outputs: { files: 'files' } },
        ),
        s(
          'control.if',
          {
            condition: { match: 'all', rules: [{ left: '{{files}}', op: 'is_empty', right: '' }] },
          },
          {
            blocks: {
              then: [s('control.stop', { outcome: 'succeeded', message: 'No new files.' })],
              else: [],
            },
          },
        ),
        s(
          'control.for_each',
          { items: '{{files}}', item_variable: 'file' },
          {
            blocks: {
              body: [
                s(
                  'control.try',
                  {},
                  {
                    blocks: {
                      try: [
                        s('control.comment', { text: 'Add the steps that handle {{file}} here.' }),
                        s('files.move', {
                          source: '{{file}}',
                          destination: '{{inbox_folder}}\\done',
                        }),
                      ],
                      catch: [
                        s('files.move', {
                          source: '{{file}}',
                          destination: '{{inbox_folder}}\\failed',
                        }),
                      ],
                      finally: [],
                    },
                  },
                ),
              ],
            },
          },
        ),
      ],
    }),
  },
];
