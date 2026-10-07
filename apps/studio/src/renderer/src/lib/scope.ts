// Which variables exist in a flow, where they come from, and what is known about them
// (type, table columns). Feeds the variable picker so users choose instead of typing.
import type { Flow, Step, VariableType } from '@autoflow/flow-types';
import { rootVariable, TEMPLATE, type CatalogIndex } from './catalog';

export interface VariableInfo {
  name: string;
  type: VariableType;
  /** Where it's set: "Start value", "Result of Read Excel sheet", "Loop item"... */
  source: string;
  /** For loop items: only valid inside these steps' blocks. */
  loopStepId?: string;
  /** Variable whose items this loop variable walks through. */
  itemsOf?: string;
  sensitive?: boolean;
  isInput?: boolean;
  isOutput?: boolean;
}

/** Variables that steps set by name, per activity (beyond regular outputs). */
const NAMED_VARIABLE_TYPES: Record<string, Record<string, VariableType>> = {
  'control.for_each': { item_variable: 'any', index_variable: 'number' },
  'control.repeat': { counter_variable: 'number' },
  'control.try': { error_variable: 'text' },
  'control.set_variable': { variable: 'any' },
  'control.increase': { variable: 'number' },
  'control.add_to_list': { variable: 'list' },
  'data.add_row': { table: 'table' },
};

const LOOP_FIELDS = new Set(['item_variable', 'index_variable', 'counter_variable', 'error_variable']);

export function collectVariables(flow: Flow, index: CatalogIndex): VariableInfo[] {
  const found = new Map<string, VariableInfo>();
  const add = (info: VariableInfo) => {
    const existing = found.get(info.name);
    if (!existing || (existing.type === 'any' && info.type !== 'any')) found.set(info.name, { ...existing, ...info });
  };
  for (const v of flow.variables ?? []) {
    add({
      name: v.name,
      type: v.type ?? 'any',
      source: v.is_input ? 'Start value' : 'Flow variable',
      sensitive: v.sensitive,
      isInput: v.is_input,
      isOutput: v.is_output,
    });
  }
  const visit = (steps: Step[]) => {
    for (const step of steps) {
      const def = index.get(step.activity);
      if (def) {
        for (const out of def.outputs) {
          const name = step.outputs?.[out.name];
          if (name) add({ name, type: out.type, source: `Result of “${def.title}”` });
        }
        for (const [field, type] of Object.entries(NAMED_VARIABLE_TYPES[step.activity] ?? {})) {
          const fallback = index.fields(def).find((f) => f.name === field)?.default;
          const name = (step.params?.[field] ?? fallback) as string | undefined;
          if (!name || typeof name !== 'string' || name.includes('{{')) continue;
          const isLoop = LOOP_FIELDS.has(field);
          const items = field === 'item_variable' ? referencedVariable(step.params?.items) : undefined;
          add({
            name,
            type,
            source: isLoop ? (field === 'error_variable' ? 'Error message' : `Loop: ${def.title}`) : `Set by “${def.title}”`,
            loopStepId: isLoop ? step.id : undefined,
            itemsOf: items ?? undefined,
          });
        }
      }
      for (const children of Object.values(step.blocks ?? {})) visit(children);
    }
  };
  visit(flow.steps ?? []);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** If a setting is exactly {{name}} (or {{name[...]}}), the variable it refers to. */
export function referencedVariable(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const matches = [...value.matchAll(TEMPLATE)];
  if (matches.length !== 1 || matches[0]![0] !== value.trim()) return null;
  return rootVariable(matches[0]![1]!);
}

/** Variables usable at a step: everything, except loop items of loops the step isn't in. */
export function variablesInScope(all: VariableInfo[], ancestorIds: string[]): VariableInfo[] {
  const ancestors = new Set(ancestorIds);
  return all.filter((v) => !v.loopStepId || ancestors.has(v.loopStepId));
}

/**
 * Columns known for a variable: from the last test run's values, or - for a loop item -
 * from the table it loops over.
 */
export function knownColumns(
  name: string,
  variables: VariableInfo[],
  runValues: Record<string, unknown>,
): string[] {
  const direct = tableColumns(runValues[name]) ?? rowColumns(runValues[name]);
  if (direct) return direct;
  const info = variables.find((v) => v.name === name);
  if (info?.itemsOf) return tableColumns(runValues[info.itemsOf]) ?? [];
  return [];
}

function tableColumns(value: unknown): string[] | null {
  if (value && typeof value === 'object' && (value as { $type?: string }).$type === 'table') {
    return (value as { columns: string[] }).columns;
  }
  return null;
}

function rowColumns(value: unknown): string[] | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && !('$type' in value)) {
    return Object.keys(value);
  }
  return null;
}

export const TYPE_LABELS: Record<VariableType, string> = {
  any: 'Any',
  text: 'Text',
  number: 'Number',
  boolean: 'Yes/No',
  date: 'Date',
  list: 'List',
  table: 'Table',
  file: 'File',
  credential: 'Credential',
};

export const TYPE_ICONS: Record<VariableType, string> = {
  any: 'braces',
  text: 'type',
  number: 'hash',
  boolean: 'toggle-left',
  date: 'calendar',
  list: 'list',
  table: 'table',
  file: 'file',
  credential: 'key-round',
};

/** Turn a label like "Invoice total" into a valid variable name: invoice_total. */
export function toVariableName(label: string): string {
  const cleaned = label
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!cleaned) return '';
  return /^[0-9]/.test(cleaned) ? `v_${cleaned}` : cleaned;
}
