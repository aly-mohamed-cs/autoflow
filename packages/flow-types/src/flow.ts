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

/** A named part of a flow (Brity "task"), started by "Run sub-process" steps. */
export interface SubProcess {
  id: string;
  name: string;
  description?: string;
  inputs?: ProcessInput[];
  steps?: Step[];
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
  processes?: SubProcess[];
  settings?: FlowSettings;
  layout?: Layout;
}

/** Property names per model, checked against the engine's JSON Schema in tests. */
export const MODEL_KEYS = {
  Flow: [
    'schema_version', 'id', 'name', 'description', 'variables', 'elements', 'steps', 'processes',
    'settings', 'layout',
  ],
  Variable: ['name', 'type', 'default', 'description', 'is_input', 'is_output', 'sensitive'],
  Selector: ['strategy', 'value', 'options'],
  Element: ['id', 'name', 'kind', 'selectors', 'screenshot', 'context'],
  OnError: ['retries', 'retry_delay', 'action'],
  Step: ['id', 'activity', 'label', 'params', 'outputs', 'blocks', 'on_error', 'disabled'],
  FlowSettings: ['default_timeout', 'screenshot_each_step', 'screenshot_on_error', 'step_delay'],
  ProcessInput: ['name', 'type', 'default', 'description'],
  SubProcess: ['id', 'name', 'description', 'inputs', 'steps'],
  Offset: ['x', 'y'],
  Layout: ['direction', 'offsets', 'collapsed'],
} as const satisfies Record<string, readonly string[]>;
