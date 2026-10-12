import type { Flow } from '@autoflow/flow-types';
import { describe, expect, it } from 'vitest';
import {
  addProcess,
  applyRepairPatch,
  changeActivity,
  copySteps,
  pasteSteps,
  readClipboard,
  removeSteps,
  wrapSteps,
  duplicateProcess,
  duplicateStep,
  findStep,
  flatIds,
  getList,
  insertStep,
  listKey,
  locate,
  moveStep,
  parseListKey,
  processOfStep,
  processUsers,
  removeProcess,
  removeStep,
  ROOT,
  rootRef,
  setBlockList,
  setParam,
  updateProcess,
} from './flowOps';

const flow: Flow = {
  id: 'f',
  name: 'f',
  steps: [
    { id: 'a', activity: 'control.log' },
    {
      id: 'if',
      activity: 'control.if',
      blocks: {
        then: [{ id: 'b', activity: 'control.log' }],
        else: [{ id: 'c', activity: 'control.log' }],
      },
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
    const next = insertStep(flow, { parentId: 'if', block: 'then' }, 1, {
      id: 'x',
      activity: 'control.log',
    });
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
    expect(parseListKey(listKey({ parentId: 's1', block: 'then' }))).toEqual({
      parentId: 's1',
      block: 'then',
    });
  });

  it('keeps an AI fix: changed settings and new ways to find the element', () => {
    const base: Flow = {
      id: 'f',
      name: 'f',
      elements: [
        {
          id: 'btn',
          name: 'Log on',
          kind: 'web',
          screenshot: 'data:x',
          selectors: [{ strategy: 'text', value: 'Log on' }],
        },
      ],
      steps: [{ id: 'a', activity: 'browser.click', params: { element: 'btn' } }],
    };
    const fixed = applyRepairPatch(base, {
      step_id: 'a',
      params: { timeout: 5 },
      element: {
        id: 'btn',
        name: 'Log on',
        kind: 'web',
        context: {},
        selectors: [
          { strategy: 'text', value: 'Sign in' },
          { strategy: 'text', value: 'Log on' },
        ],
      },
      new_element: false,
    });
    expect(findStep(fixed, 'a')!.params).toEqual({ element: 'btn', timeout: 5 });
    expect(fixed.elements![0]!.selectors.map((s) => s.value)).toEqual(['Sign in', 'Log on']);
    expect(fixed.elements![0]!.screenshot).toBe('data:x');
    expect(base.elements![0]!.selectors).toHaveLength(1);

    const added = applyRepairPatch(base, {
      step_id: 'a',
      params: { element: 'el_ai_a' },
      element: {
        id: 'el_ai_a',
        name: 'Save',
        kind: 'web',
        selectors: [{ strategy: 'text', value: 'Save' }],
      },
      new_element: true,
    });
    expect(added.elements!.map((e) => e.id)).toEqual(['btn', 'el_ai_a']);
  });
});

describe('sub-processes', () => {
  const withProcess: Flow = {
    ...flow,
    processes: [
      {
        id: 'login',
        name: 'Log in',
        steps: [
          { id: 'p1', activity: 'control.log' },
          {
            id: 'ploop',
            activity: 'control.for_each',
            blocks: { body: [{ id: 'p2', activity: 'control.log' }] },
          },
        ],
      },
    ],
  };
  const login = rootRef('login');

  it('edits steps inside a sub-process like any other', () => {
    expect(listKey(login)).toBe('@login:steps');
    expect(parseListKey('@login:steps')).toEqual(login);
    expect(getList(withProcess, login)?.map((s) => s.id)).toEqual(['p1', 'ploop']);
    expect(locate(withProcess, 'p2')).toEqual({
      ref: { parentId: 'ploop', block: 'body' },
      index: 0,
    });
    expect(processOfStep(withProcess, 'p2')).toBe('login');
    expect(processOfStep(withProcess, 'b')).toBeNull();

    let next = insertStep(withProcess, login, 1, { id: 'new', activity: 'control.log' });
    expect(flatIds(next, 'login')).toEqual(['p1', 'new', 'ploop', 'p2']);
    expect(next.steps).toBe(withProcess.steps); // the main process is untouched
    next = setParam(next, 'p2', 'message', 'hi');
    expect(findStep(next, 'p2')?.params).toEqual({ message: 'hi' });
    next = moveStep(next, 'a', login, 0); // between processes
    expect(flatIds(next, 'login')[0]).toBe('a');
    expect(flatIds(next)).not.toContain('a');
    next = removeStep(next, 'p1');
    expect(flatIds(next, 'login')).toEqual(['a', 'new', 'ploop', 'p2']);
  });

  it('adds, copies and removes sub-processes', () => {
    const added = addProcess(withProcess, 'Save report');
    expect(added.id).toBe('process_2');
    const copy = duplicateProcess(added.flow, 'login');
    const copied = copy.flow.processes!.find((p) => p.id === copy.id)!;
    expect(copied.name).toBe('Log in (copy)');
    expect(copied.steps!.map((s) => s.id)).not.toContain('p1'); // fresh step ids
    const renamed = updateProcess(copy.flow, 'login', (p) => ({ ...p, name: 'Sign in' }));
    expect(renamed.processes![0]!.name).toBe('Sign in');
    const user = insertStep(renamed, ROOT, 0, {
      id: 'run',
      activity: 'control.run_process',
      params: { process: 'login' },
    });
    expect(processUsers(user, 'login').map((s) => s.id)).toEqual(['run']);
    expect(removeProcess(user, 'login').processes!.map((p) => p.id)).toEqual([
      'process_2',
      copy.id,
    ]);
  });
});

describe('switch cases', () => {
  const def = { block_list: { param: 'cases', prefix: 'case_' }, blocks: [{ name: 'default' }] };
  const log = (id: string) => ({ id, activity: 'control.log' });
  const flow: Flow = {
    id: 'f',
    name: 'f',
    steps: [
      {
        id: 'sw',
        activity: 'control.switch',
        params: { value: 'x', cases: ['A', 'B', 'C'] },
        blocks: { case_1: [log('a')], case_2: [log('b')], case_3: [log('c')], default: [log('d')] },
      },
    ],
  };
  const lanes = (f: Flow) => {
    const step = findStep(f, 'sw')!;
    return Object.fromEntries(
      Object.entries(step.blocks ?? {}).map(([k, v]) => [k, v.map((s) => s.id)]),
    );
  };

  it('keeps steps with their case when cases are renamed, added or removed', () => {
    expect(lanes(setBlockList(flow, 'sw', def, ['A', 'Bee', 'C']))).toEqual({
      case_1: ['a'],
      case_2: ['b'],
      case_3: ['c'],
      default: ['d'],
    });
    expect(lanes(setBlockList(flow, 'sw', def, ['C', 'A', 'B', 'New']))).toEqual({
      case_1: ['c'],
      case_2: ['a'],
      case_3: ['b'],
      default: ['d'],
    });
    expect(lanes(setBlockList(flow, 'sw', def, ['A', 'C']))).toEqual({
      case_1: ['a'],
      case_2: ['c'],
      default: ['d', 'b'], // nothing is lost
    });
  });
});

describe('several steps at once', () => {
  const flow: Flow = {
    id: 'f',
    name: 'f',
    elements: [
      {
        id: 'el1',
        name: 'Save button',
        kind: 'web',
        selectors: [{ strategy: 'css', value: '#save' }],
      },
      { id: 'el2', name: 'Other', kind: 'web', selectors: [{ strategy: 'css', value: '#x' }] },
    ],
    steps: [
      { id: 'a', activity: 'browser.click', params: { element: 'el1' } },
      { id: 'b', activity: 'control.log' },
      {
        id: 'loop',
        activity: 'control.for_each',
        blocks: { body: [{ id: 'c', activity: 'control.log' }] },
      },
    ],
  };

  it('copies the outermost selected steps with the elements they use, and pastes fresh copies', () => {
    const clip = copySteps(flow, ['loop', 'c', 'a'])!;
    expect(clip.steps.map((s) => s.id)).toEqual(['a', 'loop']); // c is inside loop
    expect(clip.elements.map((e) => e.id)).toEqual(['el1']);
    const text = JSON.stringify(clip);
    expect(readClipboard(text)?.steps).toHaveLength(2);
    expect(readClipboard('hello')).toBeNull();

    const into: Flow = { id: 'g', name: 'g', steps: [{ id: 'z', activity: 'control.log' }] };
    const pasted = pasteSteps(into, ROOT, 1, readClipboard(text)!);
    expect(pasted.ids).toHaveLength(2);
    expect(pasted.flow.steps!.map((s) => s.activity)).toEqual([
      'control.log',
      'browser.click',
      'control.for_each',
    ]);
    expect(pasted.ids).not.toContain('a');
    expect(pasted.flow.elements!.map((e) => e.id)).toEqual(['el1']);
    expect(removeSteps(pasted.flow, pasted.ids).steps!.map((s) => s.id)).toEqual(['z']);
  });

  it('wraps steps of one list into a group, and refuses steps from different lists', () => {
    const box = {
      id: 'g1',
      activity: 'control.group',
      params: { name: 'Start' },
      blocks: { body: [] },
    };
    const wrapped = wrapSteps(flow, ['b', 'a'], box, 'body')!;
    expect(wrapped.steps!.map((s) => s.id)).toEqual(['g1', 'loop']);
    expect(findStep(wrapped, 'g1')!.blocks!.body!.map((s) => s.id)).toEqual(['a', 'b']);
    expect(wrapSteps(flow, ['a', 'c'], box, 'body')).toBeNull();
  });

  it('changes a step into another kind without losing settings or inner steps', () => {
    const typeDef = {
      id: 'browser.type',
      params: { properties: { element: {}, text: {} } },
      outputs: [],
      blocks: [],
    };
    expect(findStep(changeActivity(flow, 'a', typeDef), 'a')).toMatchObject({
      activity: 'browser.type',
      params: { element: 'el1' },
    });
    const logDef = {
      id: 'control.log',
      params: { properties: { message: {} } },
      outputs: [],
      blocks: [],
    };
    const flat = changeActivity(flow, 'loop', logDef);
    expect(flat.steps!.map((s) => s.id)).toEqual(['a', 'b', 'loop', 'c']); // c moved out, after it
    expect(findStep(flat, 'loop')!.blocks).toBeUndefined();
  });
});
