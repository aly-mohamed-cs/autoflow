// Free connections (a process's flowchart): steps run in the order they are connected, starting at
// Start; a step nothing leads to doesn't run. Only the process's top-level steps are connected this
// way - what is inside a loop, If or Try still runs in order. Without a flowchart a process runs
// its steps one after the other (engine: runtime/interpreter.py run_chart).
import type { Flow, Flowchart, Link, Point, Step } from '@autoflow/flow-types';
import { processSteps } from './flowOps';

export const START = 'start';
export type Port = 'next' | 'yes' | 'no';
export const DECISION = 'control.decision';

/** Space between connected steps when Studio places them. */
export const CHART_GAP = 100;
const NODE = { w: 236, h: 72 };

/** Block sizes the canvas measured (by step id), so new steps can be placed beside them. */
export const blockSizes = new Map<string, { w: number; h: number }>();

export function chartOf(flow: Flow, processId: string | null): Flowchart | null {
  if (!processId) return flow.flowchart ?? null;
  return flow.processes?.find((p) => p.id === processId)?.flowchart ?? null;
}

export function setChart(flow: Flow, processId: string | null, chart: Flowchart | null): Flow {
  if (!processId) return { ...flow, flowchart: chart };
  return { ...flow, processes: (flow.processes ?? []).map((p) => (p.id === processId ? { ...p, flowchart: chart } : p)) };
}

function updateChart(flow: Flow, processId: string | null, fn: (chart: Flowchart) => Flowchart): Flow {
  const chart = chartOf(flow, processId);
  return chart ? setChart(flow, processId, fn(chart)) : flow;
}

const portOf = (link: Link): Port => link.port ?? 'next';

export function nextOf(chart: Flowchart, source: string, port: Port = 'next'): string | null {
  return chart.links?.find((l) => l.source === source && portOf(l) === port)?.target ?? null;
}

/** The ways out of a step: Yes / No for a Decision, otherwise one. */
export function portsOf(step: Step | undefined): Port[] {
  return step?.activity === DECISION ? ['yes', 'no'] : ['next'];
}

/** Connect source (a step or Start) to target; a way out leads to one step only, so an earlier connector from it is replaced. */
export function connect(flow: Flow, processId: string | null, source: string, target: string, port: Port = 'next'): Flow {
  if (target === START) return flow;
  return updateChart(flow, processId, (chart) => ({
    ...chart,
    links: [...(chart.links ?? []).filter((l) => !(l.source === source && portOf(l) === port)), { source, target, port }],
  }));
}

export function disconnect(flow: Flow, processId: string | null, source: string, port: Port = 'next'): Flow {
  return updateChart(flow, processId, (chart) => ({
    ...chart,
    links: (chart.links ?? []).filter((l) => !(l.source === source && portOf(l) === port)),
  }));
}

export function setPosition(flow: Flow, processId: string | null, id: string, point: Point): Flow {
  return updateChart(flow, processId, (chart) => ({
    ...chart,
    positions: { ...chart.positions, [id]: { x: Math.round(point.x ?? 0), y: Math.round(point.y ?? 0) } },
  }));
}

/** A way out of `source` that nothing is connected to yet, if any. */
function freePort(chart: Flowchart, source: string, step: Step | undefined): Port | null {
  return portsOf(step).find((p) => !nextOf(chart, source, p)) ?? null;
}

/**
 * A step just added to the process's top level (it is already in the step list): connect it after
 * the selected step (what came next now follows the new step), or to Start if nothing is
 * connected to Start yet; otherwise it stays unconnected. It is placed beside where it connects.
 */
export function placeNewStep(
  flow: Flow,
  processId: string | null,
  step: Step,
  selectedId: string | null,
  vertical = false,
): Flow {
  const chart = chartOf(flow, processId);
  if (!chart) return flow;
  const steps = processSteps(flow, processId);
  const selected = selectedId && selectedId !== step.id ? steps.find((s) => s.id === selectedId) : undefined;
  let source: string | null = null;
  let port: Port = 'next';
  if (selected) {
    source = selected.id;
    // A Decision: the first of Yes / No that is still free, or Yes.
    port = freePort(chart, selected.id, selected) ?? portsOf(selected)[0]!;
  } else if (!nextOf(chart, START)) {
    source = START;
  }
  let next = flow;
  if (source) {
    const after = nextOf(chart, source, port);
    next = connect(next, processId, source, step.id, port);
    if (after && after !== step.id) next = connect(next, processId, step.id, after);
  }
  return setPosition(next, processId, step.id, besides(chart, source, steps, vertical));
}

/** Insert a new step (already in the step list) on the connector source -> target. */
export function insertOnLink(flow: Flow, processId: string | null, link: Link, step: Step, at?: Point): Flow {
  let next = connect(flow, processId, link.source, step.id, portOf(link));
  next = connect(next, processId, step.id, link.target);
  const chart = chartOf(next, processId)!;
  const a = chart.positions?.[link.source];
  const b = chart.positions?.[link.target];
  const middle = at ?? (a && b ? { x: ((a.x ?? 0) + (b.x ?? 0)) / 2, y: ((a.y ?? 0) + (b.y ?? 0)) / 2 + NODE.h } : undefined);
  return middle ? setPosition(next, processId, step.id, middle) : next;
}

/** Where to draw a new step: after `source`, or right of / below everything. */
export function besides(chart: Flowchart, source: string | null, steps: Step[], vertical: boolean): Point {
  const positions = chart.positions ?? {};
  const from = source ? positions[source] : undefined;
  if (from) {
    const size = blockSizes.get(source!) ?? (source === START ? { w: 52, h: 52 } : NODE);
    return vertical
      ? { x: from.x ?? 0, y: (from.y ?? 0) + size.h + CHART_GAP }
      : { x: (from.x ?? 0) + size.w + CHART_GAP, y: from.y ?? 0 };
  }
  let far = 0;
  for (const s of steps) {
    const p = positions[s.id];
    if (!p) continue;
    const size = blockSizes.get(s.id) ?? NODE;
    far = Math.max(far, vertical ? (p.y ?? 0) + size.h : (p.x ?? 0) + size.w);
  }
  const startPos = positions[START] ?? { x: 0, y: 0 };
  return vertical
    ? { x: startPos.x ?? 0, y: far + CHART_GAP }
    : { x: far ? far + CHART_GAP : (startPos.x ?? 0) + 52 + CHART_GAP, y: startPos.y ?? 0 };
}

/**
 * After any edit: connectors and positions only for steps still at the process's top level (a
 * step deleted, or moved into a loop, loses its connectors). Returns the same flow when nothing
 * changed.
 */
export function normalizeCharts(flow: Flow): Flow {
  let next = flow;
  const tidy = (processId: string | null) => {
    const chart = chartOf(next, processId);
    if (!chart) return;
    const ids = new Set(processSteps(next, processId).map((s) => s.id));
    const links = (chart.links ?? []).filter((l) => (l.source === START || ids.has(l.source)) && ids.has(l.target));
    const positions = Object.fromEntries(Object.entries(chart.positions ?? {}).filter(([id]) => id === START || ids.has(id)));
    if (links.length !== (chart.links ?? []).length || Object.keys(positions).length !== Object.keys(chart.positions ?? {}).length) {
      next = setChart(next, processId, { ...chart, links, positions });
    }
  };
  tidy(null);
  for (const p of flow.processes ?? []) tidy(p.id);
  return next;
}

/** Steps reached from Start (the ones that run). */
export function reachable(chart: Flowchart): Set<string> {
  const seen = new Set<string>();
  const todo = [START];
  while (todo.length) {
    const id = todo.pop()!;
    for (const l of chart.links ?? []) {
      if (l.source === id && !seen.has(l.target)) {
        seen.add(l.target);
        todo.push(l.target);
      }
    }
  }
  return seen;
}

/** The steps in the order they run (Yes before No), then the ones that are not connected. */
export function runOrder(steps: Step[], chart: Flowchart): { connected: Step[]; loose: Step[] } {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const order: Step[] = [];
  const seen = new Set<string>();
  const visit = (id: string | null) => {
    while (id && !seen.has(id) && byId.has(id)) {
      seen.add(id);
      const step = byId.get(id)!;
      order.push(step);
      if (step.activity === DECISION) {
        visit(nextOf(chart, id, 'yes'));
        id = nextOf(chart, id, 'no');
      } else id = nextOf(chart, id);
    }
  };
  visit(nextOf(chart, START));
  return { connected: order, loose: steps.filter((s) => !seen.has(s.id)) };
}

/** Switch a process to free connections: Start -> first -> second ..., each drawn at `positions`. */
export function toFlowchart(flow: Flow, processId: string | null, positions: Record<string, Point>): Flow {
  const steps = processSteps(flow, processId);
  const ids = [START, ...steps.map((s) => s.id)];
  const links: Link[] = ids.slice(1).map((target, i) => ({ source: ids[i]!, target, port: 'next' }));
  return setChart(flow, processId, { links, positions });
}

/**
 * Back to one step after the other: only when every step is connected in one line from Start
 * (no Decisions, no loops back, nothing left over).
 */
export function toSequence(flow: Flow, processId: string | null): { flow: Flow } | { error: string } {
  const chart = chartOf(flow, processId);
  if (!chart) return { flow };
  const steps = processSteps(flow, processId);
  if (steps.some((s) => s.activity === DECISION)) {
    return { error: 'Replace the Decisions with "If / Otherwise" first: one after the other has no Yes / No connectors.' };
  }
  const { connected, loose } = runOrder(steps, chart);
  if (loose.length) return { error: `Connect every step in one line from Start first (${loose.length} not connected).` };
  const order = connected.map((s) => s.id);
  const backwards = (chart.links ?? []).some((l) => l.source !== START && order.indexOf(l.target) <= order.indexOf(l.source));
  if (backwards) return { error: 'A connector goes back to an earlier step: one after the other can\'t repeat steps that way.' };
  const sequence = setChart(flow, processId, null);
  if (!processId) return { flow: { ...sequence, steps: connected } };
  return { flow: { ...sequence, processes: (sequence.processes ?? []).map((p) => (p.id === processId ? { ...p, steps: connected } : p)) } };
}

/** "Tidy up": steps in the order they run, in a line (Decisions' No side below / beside), the rest after. */
export function tidyPositions(
  steps: Step[],
  chart: Flowchart,
  vertical: boolean,
  sizeOf: (id: string) => { w: number; h: number } | undefined = (id) => blockSizes.get(id),
): Record<string, Point> {
  const positions: Record<string, Point> = { [START]: { x: 0, y: 0 } };
  const placed = new Set<string>();
  const byId = new Map(steps.map((s) => [s.id, s]));
  const size = (id: string) => sizeOf(id) ?? NODE;
  let lane = 0; // across the flow
  const laneSize = (vertical ? NODE.w : NODE.h) + CHART_GAP;
  const line = (first: string | null, along: number, across: number) => {
    let id = first;
    let at = along;
    while (id && byId.has(id) && !placed.has(id)) {
      placed.add(id);
      positions[id] = vertical ? { x: across, y: at } : { x: at, y: across };
      const s = size(id);
      at += (vertical ? s.h : s.w) + CHART_GAP;
      if (byId.get(id)!.activity === DECISION) {
        const no = nextOf(chart, id, 'no');
        if (no && !placed.has(no)) {
          lane += 1;
          line(no, at, lane * laneSize + (vertical ? 0 : 0));
        }
        id = nextOf(chart, id, 'yes');
      } else id = nextOf(chart, id);
    }
  };
  line(nextOf(chart, START), 52 + CHART_GAP, 0);
  // Steps that are not connected: a row of their own after everything else.
  lane += 1;
  let along = 52 + CHART_GAP;
  for (const s of steps) {
    if (placed.has(s.id)) continue;
    positions[s.id] = vertical ? { x: lane * laneSize, y: along } : { x: along, y: lane * laneSize };
    along += (vertical ? size(s.id).h : size(s.id).w) + CHART_GAP / 2;
  }
  return positions;
}
