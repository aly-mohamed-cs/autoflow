// Shape of generated/activity-catalog.json, produced by `autoflow-engine catalog`.
import type { VariableType } from './flow';

/** Widget kinds a setting can ask for (engine catalog.UI_KINDS). */
export type UiKind =
  | 'text' | 'multiline' | 'number' | 'boolean' | 'choice' | 'file' | 'folder' | 'save_file'
  | 'variable' | 'variable_name' | 'condition' | 'element' | 'credential' | 'column' | 'keys'
  | 'url' | 'key_values' | 'list' | 'code' | 'duration' | 'password'
  | 'process' | 'process_inputs' | 'point' | 'image' | 'region' | 'asset' | 'queue' | 'sap_id';

/** A JSON Schema property as exported by pydantic, plus Autoflow's x- hints. */
export interface ParamSchema {
  title?: string;
  description?: string;
  type?: string;
  enum?: unknown[];
  default?: unknown;
  anyOf?: ParamSchema[];
  items?: ParamSchema;
  $ref?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  pattern?: string;
  additionalProperties?: boolean | ParamSchema;
  'x-ui'?: UiKind;
  'x-placeholder'?: string;
  'x-advanced'?: boolean;
  'x-lazy'?: boolean;
  'x-source'?: string;
  'x-file-types'?: string[];
  /** For choices: the words shown for each value. */
  'x-labels'?: Record<string, string>;
  /** Only show the setting while other settings have one of these values. */
  'x-show-when'?: Record<string, string[]>;
}

export interface ParamsSchema {
  title?: string;
  type: 'object';
  properties: Record<string, ParamSchema>;
  required?: string[];
  $defs?: Record<string, { properties?: Record<string, ParamSchema>; required?: string[] } & ParamSchema>;
}

export interface OutputDef {
  name: string;
  title: string;
  type: VariableType;
  description: string;
  default_variable: string;
}

export interface BlockDef {
  name: string;
  title: string;
}

export interface ActivityDef {
  id: string;
  title: string;
  category: string;
  icon: string;
  sentence: string;
  description: string;
  params: ParamsSchema;
  outputs: OutputDef[];
  blocks: BlockDef[];
  /** One more block per item of a list setting (Switch: a block per case), named prefix + number. */
  block_list?: { param: string; prefix: string } | null;
  advanced: boolean;
  requires: string | null;
  /** Flowchart only: the ways out of the step, e.g. a Decision's Yes and No. */
  ports?: { name: string; title: string }[];
}

/** The step lists a step has: one per item of its block_list setting, then the fixed ones. */
export function blocksOf(def: ActivityDef, params: Record<string, unknown> | undefined): BlockDef[] {
  if (!def.block_list) return def.blocks;
  const items = params?.[def.block_list.param];
  const extra = Array.isArray(items)
    ? items.map((item, i) => ({ name: `${def.block_list!.prefix}${i + 1}`, title: String(item ?? '') || `Case ${i + 1}` }))
    : [];
  return [...extra, ...def.blocks];
}

export interface CategoryDef {
  id: string;
  icon: string;
  description: string;
}

export interface FunctionDef {
  name: string;
  signature: string;
  description: string;
  category: string;
}

export interface OperatorDef {
  name: string;
  label: string;
  needs_value: boolean;
}

export interface Catalog {
  engine_version: string;
  categories: CategoryDef[];
  activities: ActivityDef[];
  functions: FunctionDef[];
  operators: OperatorDef[];
}

export interface Rule {
  left?: unknown;
  op: string;
  right?: unknown;
}

export interface Condition {
  match?: 'all' | 'any';
  rules?: Rule[];
  expression?: string | null;
}
