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

export function findStep(flow: Flow, id: string): Step | undefined {
  for (const { step } of walkSteps(flow.steps)) if (step.id === id) return step;
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
  visit(flow.steps ?? []);
  return path;
}
