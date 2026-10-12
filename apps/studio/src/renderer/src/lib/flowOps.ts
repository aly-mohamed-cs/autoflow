// Immutable edits of the step tree. Only the path to the changed step is copied,
// so unchanged step objects keep their identity and React can skip re-rendering them.
//
// A flow has a main step list plus one per sub-process; step ids are unique across all.
import type { Flow, RepairPatch, Step, SubProcess } from '@autoflow/flow-types';

/**
 * A step list: the main process's top level (parentId null), a sub-process's top level
 * (parentId "@<process id>"), or one block ("then", "body"...) of a step.
 */
export interface ListRef {
  parentId: string | null;
  block: string;
}

export const ROOT: ListRef = { parentId: null, block: 'steps' };

const PROCESS = '@';

/** The top-level list of the main process (null) or of a sub-process. */
export function rootRef(processId: string | null): ListRef {
  return processId ? { parentId: `${PROCESS}${processId}`, block: 'steps' } : ROOT;
}

/** The sub-process a top-level ref belongs to (null: main); undefined for a step's block. */
function processOfRef(ref: ListRef): string | null | undefined {
  if (ref.parentId === null) return null;
  return ref.parentId.startsWith(PROCESS) ? ref.parentId.slice(PROCESS.length) : undefined;
}

/** Shared empty lists: store selectors must not return a new [] on every call. */
export const NO_STEPS: Step[] = [];
export const NO_PROCESSES: SubProcess[] = [];

export function processSteps(flow: Flow, processId: string | null): Step[] {
  if (!processId) return flow.steps ?? NO_STEPS;
  return flow.processes?.find((p) => p.id === processId)?.steps ?? NO_STEPS;
}

function roots(flow: Flow): { ref: ListRef; steps: Step[] }[] {
  return [
    { ref: ROOT, steps: flow.steps ?? [] },
    ...(flow.processes ?? []).map((p) => ({ ref: rootRef(p.id), steps: p.steps ?? [] })),
  ];
}

function withProcessSteps(flow: Flow, processId: string, steps: Step[]): Flow {
  return {
    ...flow,
    processes: (flow.processes ?? []).map((p) => (p.id === processId ? { ...p, steps } : p)),
  };
}

export const listKey = (ref: ListRef) => `${ref.parentId ?? 'root'}:${ref.block}`;

export function parseListKey(key: string): ListRef {
  const i = key.lastIndexOf(':');
  const parent = key.slice(0, i);
  return { parentId: parent === 'root' ? null : parent, block: key.slice(i + 1) };
}

let counter = 0;
export function newStepId(): string {
  counter = (counter + 1) % 1_000_000;
  return `s${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function updateIn(steps: Step[], id: string, fn: (step: Step) => Step): Step[] | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.id === id) {
      const copy = steps.slice();
      copy[i] = fn(step);
      return copy;
    }
    for (const [name, children] of Object.entries(step.blocks ?? {})) {
      const updated = updateIn(children, id, fn);
      if (updated) {
        const copy = steps.slice();
        copy[i] = { ...step, blocks: { ...step.blocks, [name]: updated } };
        return copy;
      }
    }
  }
  return null;
}

export function updateStep(flow: Flow, id: string, fn: (step: Step) => Step): Flow {
  const main = updateIn(flow.steps ?? [], id, fn);
  if (main) return { ...flow, steps: main };
  for (const process of flow.processes ?? []) {
    const steps = updateIn(process.steps ?? [], id, fn);
    if (steps) return withProcessSteps(flow, process.id, steps);
  }
  return flow;
}

export function getList(flow: Flow, ref: ListRef): Step[] | undefined {
  const process = processOfRef(ref);
  if (process === null) return flow.steps ?? [];
  if (process !== undefined) {
    return flow.processes?.some((p) => p.id === process) ? processSteps(flow, process) : undefined;
  }
  const parent = findStep(flow, ref.parentId!);
  return parent ? (parent.blocks?.[ref.block] ?? []) : undefined;
}

function updateList(flow: Flow, ref: ListRef, fn: (list: Step[]) => Step[]): Flow {
  const process = processOfRef(ref);
  if (process === null) return { ...flow, steps: fn(flow.steps ?? []) };
  if (process !== undefined) return withProcessSteps(flow, process, fn(processSteps(flow, process)));
  return updateStep(flow, ref.parentId!, (parent) => ({
    ...parent,
    blocks: { ...parent.blocks, [ref.block]: fn(parent.blocks?.[ref.block] ?? []) },
  }));
}

function findStepIn(steps: Step[], id: string): Step | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    for (const children of Object.values(step.blocks ?? {})) {
      const found = findStepIn(children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function findStep(flow: Flow, id: string): Step | undefined {
  for (const { steps } of roots(flow)) {
    const found = findStepIn(steps, id);
    if (found) return found;
  }
  return undefined;
}

/** Where a step lives: its list and position. */
export function locate(flow: Flow, id: string): { ref: ListRef; index: number } | null {
  const search = (steps: Step[], ref: ListRef): { ref: ListRef; index: number } | null => {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (step.id === id) return { ref, index: i };
      for (const [block, children] of Object.entries(step.blocks ?? {})) {
        const found = search(children, { parentId: step.id, block });
        if (found) return found;
      }
    }
    return null;
  };
  for (const { ref, steps } of roots(flow)) {
    const found = search(steps, ref);
    if (found) return found;
  }
  return null;
}

/** The process a step is in: a sub-process id, null for the main one, undefined if absent. */
export function processOfStep(flow: Flow, id: string): string | null | undefined {
  let ref = locate(flow, id)?.ref;
  while (ref) {
    const process = processOfRef(ref);
    if (process !== undefined) return process;
    ref = locate(flow, ref.parentId!)?.ref;
  }
  return undefined;
}

export function insertStep(flow: Flow, ref: ListRef, index: number, step: Step): Flow {
  return updateList(flow, ref, (list) => {
    const copy = list.slice();
    copy.splice(Math.max(0, Math.min(index, copy.length)), 0, step);
    return copy;
  });
}

export function removeStep(flow: Flow, id: string): Flow {
  const where = locate(flow, id);
  if (!where) return flow;
  return updateList(flow, where.ref, (list) => list.filter((s) => s.id !== id));
}

function isInside(flow: Flow, ancestorId: string, ref: ListRef): boolean {
  let parentId = ref.parentId;
  while (parentId && !parentId.startsWith(PROCESS)) {
    if (parentId === ancestorId) return true;
    parentId = locate(flow, parentId)?.ref.parentId ?? null;
  }
  return false;
}

/** Move a step to a list and position. Moving a step into itself is ignored. */
export function moveStep(flow: Flow, id: string, to: ListRef, toIndex: number): Flow {
  const from = locate(flow, id);
  if (!from || isInside(flow, id, to) || to.parentId === id) return flow;
  const step = findStep(flow, id)!;
  let index = toIndex;
  if (listKey(from.ref) === listKey(to) && from.index < toIndex) index -= 1;
  if (listKey(from.ref) === listKey(to) && from.index === index) return flow;
  return insertStep(removeStep(flow, id), to, index, step);
}

/** Deep copy of a step (and its children) with fresh ids. */
export function cloneStep(step: Step): Step {
  return {
    ...structuredClone(step),
    id: newStepId(),
    blocks: step.blocks
      ? Object.fromEntries(Object.entries(step.blocks).map(([k, v]) => [k, v.map(cloneStep)]))
      : undefined,
  };
}

export function duplicateStep(flow: Flow, id: string): { flow: Flow; newId: string | null } {
  const where = locate(flow, id);
  const step = findStep(flow, id);
  if (!where || !step) return { flow, newId: null };
  const copy = cloneStep(step);
  return { flow: insertStep(flow, where.ref, where.index + 1, copy), newId: copy.id };
}

/** Steps of one process in display order (depth first), used for keyboard navigation. */
export function flatIds(flow: Flow, processId: string | null = null): string[] {
  const out: string[] = [];
  const visit = (steps: Step[]) => {
    for (const s of steps) {
      out.push(s.id);
      for (const children of Object.values(s.blocks ?? {})) visit(children);
    }
  };
  visit(processSteps(flow, processId));
  return out;
}

// -- sub-processes -------------------------------------------------------------------------------

/** A short id for a new sub-process ("process_2"), unique in the flow. */
export function newProcessId(flow: Flow): string {
  const taken = new Set((flow.processes ?? []).map((p) => p.id));
  let n = (flow.processes?.length ?? 0) + 1;
  while (taken.has(`process_${n}`)) n++;
  return `process_${n}`;
}

export function addProcess(flow: Flow, name: string): { flow: Flow; id: string } {
  const id = newProcessId(flow);
  const process: SubProcess = { id, name, description: '', inputs: [], steps: [] };
  return { flow: { ...flow, processes: [...(flow.processes ?? []), process] }, id };
}

export function updateProcess(flow: Flow, id: string, fn: (p: SubProcess) => SubProcess): Flow {
  return { ...flow, processes: (flow.processes ?? []).map((p) => (p.id === id ? fn(p) : p)) };
}

/** Remove a sub-process. "Run sub-process" steps that used it then show a problem to fix. */
export function removeProcess(flow: Flow, id: string): Flow {
  return { ...flow, processes: (flow.processes ?? []).filter((p) => p.id !== id) };
}

/** Copy a sub-process (its steps get new ids). */
export function duplicateProcess(flow: Flow, id: string): { flow: Flow; id: string | null } {
  const source = flow.processes?.find((p) => p.id === id);
  if (!source) return { flow, id: null };
  const copyId = newProcessId(flow);
  const copy: SubProcess = {
    ...structuredClone(source),
    id: copyId,
    name: `${source.name} (copy)`,
    steps: (source.steps ?? []).map(cloneStep),
  };
  return { flow: { ...flow, processes: [...(flow.processes ?? []), copy] }, id: copyId };
}

/** Steps that run a sub-process (to warn before deleting it). */
export function processUsers(flow: Flow, id: string): Step[] {
  const out: Step[] = [];
  const visit = (steps: Step[]) => {
    for (const s of steps) {
      if (s.activity === 'control.run_process' && s.params?.process === id) out.push(s);
      for (const children of Object.values(s.blocks ?? {})) visit(children);
    }
  };
  for (const { steps } of roots(flow)) visit(steps);
  return out;
}

export function setParam(flow: Flow, id: string, name: string, value: unknown): Flow {
  return updateStep(flow, id, (step) => {
    const params = { ...step.params };
    if (value === undefined) delete params[name];
    else params[name] = value;
    return { ...step, params };
  });
}

/** Keep an AI fix from a test run: the step's changed settings and the element's new selectors. */
export function applyRepairPatch(flow: Flow, patch: RepairPatch): Flow {
  let next = updateStep(flow, patch.step_id, (step) => ({ ...step, params: { ...step.params, ...patch.params } }));
  const element = patch.element;
  if (element) {
    const elements = next.elements ?? [];
    const exists = elements.some((e) => e.id === element.id);
    next = {
      ...next,
      elements: exists
        ? elements.map((e) => (e.id === element.id ? { ...e, selectors: element.selectors, context: element.context } : e))
        : [...elements, element],
    };
  }
  return next;
}

// -- flowchart layout (never affects runs) -----------------------------------------------------------

/** Remember that a step (or start / end) was moved by dx, dy from where it was. */
export function moveOnChart(flow: Flow, key: string, dx: number, dy: number): Flow {
  const offsets = { ...(flow.layout?.offsets ?? {}) };
  const x = (offsets[key]?.x ?? 0) + dx;
  const y = (offsets[key]?.y ?? 0) + dy;
  if (x === 0 && y === 0) delete offsets[key];
  else offsets[key] = { x, y };
  return { ...flow, layout: { ...flow.layout, offsets } };
}

/** Forget moves (Tidy up), for the given keys or all of them. */
export function tidyChart(flow: Flow, keys?: Iterable<string>): Flow {
  if (!flow.layout?.offsets) return flow;
  if (!keys) return { ...flow, layout: { ...flow.layout, offsets: {} } };
  const offsets = { ...flow.layout.offsets };
  for (const key of keys) delete offsets[key];
  return { ...flow, layout: { ...flow.layout, offsets } };
}
