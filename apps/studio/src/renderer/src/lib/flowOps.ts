// Immutable edits of the step tree. Only the path to the changed step is copied,
// so unchanged step objects keep their identity and React can skip re-rendering them.
import type { Flow, RepairPatch, Step } from '@autoflow/flow-types';

/** A step list: the flow's top level, or one block ("then", "body"...) of a step. */
export interface ListRef {
  parentId: string | null;
  block: string;
}

export const ROOT: ListRef = { parentId: null, block: 'steps' };

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
  const steps = updateIn(flow.steps ?? [], id, fn);
  return steps ? { ...flow, steps } : flow;
}

export function getList(flow: Flow, ref: ListRef): Step[] | undefined {
  if (ref.parentId === null) return flow.steps ?? [];
  const parent = findStepIn(flow.steps ?? [], ref.parentId);
  return parent ? (parent.blocks?.[ref.block] ?? []) : undefined;
}

function updateList(flow: Flow, ref: ListRef, fn: (list: Step[]) => Step[]): Flow {
  if (ref.parentId === null) return { ...flow, steps: fn(flow.steps ?? []) };
  return updateStep(flow, ref.parentId, (parent) => ({
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
  return findStepIn(flow.steps ?? [], id);
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
  return search(flow.steps ?? [], ROOT);
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
  while (parentId) {
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

/** Steps in display order (depth first), used for keyboard navigation. */
export function flatIds(flow: Flow): string[] {
  const out: string[] = [];
  const visit = (steps: Step[]) => {
    for (const s of steps) {
      out.push(s.id);
      for (const children of Object.values(s.blocks ?? {})) visit(children);
    }
  };
  visit(flow.steps ?? []);
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
