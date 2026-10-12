import type { Flow, Step } from './flow';

export interface StepEntry {
  step: Step;
  parent: Step | null;
  list: Step[];
  index: number;
  depth: number;
}

/** Every step in the tree, depth first, with its parent list and position. */
export function* walkSteps(steps: Step[] = [], parent: Step | null = null, depth = 0): Generator<StepEntry> {
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    yield { step, parent, list: steps, index, depth };
    for (const children of Object.values(step.blocks ?? {})) {
      yield* walkSteps(children, step, depth + 1);
    }
  }
}

/** The main step list and each sub-process's, with the sub-process id (null for the main one). */
export function stepLists(flow: Flow): { processId: string | null; steps: Step[] }[] {
  return [
    { processId: null, steps: flow.steps ?? [] },
    ...(flow.processes ?? []).map((p) => ({ processId: p.id, steps: p.steps ?? [] })),
  ];
}

/** Every step of the flow: main process first, then each sub-process. */
export function* walkFlow(flow: Flow): Generator<StepEntry & { processId: string | null }> {
  for (const { processId, steps } of stepLists(flow)) {
    for (const entry of walkSteps(steps)) yield { ...entry, processId };
  }
}

export function findStep(flow: Flow, id: string): Step | undefined {
  for (const { step } of walkFlow(flow)) if (step.id === id) return step;
  return undefined;
}

/** Which process a step belongs to: a sub-process id, null for the main one, undefined if absent. */
export function processOf(flow: Flow, id: string): string | null | undefined {
  for (const { step, processId } of walkFlow(flow)) if (step.id === id) return processId;
  return undefined;
}

/** Ids of the step and all its ancestors, outermost first. Empty if not found. */
export function stepPath(flow: Flow, id: string): string[] {
  const path: string[] = [];
  const visit = (steps: Step[]): boolean => {
    for (const step of steps) {
      path.push(step.id);
      if (step.id === id) return true;
      for (const children of Object.values(step.blocks ?? {})) if (visit(children)) return true;
      path.pop();
    }
    return false;
  };
  for (const { steps } of stepLists(flow)) if (visit(steps)) break;
  return path;
}
