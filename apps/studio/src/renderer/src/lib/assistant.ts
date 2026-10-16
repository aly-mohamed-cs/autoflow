// The AI assistant's changes, applied to the open automation as one edit (one Undo). The
// Orchestrator already checked the step types and settings; here the steps are put in place: in
// order, inside a loop / If / Try section, or on the free connections - each new step connected
// after the one before it, so what the assistant adds also runs.
import { blocksOf, type Flow, type Point, type Step, type Variable, type VariableType } from '@autoflow/flow-types';
import type { AssistantAction } from '../../../shared/api';
import { createStep, type CatalogIndex } from './catalog';
import {
  findStep,
  getList,
  insertStep,
  listKey,
  locate,
  newStepId,
  processOfStep,
  processSteps,
  removeSteps,
  rootRef,
  setBlockList,
  setParam,
  updateStep,
  type ListRef,
} from './flowOps';
import { besides, CHART_GAP, chartOf, connect, nextOf, normalizeCharts, portsOf, setChart, setPosition, START, tidyPositions, type Port } from './flowchart';

export interface Applied {
  flow: Flow;
  /** One plain line per change, shown under the assistant's answer. */
  changes: string[];
  /** Steps added or changed (the first one is selected afterwards). */
  touched: string[];
  /** Changes that no longer fit the automation (e.g. the step was deleted meanwhile). */
  skipped: string[];
}

const VARIABLE_TYPES = new Set<string>(['any', 'text', 'number', 'boolean', 'date', 'list', 'table', 'file']);

/** A step from the assistant with everything a new step from the library has (defaults, empty sections). */
function complete(step: Step, index: CatalogIndex, flow: Flow, ids: Set<string>): Step | null {
  const def = index.get(step.activity);
  if (!def) return null;
  const base = createStep(def, index);
  const params = { ...base.params, ...(step.params ?? {}) };
  const id = step.id && !ids.has(step.id) && !findStep(flow, step.id) ? step.id : newStepId();
  ids.add(id);
  const out: Step = { id, activity: def.id, params };
  if (step.label) out.label = step.label;
  if (def.outputs.length) out.outputs = { ...base.outputs, ...(step.outputs ?? {}) };
  const shape = blocksOf(def, params);
  if (shape.length) {
    out.blocks = Object.fromEntries(
      shape.map((b) => [b.name, (step.blocks?.[b.name] ?? []).map((c) => complete(c, index, flow, ids)).filter((c): c is Step => !!c)]),
    );
  }
  return out;
}

/** The last step of the connected path from Start (Start itself if nothing is connected). */
function chainEnd(flow: Flow, processId: string | null): string {
  const chart = chartOf(flow, processId)!;
  const seen = new Set<string>();
  let at = START;
  for (;;) {
    const step = at === START ? undefined : findStep(flow, at);
    const next = nextOf(chart, at, at === START ? 'next' : portsOf(step)[0]);
    if (!next || seen.has(next)) return at;
    seen.add(next);
    at = next;
  }
}

/**
 * Connect a new top-level step after `source` (what came next now follows it) and draw it beside.
 * After a step that was there, the first free way out is used (a Decision: Yes, then No); steps
 * added together continue on the first one, so they run in the order given.
 */
function linkAfter(flow: Flow, processId: string | null, source: string, step: Step, chained: boolean): Flow {
  const chart = chartOf(flow, processId)!;
  const from = source === START ? undefined : findStep(flow, source);
  const ports: Port[] = source === START ? ['next'] : portsOf(from);
  const port = (chained ? undefined : ports.find((p) => !nextOf(chart, source, p))) ?? ports[0]!;
  const after = nextOf(chart, source, port);
  let next = connect(flow, processId, source, step.id, port);
  if (after && after !== step.id) next = connect(next, processId, step.id, after, portsOf(step)[0]);
  const vertical = flow.layout?.direction === 'vertical';
  const point = besides(chartOf(next, processId)!, source, processSteps(next, processId), vertical);
  return setPosition(next, processId, step.id, freeSpot(next, processId, point, vertical));
}

/** The point, or the nearest one across the flow where no step is drawn yet (a Decision's Yes and No side). */
function freeSpot(flow: Flow, processId: string | null, point: Point, vertical: boolean): Point {
  const taken = Object.values(chartOf(flow, processId)?.positions ?? {});
  const busy = (p: Point) => taken.some((t) => Math.abs((t.x ?? 0) - (p.x ?? 0)) < 160 && Math.abs((t.y ?? 0) - (p.y ?? 0)) < 60);
  let at = point;
  for (let i = 0; i < 30 && busy(at); i++) at = vertical ? { x: (at.x ?? 0) + 236 + CHART_GAP, y: at.y } : { x: at.x, y: (at.y ?? 0) + 72 + CHART_GAP };
  return at;
}

export function applyActions(flow: Flow, processId: string | null, actions: AssistantAction[], index: CatalogIndex): Applied {
  let next = flow;
  const changes: string[] = [];
  const touched: string[] = [];
  const skipped: string[] = [];
  const ids = new Set<string>();
  const title = (id: string) => {
    if (id === START) return 'Start';
    const step = findStep(next, id);
    return step ? step.label || index.get(step.activity)?.title || step.activity : id;
  };
  const count = (steps: Step[]) => (steps.length === 1 ? `“${title(steps[0]!.id)}”` : `${steps.length} steps`);
  // Processes the assistant filled from empty: laid out tidily at the end.
  const filled = new Set<string | null>();

  for (const action of actions) {
    switch (action.type) {
      case 'add_steps': {
        const steps = action.steps.map((s) => complete(s, index, next, ids)).filter((s): s is Step => !!s);
        if (!steps.length) break;
        const parent = action.inside ? findStep(next, action.inside.step) : undefined;
        const parentDef = parent && index.get(parent.activity);
        const sections = parentDef ? blocksOf(parentDef, parent!.params) : [];
        if (parent && sections.length) {
          const block = sections.find((b) => b.name === action.inside!.block) ?? sections[0]!;
          const ref: ListRef = { parentId: parent.id, block: block.name };
          const at = getList(next, ref)?.length ?? 0;
          steps.forEach((s, i) => (next = insertStep(next, ref, at + i, s)));
          changes.push(`Added ${count(steps)} to “${title(parent.id)}” (${block.title})`);
        } else {
          let anchor = parent?.id ?? action.after ?? 'end';
          let home = anchor === 'start' || anchor === 'end' ? processId : processOfStep(next, anchor);
          if (home === undefined) {
            anchor = 'end';
            home = processId;
          }
          const root = rootRef(home);
          const where = anchor === 'start' || anchor === 'end' ? null : locate(next, anchor);
          const ref = where?.ref ?? root;
          const topLevel = listKey(ref) === listKey(root);
          if (topLevel && !processSteps(next, home).length) filled.add(home);
          let at = where ? where.index + 1 : anchor === 'start' ? 0 : processSteps(next, home).length;
          const chart = topLevel ? chartOf(next, home) : null;
          let source: string | null = chart ? (anchor === 'start' ? START : anchor === 'end' ? chainEnd(next, home) : anchor) : null;
          steps.forEach((step, i) => {
            next = insertStep(next, ref, at++, step);
            if (source) next = linkAfter(next, home, source, step, i > 0);
            source = chart ? step.id : null;
          });
          const place = anchor === 'start' ? ' at the start' : anchor === 'end' ? '' : ` after “${title(anchor)}”`;
          changes.push(`Added ${count(steps)}${place}`);
        }
        touched.push(...steps.map((s) => s.id));
        break;
      }
      case 'update_step': {
        const step = findStep(next, action.step);
        const def = step && index.get(step.activity);
        if (!step || !def) {
          skipped.push(`Change a step that is no longer there (${action.step})`);
          break;
        }
        const names: string[] = [];
        for (const [name, value] of Object.entries(action.params ?? {})) {
          next =
            def.block_list?.param === name && Array.isArray(value)
              ? setBlockList(next, step.id, def, value.map(String))
              : setParam(next, step.id, name, value);
          names.push(index.fields(def).find((f) => f.name === name)?.title ?? name);
        }
        const before = title(step.id);
        if (action.label) {
          next = updateStep(next, step.id, (s) => ({ ...s, label: action.label }));
          names.push('name');
        }
        if (names.length) changes.push(`Changed “${before}”: ${names.join(', ')}`);
        touched.push(step.id);
        break;
      }
      case 'remove_steps': {
        const gone: string[] = [];
        for (const id of action.steps) {
          const home = processOfStep(next, id);
          if (home === undefined) continue;
          const chart = chartOf(next, home);
          // On free connections, what led to the step now leads to what came after it.
          if (chart && processSteps(next, home).some((s) => s.id === id)) {
            const outs = (chart.links ?? []).filter((l) => l.source === id);
            if (outs.length === 1) {
              for (const l of (chart.links ?? []).filter((x) => x.target === id)) next = connect(next, home, l.source, outs[0]!.target, l.port ?? 'next');
            }
          }
          gone.push(title(id));
          next = normalizeCharts(removeSteps(next, [id]));
        }
        if (gone.length) changes.push(`Removed ${gone.length === 1 ? `“${gone[0]}”` : `${gone.length} steps`}`);
        break;
      }
      case 'connect': {
        const home = action.from === START ? processId : processOfStep(next, action.from);
        const chart = home === undefined ? null : chartOf(next, home);
        const tops = new Set(processSteps(next, home ?? null).map((s) => s.id));
        if (!chart) {
          skipped.push(`Connect “${title(action.from)}” to “${title(action.to)}” (this process runs its steps in order; turn on free connections first)`);
          break;
        }
        if (!tops.has(action.to) || (action.from !== START && !tops.has(action.from))) {
          skipped.push(`Connect “${title(action.from)}” to “${title(action.to)}” (only steps at the top level of the same process can be connected)`);
          break;
        }
        const ports: Port[] = action.from === START ? ['next'] : portsOf(findStep(next, action.from));
        const port = ports.includes(action.port) ? action.port : ports[0]!;
        next = connect(next, home!, action.from, action.to, port);
        changes.push(`Connected “${title(action.from)}” → “${title(action.to)}”${port === 'next' ? '' : ` (${port === 'yes' ? 'Yes' : 'No'})`}`);
        break;
      }
      case 'add_variable': {
        const vars = next.variables ?? [];
        if (vars.some((v) => v.name === action.name)) {
          skipped.push(`Add variable ${action.name} (it already exists)`);
          break;
        }
        const variable: Variable = { name: action.name, type: (VARIABLE_TYPES.has(action.variableType) ? action.variableType : 'any') as VariableType };
        if (action.is_input) variable.is_input = true;
        if (action.default !== undefined && action.default !== null && action.default !== '') variable.default = action.default;
        if (action.description) variable.description = action.description;
        next = { ...next, variables: [...vars, variable] };
        changes.push(`Added variable ${action.name}${action.is_input ? ' (start value)' : ''}`);
        break;
      }
      case 'rename':
      case 'new_automation': {
        // In the editor a "new automation" names the open one (a new one starts from Home).
        if (action.type === 'new_automation' && (next.steps ?? []).length) {
          skipped.push(`Start a new automation “${action.name}” (go to Home → Build with AI)`);
          break;
        }
        if (action.name && action.name !== next.name) {
          next = { ...next, name: action.name };
          changes.push(`Named the automation “${action.name}”`);
        }
        if (action.description && action.description !== next.description) next = { ...next, description: action.description };
        break;
      }
    }
  }

  // An automation the assistant built from nothing: steps in a tidy line rather than beside each other.
  for (const home of filled) {
    const chart = chartOf(next, home);
    if (chart) next = setChart(next, home, { ...chart, positions: tidyPositions(processSteps(next, home), chart, next.layout?.direction === 'vertical') });
  }
  return { flow: normalizeCharts(next), changes, touched: [...new Set(touched)].filter((id) => findStep(next, id)), skipped };
}
