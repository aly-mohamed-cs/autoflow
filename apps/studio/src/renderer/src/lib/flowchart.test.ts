import type { Flow, Step } from '@autoflow/flow-types';
import { describe, expect, it } from 'vitest';
import {
  chartOf,
  connect,
  disconnect,
  insertOnLink,
  nextOf,
  normalizeCharts,
  placeNewStep,
  reachable,
  runOrder,
  START,
  toFlowchart,
  toSequence,
  tidyPositions,
} from './flowchart';
import { removeStep } from './flowOps';

const s = (id: string, activity = 'control.log'): Step => ({ id, activity, params: {} });
const base = (steps: Step[]): Flow => ({ id: 'f', name: 'F', steps });

describe('free connections', () => {
  it('switches a list of steps to a flowchart in the same order, and back', () => {
    const flow = toFlowchart(base([s('a'), s('b'), s('c')]), null, { a: { x: 1, y: 2 } });
    const chart = chartOf(flow, null)!;
    expect(chart.links).toEqual([
      { source: START, target: 'a', port: 'next' },
      { source: 'a', target: 'b', port: 'next' },
      { source: 'b', target: 'c', port: 'next' },
    ]);
    const back = toSequence(flow, null);
    expect('flow' in back && back.flow.flowchart).toBeNull();
  });

  it('connects any step to any step, one connector per way out', () => {
    let flow = toFlowchart(base([s('a'), s('b'), s('c')]), null, {});
    flow = connect(flow, null, 'a', 'c');
    expect(nextOf(chartOf(flow, null)!, 'a')).toBe('c');
    expect(chartOf(flow, null)!.links!.filter((l) => l.source === 'a')).toHaveLength(1);
    expect(connect(flow, null, 'a', START)).toBe(flow); // nothing leads into Start
    flow = disconnect(flow, null, 'b');
    expect(nextOf(chartOf(flow, null)!, 'b')).toBeNull();
    expect([...reachable(chartOf(flow, null)!)]).toEqual(['a', 'c']);
  });

  it('adds a step after the selected one, to Start, or unconnected', () => {
    let flow = toFlowchart(base([s('a'), s('b')]), null, { start: { x: 0, y: 0 }, a: { x: 150, y: 0 }, b: { x: 500, y: 0 } });
    // After a: a -> new -> b
    flow = { ...flow, steps: [...flow.steps!, s('n')] };
    flow = placeNewStep(flow, null, s('n'), 'a');
    const chart = chartOf(flow, null)!;
    expect(nextOf(chart, 'a')).toBe('n');
    expect(nextOf(chart, 'n')).toBe('b');
    expect(chart.positions!.n).toEqual({ x: 150 + 236 + 100, y: 0 });
    // Nothing selected and Start already connected: it stays unconnected.
    flow = { ...flow, steps: [...flow.steps!, s('loose')] };
    flow = placeNewStep(flow, null, s('loose'), null);
    expect(reachable(chartOf(flow, null)!).has('loose')).toBe(false);
    expect(chartOf(flow, null)!.positions!.loose).toBeDefined();
    // An empty flowchart: the first step is connected to Start.
    let empty: Flow = { ...base([s('x')]), flowchart: { links: [], positions: {} } };
    empty = placeNewStep(empty, null, s('x'), null);
    expect(nextOf(chartOf(empty, null)!, START)).toBe('x');
  });

  it('puts a Decision\'s next steps on Yes, then No', () => {
    let flow: Flow = { ...base([s('d', 'control.decision'), s('y'), s('n')]), flowchart: { links: [{ source: START, target: 'd' }] } };
    flow = placeNewStep(flow, null, s('y'), 'd');
    flow = placeNewStep(flow, null, s('n'), 'd');
    const chart = chartOf(flow, null)!;
    expect(nextOf(chart, 'd', 'yes')).toBe('y');
    expect(nextOf(chart, 'd', 'no')).toBe('n');
    expect(runOrder(flow.steps!, chart).connected.map((x) => x.id)).toEqual(['d', 'y', 'n']);
    expect(toSequence(flow, null)).toEqual({ error: expect.stringContaining('Decisions') });
  });

  it('inserts on a connector, and forgets connectors of deleted steps', () => {
    let flow = toFlowchart(base([s('a'), s('b'), s('m')]), null, { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } });
    flow = disconnect(flow, null, 'b');
    flow = insertOnLink(flow, null, { source: 'a', target: 'b' }, s('m'));
    expect(nextOf(chartOf(flow, null)!, 'a')).toBe('m');
    expect(nextOf(chartOf(flow, null)!, 'm')).toBe('b');
    flow = normalizeCharts(removeStep(flow, 'm'));
    expect(chartOf(flow, null)!.links!.some((l) => l.source === 'm' || l.target === 'm')).toBe(false);
    expect(normalizeCharts(flow)).toBe(flow); // nothing to do: same object
  });

  it('only goes back to one after the other when everything is in one line', () => {
    let flow = toFlowchart(base([s('a'), s('b'), s('c')]), null, {});
    flow = disconnect(flow, null, 'b');
    expect(toSequence(flow, null)).toEqual({ error: expect.stringContaining('not connected') });
    flow = connect(connect(flow, null, 'b', 'c'), null, 'c', 'a');
    expect(toSequence(flow, null)).toEqual({ error: expect.stringContaining('back to an earlier step') });
  });

  it('works for sub-processes too', () => {
    let flow: Flow = { ...base([]), processes: [{ id: 'p', name: 'P', steps: [s('x'), s('y')] }] };
    flow = toFlowchart(flow, 'p', {});
    expect(chartOf(flow, 'p')!.links).toHaveLength(2);
    expect(flow.flowchart).toBeUndefined();
  });

  it('tidies up: the running line first, the No side beside it, loose steps after', () => {
    const flow: Flow = {
      ...base([s('a'), s('d', 'control.decision'), s('y'), s('n'), s('z')]),
      flowchart: { links: [{ source: START, target: 'a' }, { source: 'a', target: 'd' }, { source: 'd', target: 'y', port: 'yes' }, { source: 'd', target: 'n', port: 'no' }] },
    };
    const p = tidyPositions(flow.steps!, flow.flowchart!, false);
    expect(p.a!.y).toBe(0);
    expect(p.y!.y).toBe(0);
    expect(p.n!.y).toBeGreaterThan(0);
    expect(p.z!.y).toBeGreaterThan(p.n!.y!);
    expect(p.y!.x).toBeGreaterThan(p.d!.x!);
  });
});
