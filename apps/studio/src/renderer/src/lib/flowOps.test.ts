import type { Flow } from '@autoflow/flow-types';
import { describe, expect, it } from 'vitest';
import {
  applyRepairPatch,
  duplicateStep,
  findStep,
  flatIds,
  insertStep,
  listKey,
  locate,
  moveStep,
  parseListKey,
  removeStep,
  ROOT,
  setParam,
} from './flowOps';

const flow: Flow = {
  id: 'f',
  name: 'f',
  steps: [
    { id: 'a', activity: 'control.log' },
    {
      id: 'if',
      activity: 'control.if',
      blocks: { then: [{ id: 'b', activity: 'control.log' }], else: [{ id: 'c', activity: 'control.log' }] },
    },
    { id: 'd', activity: 'control.log' },
  ],
};

const ids = (f: Flow) => flatIds(f).join(',');

describe('flowOps', () => {
  it('locates nested steps', () => {
    expect(locate(flow, 'c')).toEqual({ ref: { parentId: 'if', block: 'else' }, index: 0 });
    expect(locate(flow, 'nope')).toBeNull();
  });

  it('inserts into a block', () => {
    const next = insertStep(flow, { parentId: 'if', block: 'then' }, 1, { id: 'x', activity: 'control.log' });
    expect(ids(next)).toBe('a,if,b,x,c,d');
    expect(ids(flow)).toBe('a,if,b,c,d'); // original untouched
  });

  it('keeps identity of untouched steps', () => {
    const next = setParam(flow, 'b', 'message', 'hi');
    expect(next.steps![0]).toBe(flow.steps![0]);
    expect(next.steps![2]).toBe(flow.steps![2]);
    expect(findStep(next, 'b')!.params).toEqual({ message: 'hi' });
  });

  it('removes and moves steps', () => {
    expect(ids(removeStep(flow, 'if'))).toBe('a,d');
    expect(ids(moveStep(flow, 'd', { parentId: 'if', block: 'then' }, 0))).toBe('a,if,d,b,c');
    expect(ids(moveStep(flow, 'a', ROOT, 3))).toBe('if,b,c,d,a'); // move down within the same list
    expect(ids(moveStep(flow, 'd', ROOT, 0))).toBe('d,a,if,b,c');
  });

  it('refuses to move a step into itself', () => {
    expect(moveStep(flow, 'if', { parentId: 'if', block: 'then' }, 0)).toBe(flow);
  });

  it('duplicates with fresh ids', () => {
    const { flow: next, newId } = duplicateStep(flow, 'if');
    expect(flatIds(next)).toHaveLength(8);
    expect(newId).not.toBe('if');
    expect(locate(next, newId!)!.index).toBe(2);
    expect(new Set(flatIds(next)).size).toBe(8);
  });

  it('round-trips list keys', () => {
    expect(parseListKey(listKey(ROOT))).toEqual(ROOT);
    expect(parseListKey(listKey({ parentId: 's1', block: 'then' }))).toEqual({ parentId: 's1', block: 'then' });
  });

  it('keeps an AI fix: changed settings and new ways to find the element', () => {
    const base: Flow = {
      id: 'f',
      name: 'f',
      elements: [{ id: 'btn', name: 'Log on', kind: 'web', screenshot: 'data:x', selectors: [{ strategy: 'text', value: 'Log on' }] }],
      steps: [{ id: 'a', activity: 'browser.click', params: { element: 'btn' } }],
    };
    const fixed = applyRepairPatch(base, {
      step_id: 'a',
      params: { timeout: 5 },
      element: { id: 'btn', name: 'Log on', kind: 'web', context: {}, selectors: [{ strategy: 'text', value: 'Sign in' }, { strategy: 'text', value: 'Log on' }] },
      new_element: false,
    });
    expect(findStep(fixed, 'a')!.params).toEqual({ element: 'btn', timeout: 5 });
    expect(fixed.elements![0]!.selectors.map((s) => s.value)).toEqual(['Sign in', 'Log on']);
    expect(fixed.elements![0]!.screenshot).toBe('data:x');
    expect(base.elements![0]!.selectors).toHaveLength(1);

    const added = applyRepairPatch(base, {
      step_id: 'a',
      params: { element: 'el_ai_a' },
      element: { id: 'el_ai_a', name: 'Save', kind: 'web', selectors: [{ strategy: 'text', value: 'Save' }] },
      new_element: true,
    });
    expect(added.elements!.map((e) => e.id)).toEqual(['btn', 'el_ai_a']);
  });
});
