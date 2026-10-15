// Mirrors engine/src/autoflow_engine/flow.py. flow.test.ts fails if the two drift apart.

export type VariableType =
  | 'any' | 'text' | 'number' | 'boolean' | 'date' | 'list' | 'table' | 'file' | 'credential';

export interface Variable {
  name: string;
  type?: VariableType;
  default?: unknown;
  description?: string;
  is_input?: boolean;
  is_output?: boolean;
  sensitive?: boolean;
}

export type SelectorStrategy =
  | 'role' | 'text' | 'label' | 'placeholder' | 'testid' | 'css' | 'xpath' | 'uia' | 'image' | 'ocr';

export interface Selector {
  strategy: SelectorStrategy;
  value: string;
  options?: Record<string, unknown>;
}

export interface Element {
  id: string;
  name: string;
  kind: 'web' | 'desktop';
  selectors: Selector[];
  screenshot?: string | null;
  context?: Record<string, unknown>;
}

export interface OnError {
  retries?: number;
  retry_delay?: number;
  action?: 'stop' | 'continue';
}

export interface Step {
  id: string;
  activity: string;
  label?: string | null;
  params?: Record<string, unknown>;
  outputs?: Record<string, string>;
  blocks?: Record<string, Step[]>;
  on_error?: OnError;
  disabled?: boolean;
}

/** A value a sub-process is started with; it becomes a variable while it runs. */
export interface ProcessInput {
  name: string;
  type?: VariableType;
  default?: unknown;
  description?: string;
}

/** A connector drawn by hand in a flowchart: after `source` (a step, or "start"), run `target`. */
export interface Link {
  source: string;
  target: string;
  /** "next", or "yes" / "no" out of a Decision. */
  port?: 'next' | 'yes' | 'no';
}

export interface Point {
  x?: number;
  y?: number;
}

/**
 * Free connections: steps run in the order they are connected, beginning at Start; a step
 * nothing leads to doesn't run. Without it, a process runs its steps one after the other.
 */
export interface Flowchart {
  links?: Link[];
  /** Where each step (and "start") is drawn; never affects a run. */
  positions?: Record<string, Point>;
}

/** A named part of a flow (Brity "task"), started by "Run sub-process" steps. */
export interface SubProcess {
  id: string;
  name: string;
  description?: string;
  inputs?: ProcessInput[];
  steps?: Step[];
  flowchart?: Flowchart | null;
}

export interface Offset {
  x?: number;
  y?: number;
}

/** How the Flow view draws the chart; never affects a run. */
export interface Layout {
  direction?: 'horizontal' | 'vertical';
  /** How far a step (or start / end) was moved from its tidy place, by id. */
  offsets?: Record<string, Offset>;
  /** Boxes (groups, loops...) shown folded: just their title. */
  collapsed?: string[];
}

export interface FlowSettings {
  default_timeout?: number;
  screenshot_each_step?: boolean;
  screenshot_on_error?: boolean;
  /** Seconds to wait after every step. */
  step_delay?: number;
}

export interface Flow {
  schema_version?: number;
  id: string;
  name: string;
  description?: string;
  variables?: Variable[];
  elements?: Element[];
  steps?: Step[];
  /** The main process's free connections, if it uses them. */
  flowchart?: Flowchart | null;
  processes?: SubProcess[];
  settings?: FlowSettings;
  layout?: Layout;
}

/** Property names per model, checked against the engine's JSON Schema in tests. */
export const MODEL_KEYS = {
  Flow: [
    'schema_version', 'id', 'name', 'description', 'variables', 'elements', 'steps', 'flowchart',
    'processes', 'settings', 'layout',
  ],
  Variable: ['name', 'type', 'default', 'description', 'is_input', 'is_output', 'sensitive'],
  Selector: ['strategy', 'value', 'options'],
  Element: ['id', 'name', 'kind', 'selectors', 'screenshot', 'context'],
  OnError: ['retries', 'retry_delay', 'action'],
  Step: ['id', 'activity', 'label', 'params', 'outputs', 'blocks', 'on_error', 'disabled'],
  FlowSettings: ['default_timeout', 'screenshot_each_step', 'screenshot_on_error', 'step_delay'],
  ProcessInput: ['name', 'type', 'default', 'description'],
  SubProcess: ['id', 'name', 'description', 'inputs', 'steps', 'flowchart'],
  Link: ['source', 'target', 'port'],
  Point: ['x', 'y'],
  Flowchart: ['links', 'positions'],
  Offset: ['x', 'y'],
  Layout: ['direction', 'offsets', 'collapsed'],
} as const satisfies Record<string, readonly string[]>;
