import type { Catalog, Element } from '@autoflow/flow-types';
import catalogJson from '@autoflow/flow-types/activity-catalog.json';
import { hasIcon } from '@autoflow/ui';
import { describe, expect, it } from 'vitest';
import {
  CatalogIndex,
  columnRef,
  createStep,
  exprLabel,
  humanize,
  parseTemplate,
  rootVariable,
  sentence,
  serializeSegments,
  uniqueName,
} from './catalog';

const index = new CatalogIndex(catalogJson as unknown as Catalog);
const def = (id: string) => index.get(id)!;

describe('fields', () => {
  it('infers widgets from the schema', () => {
    const kinds = Object.fromEntries(
      index.fields(def('browser.type')).map((f) => [f.name, f.kind]),
    );
    expect(kinds).toMatchObject({
      element: 'element',
      text: 'text',
      clear_first: 'boolean',
      timeout: 'number',
    });
    const timeout = index.fields(def('browser.type')).find((f) => f.name === 'timeout')!;
    expect(timeout.nullable && timeout.advanced).toBe(true);
  });

  it('recognises conditions, choices and object lists', () => {
    expect(index.fields(def('control.if'))[0]!.kind).toBe('condition');
    const level = index.fields(def('control.log')).find((f) => f.name === 'level')!;
    expect(level.kind).toBe('choice');
    expect(level.options!.map((o) => o.label)).toEqual(['Info', 'Warning', 'Error']);
    const calcs = index.fields(def('data.group')).find((f) => f.name === 'calculations')!;
    expect(calcs.kind).toBe('object_list');
    expect(calcs.itemFields!.map((f) => f.name)).toEqual(['column', 'function', 'result_column']);
  });

  it('every activity can produce fields and has a known icon', () => {
    for (const a of index.catalog.activities) {
      expect(() => index.fields(a)).not.toThrow();
      expect(hasIcon(a.icon), `${a.id} icon ${a.icon}`).toBe(true);
    }
  });
});

describe('createStep', () => {
  it('pre-fills outputs, blocks and condition rules', () => {
    const step = createStep(def('control.if'), index);
    expect(step.blocks).toEqual({ then: [], else: [] });
    expect(step.params!.condition).toMatchObject({ rules: [{ op: 'equals' }] });
    const read = createStep(def('excel.read'), index, new Set(['excel_data']));
    expect(read.outputs).toEqual({ table: 'excel_data_2' });
  });
});

describe('templates', () => {
  it('parses and serializes', () => {
    const text = 'Hi {{name}}, total {{ROUND(x, 2)}}!';
    const segs = parseTemplate(text);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'expr', 'text', 'expr', 'text']);
    expect(serializeSegments(segs)).toBe('Hi {{name}}, total {{ROUND(x, 2)}}!');
  });

  it('labels references', () => {
    expect(exprLabel('row["Invoice No"]')).toEqual({ label: 'row › Invoice No', formula: false });
    expect(exprLabel('login.username')).toEqual({ label: 'login › username', formula: false });
    expect(exprLabel('UPPER(name)').formula).toBe(true);
    expect(columnRef('row', 'Say "hi"')).toBe('row["Say \\"hi\\""]');
    expect(exprLabel(columnRef('row', 'Say "hi"')).label).toBe('row › Say "hi"');
    expect(rootVariable('row["x"]')).toBe('row');
    expect(rootVariable('1 + 2')).toBeNull();
  });

  it('humanizes', () => {
    expect(humanize('title contains')).toBe('Title contains');
    expect(humanize('at_cell')).toBe('At cell');
    expect(humanize('UPPER CASE')).toBe('UPPER CASE');
    expect(uniqueName('x', new Set(['x', 'x_2']))).toBe('x_3');
  });
});

describe('sentence', () => {
  const elements = new Map<string, Element>([
    [
      'e1',
      {
        id: 'e1',
        name: 'Login button',
        kind: 'web',
        selectors: [{ strategy: 'css', value: '#b' }],
      },
    ],
  ]);
  const ctx = { index, elements };

  it('renders values, elements and empty required settings', () => {
    const parts = sentence(
      { id: 's', activity: 'browser.type', params: { text: '{{row["Name"]}}', element: 'e1' } },
      def('browser.type'),
      ctx,
    );
    const values = parts.filter((p) => p.kind === 'value');
    expect(values.map((p) => p.kind === 'value' && p.field)).toEqual(['text', 'element']);
    expect(values[1]!.kind === 'value' && values[1]!.element?.name).toBe('Login button');
    const empty = sentence(
      { id: 's', activity: 'control.log', params: {} },
      def('control.log'),
      ctx,
    );
    expect(empty.find((p) => p.kind === 'value')).toMatchObject({ empty: true, required: true });
  });

  it('summarises conditions', () => {
    const parts = sentence(
      {
        id: 's',
        activity: 'control.if',
        params: {
          condition: {
            match: 'any',
            rules: [
              { left: '{{total}}', op: 'greater', right: '100' },
              { left: '{{name}}', op: 'is_empty' },
            ],
          },
        },
      },
      def('control.if'),
      ctx,
    );
    const value = parts.find((p) => p.kind === 'value')!;
    expect(value.kind === 'value' && serializeSegments(value.segments)).toBe(
      '{{total}} is greater than 100 or {{name}} is empty',
    );
  });
});
