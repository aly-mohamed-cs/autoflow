// Lays a flow out as a left-to-right flowchart (the Flow view of the editor).
//
// Flows are structured - a sequence of steps where If, loops and Try hold their own step
// lists - so the chart is computed, never drawn by hand, and can't become invalid:
//   Start ─ step ─ step ─ End          a sequence: one row
//   If ─┬─ Yes lane ─┐                 If: its lanes stacked, joining again at a dot
//       └─ No lane ──┘
//   ┌ For each ──────────┐             loops / Try: a box holding their lanes
//   │ ─ step ─ step ─    │
//   └────────────────────┘
// Every connector knows where a step dropped on it would go ("slot": list + position).
import type { ActivityDef, Step } from '@autoflow/flow-types';
import { listKey, ROOT, type ListRef } from './flowOps';

export const SIZES = {
  node: { w: 236, h: 72 },
  gap: 76, // connector length between two items (room for the + button)
  innerGap: 52, // connector from a box's wall to its first / last step
  laneGap: 36,
  pad: 20,
  header: 60,
  laneLabel: 24,
  loopRoom: 30, // under a loop's lane, for the arrow going back to the start
  terminal: 52,
  merge: 14,
  placeholder: { w: 132, h: 44 },
} as const;

export type LayoutNodeType =
  'start' | 'end' | 'step' | 'branch' | 'container' | 'merge' | 'anchor' | 'placeholder';

export interface LayoutNode {
  id: string;
  type: LayoutNodeType;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  stepId?: string;
  /** For placeholders: the (empty) list a new step goes into. */
  slot?: Slot;
  /** For containers: lane titles and where they sit (relative to the box). */
  lanes?: { title: string; y: number }[];
  loop?: boolean;
}

export interface Slot {
  listKey: string;
  index: number;
}

export interface LayoutEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  depth: number;
  slot?: Slot;
  label?: 'Yes' | 'No';
  kind: 'flow' | 'loop';
  /** Loop arrows: how far below the lane's line they run back to its start. */
  drop?: number;
}

export interface FlowLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

interface End {
  node: string;
  handle: string;
}

interface Box {
  w: number;
  h: number;
  /** Height (from the top) of the line connectors come in and go out on. */
  spine: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  entry: End;
  exit: End;
}

type DefOf = (activity: string) => ActivityDef | undefined;

export function layoutFlow(steps: Step[], defOf: DefOf): FlowLayout {
  const t = SIZES.terminal;
  const start: LayoutNode = { id: 'start', type: 'start', x: 0, y: 0, w: t, h: t, depth: 0 };
  const end: LayoutNode = { id: 'end', type: 'end', x: 0, y: 0, w: t, h: t, depth: 0 };
  const body = sequence(steps, ROOT, 0, defOf);
  const spine = Math.max(body.spine, t / 2);
  const bodyTop = spine - body.spine;
  shift(body, t + SIZES.gap, bodyTop);
  start.y = spine - t / 2;
  end.x = t + SIZES.gap + body.w + SIZES.gap;
  end.y = spine - t / 2;
  const nodes = [start, ...body.nodes, end];
  const edges = [
    ...body.edges,
    connect(
      { node: 'start', handle: 'out' },
      body.entry,
      0,
      steps.length ? { listKey: listKey(ROOT), index: 0 } : undefined,
    ),
    connect(
      body.exit,
      { node: 'end', handle: 'in' },
      0,
      steps.length ? { listKey: listKey(ROOT), index: steps.length } : undefined,
    ),
  ];
  return { nodes, edges, width: end.x + t, height: Math.max(bodyTop + body.h, spine + t / 2) };
}

/** Steps of one list, left to right on a shared spine. */
function sequence(steps: Step[], ref: ListRef, depth: number, defOf: DefOf): Box {
  if (steps.length === 0) return placeholder(ref, depth);
  const items = steps.map((step) => item(step, depth, defOf));
  const spine = Math.max(...items.map((b) => b.spine));
  const box: Box = {
    w: 0,
    h: 0,
    spine,
    nodes: [],
    edges: [],
    entry: items[0]!.entry,
    exit: items.at(-1)!.exit,
  };
  let x = 0;
  items.forEach((b, i) => {
    shift(b, x, spine - b.spine);
    box.nodes.push(...b.nodes);
    box.edges.push(...b.edges);
    box.h = Math.max(box.h, spine - b.spine + b.h);
    if (i > 0)
      box.edges.push(
        connect(items[i - 1]!.exit, b.entry, depth, { listKey: listKey(ref), index: i }),
      );
    x += b.w + SIZES.gap;
  });
  box.w = x - SIZES.gap;
  return box;
}

function item(step: Step, depth: number, defOf: DefOf): Box {
  const def = defOf(step.activity);
  if (def && def.blocks.length > 0) {
    return step.activity === 'control.if'
      ? branch(step, def, depth, defOf)
      : container(step, def, depth, defOf);
  }
  const { w, h } = SIZES.node;
  const id = `s:${step.id}`;
  return {
    w,
    h,
    spine: h / 2,
    nodes: [{ id, type: 'step', x: 0, y: 0, w, h, depth, stepId: step.id }],
    edges: [],
    entry: { node: id, handle: 'in' },
    exit: { node: id, handle: 'out' },
  };
}

/** If: the decision, then its lanes stacked, joining again at a dot. */
function branch(step: Step, def: ActivityDef, depth: number, defOf: DefOf): Box {
  const { w: nw, h: nh } = SIZES.node;
  const id = `s:${step.id}`;
  const merge = `m:${step.id}`;
  const lanes = def.blocks.map((block) => {
    const ref = { parentId: step.id, block: block.name };
    return { ref, block, box: sequence(step.blocks?.[block.name] ?? [], ref, depth, defOf) };
  });
  // Stack the lanes, then centre the decision between the first and the last lane's line.
  let y = 0;
  const laneX = nw + SIZES.gap;
  for (const lane of lanes) {
    shift(lane.box, laneX, y);
    y += lane.box.h + SIZES.laneGap;
  }
  const lanesH = y - SIZES.laneGap;
  const firstSpine = lanes[0]!.box.nodes.length ? spineOf(lanes[0]!.box) : 0;
  const lastSpine = spineOf(lanes.at(-1)!.box);
  let spine = (firstSpine + lastSpine) / 2;
  let lift = 0;
  if (spine - nh / 2 < 0) {
    lift = nh / 2 - spine;
    spine += lift;
    for (const lane of lanes) shift(lane.box, 0, lift);
  }
  const lanesW = Math.max(...lanes.map((l) => l.box.w));
  const mergeX = laneX + lanesW + SIZES.gap;
  const box: Box = {
    w: mergeX + SIZES.merge,
    h: Math.max(lanesH + lift, spine + nh / 2),
    spine,
    nodes: [
      { id, type: 'branch', x: 0, y: spine - nh / 2, w: nw, h: nh, depth, stepId: step.id },
      {
        id: merge,
        type: 'merge',
        x: mergeX,
        y: spine - SIZES.merge / 2,
        w: SIZES.merge,
        h: SIZES.merge,
        depth,
      },
    ],
    edges: [],
    entry: { node: id, handle: 'in' },
    exit: { node: merge, handle: 'out' },
  };
  lanes.forEach(({ ref, box: lane }, i) => {
    box.nodes.push(...lane.nodes);
    box.edges.push(...lane.edges);
    const count = step.blocks?.[ref.block]?.length ?? 0;
    const label = ref.block === 'then' ? 'Yes' : ref.block === 'else' ? 'No' : undefined;
    const handle = i === 0 ? 'yes' : 'no';
    const endSlot = count ? { listKey: listKey(ref), index: count } : undefined;
    box.edges.push(
      connect(
        { node: id, handle },
        lane.entry,
        depth,
        count ? { listKey: listKey(ref), index: 0 } : undefined,
        label,
      ),
    );
    if (lane.w < lanesW) {
      // A shorter lane runs straight on to where the longest one ends, then joins: its line
      // never cuts across the steps of the other lanes.
      const end = `j:${step.id}:${ref.block}`;
      box.nodes.push({
        id: end,
        type: 'anchor',
        x: laneX + lanesW,
        y: spineOf(lane),
        w: 1,
        h: 1,
        depth,
      });
      box.edges.push(connect(lane.exit, { node: end, handle: 'in' }, depth, endSlot));
      box.edges.push(connect({ node: end, handle: 'out' }, { node: merge, handle: 'in' }, depth));
    } else {
      box.edges.push(connect(lane.exit, { node: merge, handle: 'in' }, depth, endSlot));
    }
  });
  return box;
}

/** Loops, Try and other steps with step lists: a box holding one lane per list. */
function container(step: Step, def: ActivityDef, depth: number, defOf: DefOf): Box {
  const id = `c:${step.id}`;
  const loop = /for_each|repeat|while/.test(step.activity);
  const showLabels = def.blocks.length > 1;
  const lanes = def.blocks.map((block) => {
    const ref = { parentId: step.id, block: block.name };
    return { ref, block, box: sequence(step.blocks?.[block.name] ?? [], ref, depth + 1, defOf) };
  });
  const innerX = SIZES.pad + SIZES.innerGap;
  let y = SIZES.header;
  const laneTitles: { title: string; y: number }[] = [];
  const inner: { lane: (typeof lanes)[number]; spine: number }[] = [];
  for (const lane of lanes) {
    if (showLabels) {
      laneTitles.push({ title: lane.block.title, y });
      y += SIZES.laneLabel;
    }
    shift(lane.box, innerX, y);
    inner.push({ lane, spine: y + lane.box.spine });
    y += lane.box.h + (loop ? SIZES.loopRoom : 0) + SIZES.laneGap;
  }
  const lanesW = Math.max(...lanes.map((l) => l.box.w));
  const w = Math.max(innerX + lanesW + SIZES.innerGap + SIZES.pad, SIZES.node.w + 2 * SIZES.pad);
  const h = y - SIZES.laneGap + SIZES.pad;
  const box: Box = {
    w,
    h,
    spine: SIZES.header / 2,
    nodes: [
      { id, type: 'container', x: 0, y: 0, w, h, depth, stepId: step.id, lanes: laneTitles, loop },
    ],
    edges: [],
    entry: { node: id, handle: 'in' },
    exit: { node: id, handle: 'out' },
  };
  for (const { lane, spine } of inner) {
    const { ref, box: laneBox } = lane;
    const count = step.blocks?.[ref.block]?.length ?? 0;
    const left = `a:${step.id}:${ref.block}:l`;
    const right = `a:${step.id}:${ref.block}:r`;
    box.nodes.push(
      { id: left, type: 'anchor', x: SIZES.pad, y: spine, w: 1, h: 1, depth: depth + 1 },
      { id: right, type: 'anchor', x: w - SIZES.pad, y: spine, w: 1, h: 1, depth: depth + 1 },
      ...laneBox.nodes,
    );
    box.edges.push(
      ...laneBox.edges,
      connect(
        { node: left, handle: 'out' },
        laneBox.entry,
        depth + 1,
        count ? { listKey: listKey(ref), index: 0 } : undefined,
      ),
      connect(
        laneBox.exit,
        { node: right, handle: 'in' },
        depth + 1,
        count ? { listKey: listKey(ref), index: count } : undefined,
      ),
    );
    if (loop) {
      box.edges.push({
        id: `loop:${step.id}:${ref.block}`,
        source: right,
        sourceHandle: 'out',
        target: left,
        targetHandle: 'in',
        depth: depth + 1,
        kind: 'loop',
        drop: laneBox.h - laneBox.spine + SIZES.loopRoom * 0.6,
      });
    }
  }
  return box;
}

function placeholder(ref: ListRef, depth: number): Box {
  const { w, h } = SIZES.placeholder;
  const id = `p:${listKey(ref)}`;
  return {
    w,
    h,
    spine: h / 2,
    nodes: [
      {
        id,
        type: 'placeholder',
        x: 0,
        y: 0,
        w,
        h,
        depth,
        slot: { listKey: listKey(ref), index: 0 },
      },
    ],
    edges: [],
    entry: { node: id, handle: 'in' },
    exit: { node: id, handle: 'out' },
  };
}

function connect(from: End, to: End, depth: number, slot?: Slot, label?: 'Yes' | 'No'): LayoutEdge {
  return {
    id: `e:${from.node}:${from.handle}->${to.node}`,
    source: from.node,
    sourceHandle: from.handle,
    target: to.node,
    targetHandle: to.handle,
    depth,
    kind: 'flow',
    ...(slot ? { slot } : {}),
    ...(label ? { label } : {}),
  };
}

function shift(box: Box, dx: number, dy: number): void {
  for (const n of box.nodes) {
    n.x += dx;
    n.y += dy;
  }
}

/** Absolute height of a laid-out box's line (its entry node's middle). */
function spineOf(box: Box): number {
  const entry = box.nodes.find((n) => n.id === box.entry.node)!;
  return entry.type === 'container' ? entry.y + SIZES.header / 2 : entry.y + entry.h / 2;
}
