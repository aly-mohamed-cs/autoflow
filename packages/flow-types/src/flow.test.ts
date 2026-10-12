import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODEL_KEYS } from './flow';
import { findStep, processOf, stepPath, walkFlow, walkSteps } from './walk';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../generated/${name}`, import.meta.url), 'utf8'));
const schema = read('flow.schema.json');
const catalog = read('activity-catalog.json');

describe('flow types match the engine schema', () => {
  for (const [model, keys] of Object.entries(MODEL_KEYS)) {
    it(model, () => {
      const def = model === 'Flow' ? schema : schema.$defs[model];
      expect(Object.keys(def.properties).sort()).toEqual([...keys].sort());
    });
  }
});

describe('catalog', () => {
  it('has activities in known categories', () => {
    const categories = new Set(catalog.categories.map((c: { id: string }) => c.id));
    expect(catalog.activities.length).toBeGreaterThan(50);
    for (const a of catalog.activities) expect(categories.has(a.category)).toBe(true);
  });
});

describe('walkSteps / stepPath', () => {
  const flow = {
    id: 'f',
    name: 'f',
    steps: [
      {
        id: 'a',
        activity: 'control.if',
        blocks: { then: [{ id: 'b', activity: 'control.log' }], else: [] },
      },
      { id: 'c', activity: 'control.log' },
    ],
  };

  it('walks depth first', () => {
    expect([...walkSteps(flow.steps)].map((s) => `${s.step.id}:${s.depth}`)).toEqual([
      'a:0',
      'b:1',
      'c:0',
    ]);
  });

  it('finds the path to a nested step', () => {
    expect(stepPath(flow, 'b')).toEqual(['a', 'b']);
    expect(stepPath(flow, 'zzz')).toEqual([]);
  });
});

describe('sub-processes', () => {
  const flow = {
    id: 'f',
    name: 'f',
    steps: [{ id: 'main1', activity: 'control.run_process', params: { process: 'login' } }],
    processes: [
      {
        id: 'login',
        name: 'Log in',
        steps: [
          {
            id: 'p1',
            activity: 'control.if',
            blocks: { then: [{ id: 'p2', activity: 'control.log' }] },
          },
        ],
      },
    ],
  };

  it('walks the main process, then each sub-process', () => {
    expect([...walkFlow(flow)].map((e) => `${e.processId ?? 'main'}:${e.step.id}`)).toEqual([
      'main:main1',
      'login:p1',
      'login:p2',
    ]);
  });

  it('finds steps in sub-processes', () => {
    expect(findStep(flow, 'p2')?.activity).toBe('control.log');
    expect(processOf(flow, 'p2')).toBe('login');
    expect(processOf(flow, 'main1')).toBeNull();
    expect(processOf(flow, 'nope')).toBeUndefined();
    expect(stepPath(flow, 'p2')).toEqual(['p1', 'p2']);
  });
});
