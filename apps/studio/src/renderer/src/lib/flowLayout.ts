// Lays a flow out as a flowchart (the Flow view of the editor), left to right or top to bottom.
//
// Flows are structured - a sequence of steps where If, loops and Try hold their own step
// lists - so the tidy chart is computed, never drawn by hand, and can't become invalid:
//   Start ─ step ─ step ─ End          a sequence: one line along the main axis
//   If ─┬─ Yes lane ─┐                 If: its lanes side by side, joining again at a dot
//       └─ No lane ──┘
//   ┌ For each ──────────┐             loops / Try: a box (title on top) holding their lanes
//   │ ─ step ─ step ─    │
//   └────────────────────┘
// People may then move steps around: each move is kept as an offset from the tidy place
// (layout.offsets), so steps added later still slot in, moving a box or an If moves what
// belongs to it, and "Tidy up" simply forgets the offsets.
//
// The layout is computed along a main axis (m: the direction of the flow) and a cross
// axis (c), then turned into x / y for the chosen direction.
// Every connector knows where a step dropped on it would go ("slot": list + position).
import type { ActivityDef, Offset, Step } from '@autoflow/flow-types';
import { listKey, parseListKey, ROOT, type ListRef } from './flowOps';

export const SIZES = {
  node: { w: 236, h: 72 },
  gap: 76, // connector length between two items (room for the + button)
  innerGap: 52, // connector from a box's wall to its first / last step
  laneGap: 36,
  pad: 20,
  header: 60,
  laneLabel: 24,
  loopRoom: 30, // beside a loop's lane, for the arrow going back to the start
  terminal: 52,
  merge: 14,
  placeholder: { w: 132, h: 44 },
} as const;

export type Direction = 'horizontal' | 'vertical';

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
  lanes?: { title: string; x: number; y: number; w: number }[];
  loop?: boolean;
  /** Helper nodes (joining dots, anchors): the step they belong to. */
  owner?: string;
  /** Offsets key moving this node (steps, start and end); absent for helper nodes. */
  moveKey?: string;
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
  /** Loop arrows: how far beside the lane's line they run back to its start. */
  drop?: number;
}

export interface FlowLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  direction: Direction;
  /** Bounding box of everything (moved steps can go left of / above Start). */
  bounds: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
}

export interface LayoutOptions {
  direction?: Direction;
  /** The list the chart shows: the main process (default) or a sub-process. */
  root?: ListRef;
  /** Moves people made, by step id (and `${terminalPrefix}start` / `...end`). */
  offsets?: Record<string, Offset>;
  /** Prefix of the start / end keys in offsets (each sub-process has its own). */
  terminalPrefix?: string;
}

interface End {
  node: string;
  handle: string;
}

/** A node while laying out: m / c position and its size along each axis. */
interface Item {
  id: string;
  type: LayoutNodeType;
  m: number;
  c: number;
  sm: number;
  sc: number;
  depth: number;
  stepId?: string;
  /** Helper nodes: the step they belong to. */
  owner?: string;
  slot?: Slot;
  loop?: boolean;
  /** Containers: cross-axis position of their line (connectors in and out). */
  line?: number;
  /** Container lane titles: start along both axes and size across. */
  lanes?: { title: string; m: number; c: number; size: number }[];
  /** Wall anchors of a container: the wall they sit on and the box they belong to. */
  wall?: { side: 'start' | 'end'; box: string; inset: number };
}

interface Box {
  m: number;
  c: number;
  /** Cross-axis position (from the box's start) of the line connectors come in and go out on. */
  spine: number;
  items: Item[];
  edges: LayoutEdge[];
  entry: End;
  exit: End;
}

type DefOf = (activity: string) => ActivityDef | undefined;

export function layoutFlow(steps: Step[], defOf: DefOf, options: LayoutOptions = {}): FlowLayout {
  const direction = options.direction ?? 'horizontal';
  const root = options.root ?? ROOT;
  const builder = new Builder(direction, defOf);
  const t = SIZES.terminal;
  const body = builder.sequence(steps, root, 0);
  const spine = Math.max(body.spine, t / 2);
  const bodyTop = spine - body.spine;
  shift(body, t + SIZES.gap, bodyTop);
  const prefix = options.terminalPrefix ?? '';
  const start: Item = {
    id: 'start',
    type: 'start',
    m: 0,
    c: spine - t / 2,
    sm: t,
    sc: t,
    depth: 0,
  };
  const endM = t + SIZES.gap + body.m + SIZES.gap;
  const end: Item = { id: 'end', type: 'end', m: endM, c: spine - t / 2, sm: t, sc: t, depth: 0 };
  const items = [start, ...body.items, end];
  const edges = [
    ...body.edges,
    connect(
      { node: 'start', handle: 'out' },
      body.entry,
      0,
      steps.length ? { listKey: listKey(root), index: 0 } : undefined,
    ),
    connect(
      body.exit,
      { node: 'end', handle: 'in' },
      0,
      steps.length ? { listKey: listKey(root), index: steps.length } : undefined,
    ),
  ];
  const nodes = items.map((item) => toNode(item, direction));
  const moveKeys: Record<string, string> = { start: `${prefix}start`, end: `${prefix}end` };
  for (const node of nodes) {
    const key = node.stepId ?? moveKeys[node.id];
    if (key) node.moveKey = key;
  }
  const layout: FlowLayout = {
    nodes,
    edges,
    direction,
    bounds: { x: 0, y: 0, w: 0, h: 0 },
    width: 0,
    height: 0,
  };
  if (options.offsets && Object.keys(options.offsets).length) {
    applyOffsets(layout, steps, items, options.offsets, moveKeys);
  }
  measure(layout);
  return layout;
}

class Builder {
  constructor(
    private readonly direction: Direction,
    private readonly defOf: DefOf,
  ) {}

  private get vertical() {
    return this.direction === 'vertical';
  }

  /** Size of a w × h node along the main and cross axes. */
  private size(w: number, h: number): { sm: number; sc: number } {
    return this.vertical ? { sm: h, sc: w } : { sm: w, sc: h };
  }

  /** Steps of one list, one after the other on a shared spine. */
  sequence(steps: Step[], ref: ListRef, depth: number): Box {
    if (steps.length === 0) return this.placeholder(ref, depth);
    const parts = steps.map((step) => this.item(step, depth));
    const spine = Math.max(...parts.map((b) => b.spine));
    const box: Box = {
      m: 0,
      c: 0,
      spine,
      items: [],
      edges: [],
      entry: parts[0]!.entry,
      exit: parts.at(-1)!.exit,
    };
    let m = 0;
    parts.forEach((b, i) => {
      shift(b, m, spine - b.spine);
      box.items.push(...b.items);
      box.edges.push(...b.edges);
      box.c = Math.max(box.c, spine - b.spine + b.c);
      if (i > 0)
        box.edges.push(
          connect(parts[i - 1]!.exit, b.entry, depth, { listKey: listKey(ref), index: i }),
        );
      m += b.m + SIZES.gap;
    });
    box.m = m - SIZES.gap;
    return box;
  }

  private item(step: Step, depth: number): Box {
    const def = this.defOf(step.activity);
    if (def && def.blocks.length > 0) {
      return step.activity === 'control.if'
        ? this.branch(step, def, depth)
        : this.container(step, def, depth);
    }
    const { sm, sc } = this.size(SIZES.node.w, SIZES.node.h);
    const id = `s:${step.id}`;
    return {
      m: sm,
      c: sc,
      spine: sc / 2,
      items: [{ id, type: 'step', m: 0, c: 0, sm, sc, depth, stepId: step.id }],
      edges: [],
      entry: { node: id, handle: 'in' },
      exit: { node: id, handle: 'out' },
    };
  }

  /** If: the decision, then its lanes side by side, joining again at a dot. */
  private branch(step: Step, def: ActivityDef, depth: number): Box {
    const { sm: nm, sc: nc } = this.size(SIZES.node.w, SIZES.node.h);
    const id = `s:${step.id}`;
    const merge = `m:${step.id}`;
    const lanes = def.blocks.map((block) => {
      const ref = { parentId: step.id, block: block.name };
      return { ref, block, box: this.sequence(step.blocks?.[block.name] ?? [], ref, depth) };
    });
    // Stack the lanes, then centre the decision between the first and the last lane's line.
    let c = 0;
    const laneM = nm + SIZES.gap;
    for (const lane of lanes) {
      shift(lane.box, laneM, c);
      c += lane.box.c + SIZES.laneGap;
    }
    const lanesC = c - SIZES.laneGap;
    const firstSpine = lanes[0]!.box.items.length ? spineOf(lanes[0]!.box) : 0;
    const lastSpine = spineOf(lanes.at(-1)!.box);
    let spine = (firstSpine + lastSpine) / 2;
    let lift = 0;
    if (spine - nc / 2 < 0) {
      lift = nc / 2 - spine;
      spine += lift;
      for (const lane of lanes) shift(lane.box, 0, lift);
    }
    const lanesM = Math.max(...lanes.map((l) => l.box.m));
    const mergeM = laneM + lanesM + SIZES.gap;
    const box: Box = {
      m: mergeM + SIZES.merge,
      c: Math.max(lanesC + lift, spine + nc / 2),
      spine,
      items: [
        { id, type: 'branch', m: 0, c: spine - nc / 2, sm: nm, sc: nc, depth, stepId: step.id },
        {
          id: merge,
          type: 'merge',
          m: mergeM,
          c: spine - SIZES.merge / 2,
          sm: SIZES.merge,
          sc: SIZES.merge,
          depth,
          owner: step.id,
        },
      ],
      edges: [],
      entry: { node: id, handle: 'in' },
      exit: { node: merge, handle: 'out' },
    };
    lanes.forEach(({ ref, box: lane }, i) => {
      box.items.push(...lane.items);
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
      if (lane.m < lanesM) {
        // A shorter lane runs straight on to where the longest one ends, then joins: its line
        // never cuts across the steps of the other lanes.
        const end = `j:${step.id}:${ref.block}`;
        box.items.push({
          id: end,
          type: 'anchor',
          m: laneM + lanesM,
          c: spineOf(lane),
          sm: 1,
          sc: 1,
          depth,
          owner: step.id,
        });
        box.edges.push(connect(lane.exit, { node: end, handle: 'in' }, depth, endSlot));
        box.edges.push(connect({ node: end, handle: 'out' }, { node: merge, handle: 'in' }, depth));
      } else {
        box.edges.push(connect(lane.exit, { node: merge, handle: 'in' }, depth, endSlot));
      }
    });
    return box;
  }

  /** Loops, Try and other steps with step lists: a box (title on top) holding one lane per list. */
  private container(step: Step, def: ActivityDef, depth: number): Box {
    const vertical = this.vertical;
    const id = `c:${step.id}`;
    const loop = /for_each|repeat|while/.test(step.activity);
    const showLabels = def.blocks.length > 1;
    const lanes = def.blocks.map((block) => {
      const ref = { parentId: step.id, block: block.name };
      return { ref, block, box: this.sequence(step.blocks?.[block.name] ?? [], ref, depth + 1) };
    });
    // The title sits on top: across the flow when it runs left to right, along it when it
    // runs top to bottom. Lane titles go above each lane.
    const labelM = vertical && showLabels ? SIZES.laneLabel : 0;
    const labelC = !vertical && showLabels ? SIZES.laneLabel : 0;
    const startWall = vertical ? SIZES.header + labelM : SIZES.pad;
    const laneStart = startWall + SIZES.innerGap;
    let c = vertical ? SIZES.pad : SIZES.header;
    const titles: NonNullable<Item['lanes']> = [];
    const inner: { lane: (typeof lanes)[number]; spine: number }[] = [];
    for (const lane of lanes) {
      if (showLabels) {
        titles.push(
          vertical
            ? { title: lane.block.title, m: SIZES.header, c, size: lane.box.c }
            : { title: lane.block.title, m: SIZES.pad, c, size: lane.box.m },
        );
      }
      c += labelC;
      shift(lane.box, laneStart, c);
      inner.push({ lane, spine: c + lane.box.spine });
      c += lane.box.c + (loop ? SIZES.loopRoom : 0) + SIZES.laneGap;
    }
    const lanesM = Math.max(...lanes.map((l) => l.box.m));
    const minAcross = vertical ? SIZES.node.w + 2 * SIZES.pad : SIZES.header;
    const minAlong = vertical ? SIZES.header : SIZES.node.w + 2 * SIZES.pad;
    const m = Math.max(laneStart + lanesM + SIZES.innerGap + SIZES.pad, minAlong);
    const cSize = Math.max(c - SIZES.laneGap + SIZES.pad, minAcross);
    const line = vertical ? cSize / 2 : SIZES.header / 2;
    const box: Box = {
      m,
      c: cSize,
      spine: line,
      items: [
        {
          id,
          type: 'container',
          m: 0,
          c: 0,
          sm: m,
          sc: cSize,
          depth,
          stepId: step.id,
          lanes: titles,
          loop,
          line,
        },
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
      const endWall = m - SIZES.pad;
      box.items.push(
        {
          id: left,
          type: 'anchor',
          m: startWall,
          c: spine,
          sm: 1,
          sc: 1,
          depth: depth + 1,
          owner: step.id,
          wall: { side: 'start', box: id, inset: startWall },
        },
        {
          id: right,
          type: 'anchor',
          m: endWall,
          c: spine,
          sm: 1,
          sc: 1,
          depth: depth + 1,
          owner: step.id,
          wall: { side: 'end', box: id, inset: SIZES.pad },
        },
        ...laneBox.items,
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
          drop: laneBox.c - laneBox.spine + SIZES.loopRoom * 0.6,
        });
      }
    }
    return box;
  }

  private placeholder(ref: ListRef, depth: number): Box {
    const { sm, sc } = this.size(SIZES.placeholder.w, SIZES.placeholder.h);
    const id = `p:${listKey(ref)}`;
    return {
      m: sm,
      c: sc,
      spine: sc / 2,
      items: [
        {
          id,
          type: 'placeholder',
          m: 0,
          c: 0,
          sm,
          sc,
          depth,
          slot: { listKey: listKey(ref), index: 0 },
        },
      ],
      edges: [],
      entry: { node: id, handle: 'in' },
      exit: { node: id, handle: 'out' },
    };
  }
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

/** Move a laid-out box (lane titles stay relative to their container). */
function shift(box: Box, dm: number, dc: number): void {
  for (const n of box.items) {
    n.m += dm;
    n.c += dc;
  }
}

/** Cross-axis position of a laid-out box's line (its entry node's line). */
function spineOf(box: Box): number {
  const entry = box.items.find((n) => n.id === box.entry.node)!;
  return entry.c + (entry.line ?? entry.sc / 2);
}

function toNode(item: Item, direction: Direction): LayoutNode {
  const vertical = direction === 'vertical';
  const node: LayoutNode = {
    id: item.id,
    type: item.type,
    x: vertical ? item.c : item.m,
    y: vertical ? item.m : item.c,
    w: vertical ? item.sc : item.sm,
    h: vertical ? item.sm : item.sc,
    depth: item.depth,
  };
  if (item.stepId) node.stepId = item.stepId;
  if (item.owner) node.owner = item.owner;
  if (item.slot) node.slot = item.slot;
  if (item.loop !== undefined) node.loop = item.loop;
  if (item.lanes) {
    node.lanes = item.lanes.map((lane) =>
      vertical
        ? { title: lane.title, x: lane.c, y: lane.m, w: lane.size }
        : { title: lane.title, x: lane.m, y: lane.c, w: lane.size },
    );
  }
  return node;
}

// -- people's moves --------------------------------------------------------------------------------

/**
 * Move nodes by the offsets people made. A step's offset also moves everything that belongs
 * to it (an If's lanes and joining dot, a box's contents). Boxes then grow to hold their
 * steps, and an If's joining dot stays after its lanes.
 */
function applyOffsets(
  layout: FlowLayout,
  steps: Step[],
  items: Item[],
  offsets: Record<string, Offset>,
  moveKeys: Record<string, string>,
): void {
  const vertical = layout.direction === 'vertical';
  const parent = parentMap(steps);
  const total = new Map<string, { x: number; y: number }>();
  const offsetOf = (stepId: string | null | undefined): { x: number; y: number } => {
    if (!stepId) return { x: 0, y: 0 };
    const known = total.get(stepId);
    if (known) return known;
    const own = offsets[stepId];
    const up = offsetOf(parent.get(stepId));
    const sum = { x: up.x + (own?.x ?? 0), y: up.y + (own?.y ?? 0) };
    total.set(stepId, sum);
    return sum;
  };
  const owner = (node: LayoutNode) => ownerOf(node, parent);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  for (const node of layout.nodes) {
    if (node.type === 'start' || node.type === 'end') {
      const own = offsets[moveKeys[node.id]!];
      node.x += own?.x ?? 0;
      node.y += own?.y ?? 0;
      continue;
    }
    const d = offsetOf(owner(node));
    node.x += d.x;
    node.y += d.y;
  }

  // Deepest steps first, so an inner box has grown before its outer box measures it.
  const depthOf = (id: string): number => {
    let d = 0;
    for (let p = parent.get(id); p; p = parent.get(p)) d++;
    return d;
  };
  const insideOf = (stepId: string): LayoutNode[] =>
    layout.nodes.filter((n) => {
      const o = owner(n);
      if (
        !o ||
        n.type === 'anchor' ||
        n.id === `c:${stepId}` ||
        n.id === `s:${stepId}` ||
        n.id === `m:${stepId}`
      )
        return false;
      for (let p: string | null | undefined = o; p; p = parent.get(p)) {
        if (p === stepId) return o !== stepId || n.type === 'placeholder';
      }
      return false;
    });
  const owners = [...parent.keys()].sort((a, b) => depthOf(b) - depthOf(a));
  for (const stepId of owners) {
    const box = byId.get(`c:${stepId}`);
    const merge = byId.get(`m:${stepId}`);
    const inside = insideOf(stepId);
    if (!inside.length) continue;
    const bb = bbox(inside);
    if (box) {
      const before = { x: box.x, y: box.y, w: box.w, h: box.h };
      const left = Math.min(box.x, bb.x - SIZES.pad);
      const top = Math.min(
        box.y,
        bb.y - SIZES.header - (box.lanes?.length && !vertical ? SIZES.laneLabel : 0),
      );
      const right = Math.max(box.x + box.w, bb.x + bb.w + SIZES.pad);
      const bottom = Math.max(box.y + box.h, bb.y + bb.h + SIZES.pad);
      box.x = left;
      box.y = top;
      box.w = right - left;
      box.h = bottom - top;
      if (box.lanes) {
        const dx = before.x - box.x;
        const dy = before.y - box.y;
        box.lanes = box.lanes.map((lane) => ({ ...lane, x: lane.x + dx, y: lane.y + dy }));
      }
      for (const item of items) {
        if (item.wall?.box !== box.id) continue;
        const anchor = byId.get(item.id)!;
        if (item.wall.side === 'start') {
          if (vertical) anchor.y = box.y + item.wall.inset;
          else anchor.x = box.x + item.wall.inset;
        } else if (vertical) anchor.y = box.y + box.h - item.wall.inset;
        else anchor.x = box.x + box.w - item.wall.inset;
      }
    }
    if (merge) {
      // The joining dot stays after the If's lanes, and shorter lanes run on to just before it.
      const lanesEnd = vertical ? bb.y + bb.h : bb.x + bb.w;
      const along = Math.max(vertical ? merge.y : merge.x, lanesEnd + SIZES.gap / 2);
      if (vertical) merge.y = along;
      else merge.x = along;
      for (const node of layout.nodes) {
        if (!node.id.startsWith(`j:${stepId}:`)) continue;
        if (vertical) node.y = Math.max(node.y, along - SIZES.gap / 2);
        else node.x = Math.max(node.x, along - SIZES.gap / 2);
      }
    }
  }
}

/** Each step's parent step (null at the top of the list shown). */
function parentMap(steps: Step[]): Map<string, string | null> {
  const parent = new Map<string, string | null>();
  const visit = (list: Step[], parentId: string | null) => {
    for (const s of list) {
      parent.set(s.id, parentId);
      for (const children of Object.values(s.blocks ?? {})) visit(children, s.id);
    }
  };
  visit(steps, null);
  return parent;
}

/** The step a node belongs to: its own step, the If / box of a helper, the list of a placeholder. */
function ownerOf(node: LayoutNode, parent: Map<string, string | null>): string | null {
  if (node.stepId) return node.stepId;
  if (node.owner) return node.owner;
  if (node.type === 'placeholder' && node.slot) {
    const parentId = parseListKey(node.slot.listKey).parentId;
    return parentId && parent.has(parentId) ? parentId : null; // not a sub-process's own list
  }
  return null;
}

/** Ids of the nodes that move when the node with this move key is dragged (it and what belongs to it). */
export function nodesMovingWith(layout: FlowLayout, steps: Step[], key: string): Set<string> {
  const parent = parentMap(steps);
  const ids = new Set<string>();
  for (const node of layout.nodes) {
    if (node.moveKey === key) {
      ids.add(node.id);
      continue;
    }
    for (let p = ownerOf(node, parent); p; p = parent.get(p) ?? null) {
      if (p === key) {
        ids.add(node.id);
        break;
      }
    }
  }
  return ids;
}

function bbox(nodes: LayoutNode[]): { x: number; y: number; w: number; h: number } {
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  const right = Math.max(...nodes.map((n) => n.x + n.w));
  const bottom = Math.max(...nodes.map((n) => n.y + n.h));
  return { x, y, w: right - x, h: bottom - y };
}

function measure(layout: FlowLayout): void {
  const b = bbox(layout.nodes);
  layout.bounds = b;
  layout.width = b.x + b.w;
  layout.height = b.y + b.h;
}
