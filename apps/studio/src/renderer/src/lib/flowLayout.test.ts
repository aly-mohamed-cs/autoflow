import type { ActivityDef, Step } from '@autoflow/flow-types';
import { describe, expect, it } from 'vitest';
import { layoutFlow, type LayoutNode } from './flowLayout';

const BLOCKS: Record<string, { name: string; title: string }[]> = {
  'control.if': [
    { name: 'then', title: 'Then' },
    { name: 'else', title: 'Otherwise' },
  ],
  'control.for_each': [{ name: 'body', title: 'Do' }],
  'control.try': [
    { name: 'body', title: 'Try' },
    { name: 'catch', title: 'If it fails' },
  ],
};
const defOf = (activity: string) =>
  ({ id: activity, blocks: BLOCKS[activity] ?? [] }) as unknown as ActivityDef;
const s = (id: string, activity = 'control.log', blocks?: Record<string, Step[]>): Step => ({
  id,
  activity,
  params: {},
  ...(blocks ? { blocks } : {}),
});

const byId = (nodes: LayoutNode[], id: string) => nodes.find((n) => n.id === id)!;
const centreY = (n: LayoutNode) => n.y + n.h / 2;
const overlap = (a: LayoutNode, b: LayoutNode) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('layoutFlow', () => {
  it('shows an empty flow as Start, a place to add the first step, End', () => {
    const { nodes, edges } = layoutFlow([], defOf);
    expect(nodes.map((n) => n.type)).toEqual(['start', 'placeholder', 'end']);
    expect(byId(nodes, 'p:root:steps').slot).toEqual({ listKey: 'root:steps', index: 0 });
    expect(edges.every((e) => !e.slot)).toBe(true); // the placeholder itself is the place to add
  });

  it('lays a sequence out left to right on one line, with an insert slot on every connector', () => {
    const { nodes, edges } = layoutFlow([s('a'), s('b')], defOf);
    const [start, a, b, end] = ['start', 's:a', 's:b', 'end'].map((id) => byId(nodes, id));
    expect(start!.x < a!.x && a!.x < b!.x && b!.x < end!.x).toBe(true);
    expect(new Set([start, a, b, end].map((n) => centreY(n!))).size).toBe(1);
    expect(edges.map((e) => [e.source, e.target, e.slot?.index])).toEqual(
      expect.arrayContaining([
        ['start', 's:a', 0],
        ['s:a', 's:b', 1],
        ['s:b', 'end', 2],
      ]),
    );
  });

  it('splits If into Yes / No lanes that join again', () => {
    const flow = [s('if', 'control.if', { then: [s('t1'), s('t2')], else: [] }), s('after')];
    const { nodes, edges } = layoutFlow(flow, defOf);
    const decision = byId(nodes, 's:if');
    expect(decision.type).toBe('branch');
    const yes = edges.find((e) => e.label === 'Yes')!;
    const no = edges.find((e) => e.label === 'No')!;
    expect([yes.target, yes.slot]).toEqual(['s:t1', { listKey: 'if:then', index: 0 }]);
    expect(no.target).toBe('p:if:else'); // an empty lane offers a place to add
    expect(byId(nodes, 's:t1').y).toBeLessThan(byId(nodes, 'p:if:else').y); // Yes above No
    expect(edges.find((e) => e.source === 's:t2')).toMatchObject({
      target: 'm:if',
      slot: { listKey: 'if:then', index: 2 },
    });
    expect(edges.find((e) => e.source === 'm:if')).toMatchObject({
      target: 's:after',
      slot: { listKey: 'root:steps', index: 1 },
    });
    expect(centreY(decision)).toBeCloseTo(centreY(byId(nodes, 'm:if')));
    // The shorter No lane runs straight past the Yes lane's steps before joining (no line across them).
    const runOn = byId(nodes, 'j:if:else');
    expect(runOn.x).toBeGreaterThanOrEqual(byId(nodes, 's:t2').x + byId(nodes, 's:t2').w);
    expect(runOn.y).toBeCloseTo(centreY(byId(nodes, 'p:if:else')));
    expect(edges.find((e) => e.source === 'p:if:else')!.target).toBe('j:if:else');
  });

  it('draws loops as a box around their steps, with an arrow back to the start', () => {
    const { nodes, edges } = layoutFlow([s('loop', 'control.for_each', { body: [s('x')] })], defOf);
    const box = byId(nodes, 'c:loop');
    const inside = byId(nodes, 's:x');
    expect(box.type).toBe('container');
    expect(
      inside.x > box.x &&
        inside.x + inside.w < box.x + box.w &&
        inside.y > box.y &&
        inside.y + inside.h < box.y + box.h,
    ).toBe(true);
    expect(inside.depth).toBe(box.depth + 1);
    expect(edges.find((e) => e.kind === 'loop')).toMatchObject({
      source: 'a:loop:body:r',
      target: 'a:loop:body:l',
    });
    expect(edges.find((e) => e.target === 's:x')!.slot).toEqual({ listKey: 'loop:body', index: 0 });
  });

  it('never overlaps steps, even when nested', () => {
    const flow = [
      s('open'),
      s('try', 'control.try', {
        body: [
          s('loop', 'control.for_each', {
            body: [s('if', 'control.if', { then: [s('a'), s('b')], else: [s('c')] }), s('d')],
          }),
        ],
        catch: [s('log')],
      }),
      s('close'),
    ];
    const { nodes, width, height } = layoutFlow(flow, defOf);
    const boxes = nodes.filter((n) =>
      ['step', 'branch', 'placeholder', 'start', 'end'].includes(n.type),
    );
    for (const a of boxes)
      for (const b of boxes) if (a !== b) expect(overlap(a, b), `${a.id} / ${b.id}`).toBe(false);
    expect(byId(nodes, 'c:try').lanes!.map((l) => l.title)).toEqual(['Try', 'If it fails']);
    for (const n of nodes)
      expect(n.x >= 0 && n.y >= 0 && n.x + n.w <= width + 1 && n.y + n.h <= height + 1, n.id).toBe(
        true,
      );
  });
});
