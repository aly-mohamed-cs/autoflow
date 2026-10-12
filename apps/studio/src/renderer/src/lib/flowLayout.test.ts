import type { ActivityDef, Step } from '@autoflow/flow-types';
import { describe, expect, it } from 'vitest';
import { layoutFlow, SIZES, type LayoutNode } from './flowLayout';

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

describe('top to bottom', () => {
  const flow = [
    s('a'),
    s('if', 'control.if', { then: [s('t1'), s('t2')], else: [s('e1')] }),
    s('loop', 'control.for_each', { body: [s('x'), s('y')] }),
    s('z'),
  ];
  const { nodes, edges } = layoutFlow(flow, defOf, { direction: 'vertical' });
  const middleX = (n: LayoutNode) => n.x + n.w / 2;

  it('runs downwards on one centre line, with If lanes side by side', () => {
    const [start, a, decision, box, z, end] = ['start', 's:a', 's:if', 'c:loop', 's:z', 'end'].map(
      (id) => byId(nodes, id),
    );
    for (const [upper, lower] of [
      [start, a],
      [a, decision],
      [decision, box],
      [box, z],
      [z, end],
    ] as const)
      expect(upper!.y + upper!.h).toBeLessThan(lower!.y);
    expect(new Set([start, a, z, end].map((n) => middleX(n!))).size).toBe(1);
    expect(byId(nodes, 's:t1').x).toBeLessThan(byId(nodes, 's:e1').x); // Yes left of No
    expect(byId(nodes, 's:t1').y).toBeLessThan(byId(nodes, 's:t2').y);
    expect(byId(nodes, 'm:if').y).toBeGreaterThan(byId(nodes, 's:t2').y);
  });

  it('keeps a box title on top and its steps inside', () => {
    const box = byId(nodes, 'c:loop');
    for (const id of ['s:x', 's:y']) {
      const n = byId(nodes, id);
      expect(n.y).toBeGreaterThanOrEqual(box.y + SIZES.header);
      expect(n.x > box.x && n.x + n.w < box.x + box.w && n.y + n.h < box.y + box.h).toBe(true);
    }
    expect(byId(nodes, 'a:loop:body:l').y).toBeLessThan(byId(nodes, 's:x').y);
    expect(byId(nodes, 'a:loop:body:r').y).toBeGreaterThan(byId(nodes, 's:y').y);
    expect(edges.find((e) => e.kind === 'loop')!.drop).toBeGreaterThan(0);
  });

  it('never overlaps steps', () => {
    const boxes = nodes.filter((n) =>
      ['step', 'branch', 'placeholder', 'start', 'end'].includes(n.type),
    );
    for (const a of boxes)
      for (const b of boxes) if (a !== b) expect(overlap(a, b), `${a.id} / ${b.id}`).toBe(false);
  });
});

describe('moved steps', () => {
  const flow = [
    s('a'),
    s('if', 'control.if', { then: [s('t1')], else: [] }),
    s('loop', 'control.for_each', { body: [s('x')] }),
  ];
  const tidy = layoutFlow(flow, defOf);
  const at = (layout: ReturnType<typeof layoutFlow>, id: string) => byId(layout.nodes, id);

  it('moves a step by its offset and leaves the others in place', () => {
    const moved = layoutFlow(flow, defOf, { offsets: { a: { x: 10, y: 120 } } });
    expect(at(moved, 's:a').x).toBe(at(tidy, 's:a').x + 10);
    expect(at(moved, 's:a').y).toBe(at(tidy, 's:a').y + 120);
    expect(at(moved, 's:if').x).toBe(at(tidy, 's:if').x);
    expect(at(moved, 's:a').moveKey).toBe('a');
    expect(at(moved, 'm:if').moveKey).toBeUndefined();
  });

  it('moves what belongs to an If or a box along with it', () => {
    const moved = layoutFlow(flow, defOf, {
      offsets: { if: { x: 0, y: 200 }, loop: { x: 40, y: 0 } },
    });
    for (const id of ['s:if', 's:t1', 'm:if', 'p:if:else'])
      expect(at(moved, id).y - at(tidy, id).y, id).toBe(200);
    for (const id of ['c:loop', 's:x', 'a:loop:body:l', 'a:loop:body:r'])
      expect(at(moved, id).x - at(tidy, id).x, id).toBe(40);
  });

  it('grows a box around a step dragged out of it and keeps the joining dot after its lanes', () => {
    const moved = layoutFlow(flow, defOf, {
      offsets: { x: { x: 300, y: 150 }, t1: { x: 500, y: 0 } },
    });
    const box = at(moved, 'c:loop');
    const x = at(moved, 's:x');
    expect(box.x + box.w).toBeGreaterThanOrEqual(x.x + x.w + SIZES.pad);
    expect(box.y + box.h).toBeGreaterThanOrEqual(x.y + x.h + SIZES.pad);
    expect(at(moved, 'a:loop:body:r').x).toBe(box.x + box.w - SIZES.pad); // the exit stays on the wall
    expect(at(moved, 'm:if').x).toBeGreaterThan(at(moved, 's:t1').x + SIZES.node.w);
  });

  it('moves start and end by their own keys', () => {
    const moved = layoutFlow(flow, defOf, {
      offsets: { '@p:start': { x: -30, y: 0 } },
      terminalPrefix: '@p:',
    });
    expect(at(moved, 'start').x).toBe(-30);
    expect(at(moved, 'start').moveKey).toBe('@p:start');
    expect(moved.bounds.x).toBe(-30);
  });
});
