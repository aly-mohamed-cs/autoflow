import type { Catalog, Flow, Step } from '@autoflow/flow-types';
import catalogJson from '@autoflow/flow-types/activity-catalog.json';
import { describe, expect, it } from 'vitest';
import { applyActions } from './assistant';
import { CatalogIndex } from './catalog';
import { chartOf, nextOf, START } from './flowchart';
import { findStep } from './flowOps';

const index = new CatalogIndex(catalogJson as unknown as Catalog);
const log = (id: string, message = id): Step => ({ id, activity: 'control.log', label: id, params: { message } });
const sequence = (steps: Step[]): Flow => ({ id: 'f', name: 'F', steps });
const chart = (steps: Step[], linked = steps): Flow => ({
  id: 'f',
  name: 'F',
  steps,
  flowchart: {
    links: linked.map((s, i) => ({ source: i ? linked[i - 1]!.id : START, target: s.id, port: 'next' as const })),
    positions: { start: { x: 0, y: 0 }, ...Object.fromEntries(steps.map((s, i) => [s.id, { x: 200 * (i + 1), y: 0 }])) },
  },
});
const ids = (flow: Flow) => (flow.steps ?? []).map((s) => s.id);
const path = (flow: Flow) => {
  const c = chartOf(flow, null)!;
  const out: string[] = [];
  for (let at = nextOf(c, START); at && !out.includes(at); at = nextOf(c, at, findStep(flow, at)?.activity === 'control.decision' ? 'yes' : 'next')) out.push(at);
  return out;
};

describe('applying the AI assistant’s changes', () => {
  it('adds steps in order, at the start, after a step and inside a loop, with the defaults of new steps', () => {
    const flow = sequence([log('a'), { id: 'loop', activity: 'control.for_each', params: { items: '{{rows}}' }, blocks: { body: [] } }]);
    const r = applyActions(
      flow,
      null,
      [
        { type: 'add_steps', after: 'a', steps: [{ id: 'x1', activity: 'excel.read', params: { file: 'C:/in.xlsx' } }] },
        { type: 'add_steps', after: 'start', steps: [log('first')] },
        { type: 'add_steps', after: 'end', steps: [log('last1'), log('last2')] },
        { type: 'add_steps', inside: { step: 'loop', block: 'wrong name' }, steps: [{ id: 'n1', activity: 'control.for_each', params: {} }] },
        { type: 'add_steps', after: 'end', steps: [{ id: 'bad', activity: 'shell.format_disk', params: {} }] },
      ],
      index,
    );
    expect(ids(r.flow)).toEqual(['first', 'a', 'x1', 'loop', 'last1', 'last2']);
    const loopDef = index.get('control.for_each')!;
    const read = findStep(r.flow, 'x1')!;
    expect(read.params).toMatchObject({ file: 'C:/in.xlsx' });
    expect(read.outputs).toEqual({ table: 'excel_data' }); // the result's default variable, as the model was told
    const loop = findStep(r.flow, 'loop')!;
    expect(loop.blocks!.body!.map((s) => s.id)).toEqual(['n1']);
    expect(findStep(r.flow, 'n1')!.blocks).toEqual({ body: [] });
    expect(r.changes).toEqual([
      'Added “Read Excel sheet” after “a”',
      'Added “first” at the start',
      'Added 2 steps',
      `Added “${loopDef.title}” to “${loopDef.title}” (${loopDef.blocks[0]!.title})`,
    ]);
    expect(r.touched).toEqual(['x1', 'first', 'last1', 'last2', 'n1']);
  });

  it('connects new steps on free connections so they run', () => {
    const flow = chart([log('a'), log('b')]);
    let r = applyActions(flow, null, [{ type: 'add_steps', after: 'end', steps: [log('c'), log('d')] }], index);
    expect(path(r.flow)).toEqual(['a', 'b', 'c', 'd']);
    r = applyActions(r.flow, null, [{ type: 'add_steps', after: 'a', steps: [log('m')] }], index);
    expect(path(r.flow)).toEqual(['a', 'm', 'b', 'c', 'd']);
    r = applyActions(r.flow, null, [{ type: 'add_steps', after: 'start', steps: [log('s')] }], index);
    expect(path(r.flow)).toEqual(['s', 'a', 'm', 'b', 'c', 'd']);
    const positions = chartOf(r.flow, null)!.positions!;
    for (const id of ['s', 'm', 'c', 'd']) expect(positions[id]).toBeDefined();
    // Removing a step keeps the path whole.
    r = applyActions(r.flow, null, [{ type: 'remove_steps', steps: ['m', 'c'] }], index);
    expect(path(r.flow)).toEqual(['s', 'a', 'b', 'd']);
    expect(r.changes).toEqual(['Removed 2 steps']);
  });

  it('connects Decisions by Yes / No, and only where free connections are on', () => {
    const decision: Step = { id: 'q', activity: 'control.decision', params: {} };
    const a = log('a');
    const flow = chart([a, decision, log('yes'), log('no')], [a]);
    const r = applyActions(
      flow,
      null,
      [
        { type: 'connect', from: 'q', to: 'yes', port: 'yes' },
        { type: 'connect', from: 'q', to: 'no', port: 'no' },
        { type: 'connect', from: 'a', to: 'no', port: 'yes' }, // a plain step has one way out
        { type: 'connect', from: 'a', to: 'ghost', port: 'next' },
      ],
      index,
    );
    const c = chartOf(r.flow, null)!;
    expect(nextOf(c, 'q', 'yes')).toBe('yes');
    expect(nextOf(c, 'q', 'no')).toBe('no');
    expect(nextOf(c, 'a')).toBe('no');
    expect(r.changes).toContain(`Connected “${index.get('control.decision')!.title}” → “no” (No)`);
    expect(r.skipped).toHaveLength(1);
    const plain = applyActions(sequence([log('a'), log('b')]), null, [{ type: 'connect', from: 'a', to: 'b', port: 'next' }], index);
    expect(plain.flow.flowchart).toBeUndefined();
    expect(plain.skipped[0]).toContain('turn on free connections first');
  });

  it('builds both sides of a new Decision in one answer, without drawing them on each other', () => {
    const flow = chart([log('a'), log('z')]);
    const r = applyActions(
      flow,
      null,
      [
        { type: 'add_steps', after: 'a', steps: [{ id: 'q', activity: 'control.decision', params: {} }, log('big')] },
        { type: 'add_steps', after: 'q', steps: [log('small')] },
      ],
      index,
    );
    const c = chartOf(r.flow, null)!;
    expect(nextOf(c, 'a')).toBe('q');
    expect(nextOf(c, 'q', 'yes')).toBe('big');
    expect(nextOf(c, 'big')).toBe('z'); // what came after "a" now follows the Yes side
    expect(nextOf(c, 'q', 'no')).toBe('small');
    const p = c.positions!;
    expect([p.big!.x, p.big!.y]).not.toEqual([p.small!.x, p.small!.y]);
    expect([p.big!.x, p.big!.y]).not.toEqual([p.z!.x, p.z!.y]);
  });

  it('builds a new automation from nothing in a tidy line', () => {
    const empty: Flow = { id: 'f', name: 'New automation', steps: [], flowchart: { links: [], positions: { start: { x: 0, y: 0 } } } };
    const r = applyActions(
      empty,
      null,
      [
        { type: 'new_automation', name: 'Vendor invoices', description: 'Types invoices into the portal' },
        { type: 'add_variable', name: 'invoice_file', variableType: 'file', is_input: true, description: 'The Excel file' },
        { type: 'add_variable', name: 'invoice_file', variableType: 'file', is_input: true, description: '' },
        { type: 'add_steps', after: 'start', steps: [log('a'), log('b'), log('c')] },
      ],
      index,
    );
    expect(r.flow).toMatchObject({ name: 'Vendor invoices', description: 'Types invoices into the portal' });
    expect(r.flow.variables).toEqual([{ name: 'invoice_file', type: 'file', is_input: true, description: 'The Excel file' }]);
    expect(path(r.flow)).toEqual(['a', 'b', 'c']);
    const p = chartOf(r.flow, null)!.positions!;
    expect(p.a!.y).toBe(p.c!.y);
    expect(p.a!.x).toBeLessThan(p.b!.x!);
    expect(p.b!.x).toBeLessThan(p.c!.x!);
    expect(r.skipped).toEqual(['Add variable invoice_file (it already exists)']);
  });

  it('changes settings and names of existing steps, and says what no longer fits', () => {
    const flow = sequence([log('a', 'hello')]);
    const r = applyActions(
      flow,
      null,
      [
        { type: 'update_step', step: 'a', params: { message: 'Hi {{name}}' }, label: 'Greet' },
        { type: 'update_step', step: 'gone', params: { message: 'x' } },
        { type: 'new_automation', name: 'Other', description: '' },
      ],
      index,
    );
    expect(findStep(r.flow, 'a')).toMatchObject({ label: 'Greet', params: { message: 'Hi {{name}}' } });
    expect(r.changes).toEqual([`Changed “a”: ${index.fields(index.get('control.log')!).find((f) => f.name === 'message')!.title}, name`]);
    expect(r.flow.name).toBe('F');
    expect(r.skipped).toHaveLength(2);
  });
});
