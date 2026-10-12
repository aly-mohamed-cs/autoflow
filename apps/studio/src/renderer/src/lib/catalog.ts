import type {
  ActivityDef,
  Catalog,
  Condition,
  Element,
  ParamSchema,
  ParamsSchema,
  Step,
  UiKind,
} from '@autoflow/flow-types';
import { blocksOf, normalizeCondition } from '@autoflow/flow-types';
import { newStepId } from './flowOps';

export type FieldKind = UiKind | 'object_list';

export interface FieldInfo {
  name: string;
  title: string;
  description?: string;
  schema: ParamSchema;
  kind: FieldKind;
  required: boolean;
  nullable: boolean;
  advanced: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** For object_list fields: the item's own fields. */
  itemFields?: FieldInfo[];
  default?: unknown;
}

export class CatalogIndex {
  readonly byId = new Map<string, ActivityDef>();
  readonly byCategory = new Map<string, ActivityDef[]>();
  private readonly fieldCache = new Map<string, FieldInfo[]>();

  constructor(readonly catalog: Catalog) {
    for (const def of catalog.activities) {
      this.byId.set(def.id, def);
      const list = this.byCategory.get(def.category) ?? [];
      list.push(def);
      this.byCategory.set(def.category, list);
    }
  }

  get(id: string): ActivityDef | undefined {
    return this.byId.get(id);
  }

  fields(def: ActivityDef): FieldInfo[] {
    let cached = this.fieldCache.get(def.id);
    if (!cached) {
      cached = fieldsOf(def.params);
      this.fieldCache.set(def.id, cached);
    }
    return cached;
  }

  operatorLabel(name: string): string {
    return this.catalog.operators.find((o) => o.name === name)?.label ?? name;
  }
}

function resolveRef(root: ParamsSchema, schema: ParamSchema): ParamSchema {
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop()!;
    return {
      ...(root.$defs?.[name] ?? {}),
      title: schema.title ?? root.$defs?.[name]?.title,
      ...stripRef(schema),
    };
  }
  return schema;
}

function stripRef(schema: ParamSchema): ParamSchema {
  const { $ref: _ref, ...rest } = schema;
  return rest;
}

export function fieldsOf(params: ParamsSchema, root: ParamsSchema = params): FieldInfo[] {
  const required = new Set(params.required ?? []);
  return Object.entries(params.properties ?? {}).map(([name, raw]) => {
    let schema = raw;
    let nullable = false;
    if (schema.anyOf) {
      const nonNull = schema.anyOf.filter((s) => s.type !== 'null');
      nullable = nonNull.length < schema.anyOf.length;
      if (nonNull.length === 1) schema = { ...nonNull[0], ...withoutAnyOf(schema) };
    }
    const isConditionRef = (raw.$ref ?? schema.$ref ?? '').endsWith('/Condition');
    schema = resolveRef(root, schema);
    const kind = inferKind(schema, isConditionRef);
    const info: FieldInfo = {
      name,
      title: schema.title ?? humanize(name),
      description: schema.description,
      schema,
      kind,
      required: required.has(name),
      nullable,
      advanced: !!schema['x-advanced'],
      placeholder: schema['x-placeholder'],
      default: schema.default,
    };
    if (schema.enum) {
      const labels = schema['x-labels'] ?? {};
      info.options = schema.enum.map((v) => ({
        value: String(v),
        label: labels[String(v)] ?? humanize(String(v)),
      }));
    }
    if (kind === 'object_list' && schema.items) {
      const item = resolveRef(root, schema.items) as unknown as ParamsSchema;
      info.itemFields = fieldsOf(item, root);
    }
    return info;
  });
}

/**
 * Whether a setting applies: settings with "x-show-when" only count while the other
 * setting (or its default) has one of the listed values.
 */
export function isShown(
  field: FieldInfo,
  params: Record<string, unknown>,
  fields: FieldInfo[],
): boolean {
  const rule = field.schema['x-show-when'];
  if (!rule) return true;
  return Object.entries(rule).every(([other, values]) => {
    const current = params[other] ?? fields.find((f) => f.name === other)?.default;
    return values.map(String).includes(String(current));
  });
}

function withoutAnyOf(schema: ParamSchema): ParamSchema {
  const { anyOf: _a, ...rest } = schema;
  return rest;
}

function inferKind(schema: ParamSchema, isCondition: boolean): FieldKind {
  if (schema['x-ui']) return schema['x-ui'];
  if (isCondition) return 'condition';
  if (schema.enum) return 'choice';
  switch (schema.type) {
    case 'boolean':
      return 'boolean';
    case 'number':
    case 'integer':
      return 'number';
    case 'array':
      return schema.items?.type === 'string' || !schema.items ? 'list' : 'object_list';
    case 'object':
      return 'key_values';
    default:
      return 'text';
  }
}

/** "title contains" -> "Title contains", "at_cell" -> "At cell". */
export function humanize(value: string): string {
  const text = value.replace(/_/g, ' ').trim();
  if (!text) return value;
  if (text === text.toUpperCase() && /[A-Z]/.test(text)) return text; // "UPPER CASE"
  return text[0]!.toUpperCase() + text.slice(1);
}

/** A new step with sensible defaults: output variables pre-named, empty condition rule. */
export function createStep(
  def: ActivityDef,
  index: CatalogIndex,
  existingVariables: Set<string> = new Set(),
): Step {
  const params: Record<string, unknown> = {};
  for (const field of index.fields(def)) {
    if (field.kind === 'condition')
      params[field.name] = { match: 'all', rules: [{ left: '', op: 'equals', right: '' }] };
  }
  const outputs: Record<string, string> = {};
  for (const out of def.outputs)
    outputs[out.name] = uniqueName(out.default_variable || out.name, existingVariables);
  const step: Step = { id: newStepId(), activity: def.id, params };
  if (def.outputs.length) step.outputs = outputs;
  const blocks = blocksOf(def, params);
  if (blocks.length) step.blocks = Object.fromEntries(blocks.map((b) => [b.name, []]));
  return step;
}

export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

// -- {{ }} references -------------------------------------------------------------

export const TEMPLATE = /\{\{([\s\S]+?)\}\}/g;

export type Segment = { kind: 'text'; text: string } | { kind: 'expr'; expr: string };

export function parseTemplate(value: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of value.matchAll(TEMPLATE)) {
    if (m.index! > last) out.push({ kind: 'text', text: value.slice(last, m.index) });
    out.push({ kind: 'expr', expr: m[1]!.trim() });
    last = m.index! + m[0].length;
  }
  if (last < value.length) out.push({ kind: 'text', text: value.slice(last) });
  return out;
}

export function serializeSegments(segments: Segment[]): string {
  return segments.map((s) => (s.kind === 'text' ? s.text : `{{${s.expr}}}`)).join('');
}

const PATH = /^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*|\["(?:[^"\\]|\\.)*"\]|\['(?:[^'\\]|\\.)*'\])*)$/;

/** Friendly label for a reference: row["Invoice No"] -> "row › Invoice No". */
export function exprLabel(expr: string): { label: string; formula: boolean } {
  const m = PATH.exec(expr.trim());
  if (!m) return { label: expr.trim(), formula: true };
  const parts = [m[1]!];
  for (const p of m[2]!.matchAll(
    /\.([A-Za-z_]\w*)|\["((?:[^"\\]|\\.)*)"\]|\['((?:[^'\\]|\\.)*)'\]/g,
  )) {
    parts.push((p[1] ?? p[2] ?? p[3] ?? '').replace(/\\(.)/g, '$1'));
  }
  return { label: parts.join(' › '), formula: false };
}

/** Reference to a column of a row variable, quoting the column name safely. */
export function columnRef(variable: string, column: string): string {
  return `${variable}[${JSON.stringify(column)}]`;
}

/** The variable name a reference starts with (row["x"] -> row), or null for formulas. */
export function rootVariable(expr: string): string | null {
  const m = PATH.exec(expr.trim());
  return m ? m[1]! : null;
}

// -- step sentences ----------------------------------------------------------------

export type SentencePart =
  | { kind: 'text'; text: string }
  | {
      kind: 'value';
      field: string;
      title: string;
      empty: boolean;
      required: boolean;
      segments: Segment[];
      element?: Element;
      /** For empty optional settings: what happens by default, e.g. "first sheet". */
      fallback?: string;
    };

export interface SentenceContext {
  index: CatalogIndex;
  elements: Map<string, Element>;
  /** Sub-process names by id ("Run sub-process Log in to ERP"). */
  processes?: Map<string, string>;
}

/** Turn "Type {text} into {element}" + params into displayable parts. */
export function sentence(step: Step, def: ActivityDef, ctx: SentenceContext): SentencePart[] {
  const fields = new Map(ctx.index.fields(def).map((f) => [f.name, f]));
  const parts: SentencePart[] = [];
  let last = 0;
  for (const m of def.sentence.matchAll(/\{(\w+)\}/g)) {
    if (m.index! > last) parts.push({ kind: 'text', text: def.sentence.slice(last, m.index) });
    last = m.index! + m[0].length;
    const field = fields.get(m[1]!);
    if (!field) continue;
    const value = step.params?.[field.name] ?? field.default;
    parts.push(valuePart(field, value, ctx));
  }
  if (last < def.sentence.length) parts.push({ kind: 'text', text: def.sentence.slice(last) });
  return parts;
}

function valuePart(field: FieldInfo, value: unknown, ctx: SentenceContext): SentencePart {
  const fallback = field.placeholder?.match(/^\((.+)\)/)?.[1];
  const base = {
    kind: 'value' as const,
    field: field.name,
    title: field.title,
    required: field.required,
    fallback,
  };
  const empty = (segments: Segment[] = []) => ({ ...base, empty: true, segments });
  if (value === undefined || value === null || value === '') return empty();
  if (field.kind === 'element' && typeof value === 'string') {
    const element = ctx.elements.get(value);
    return element
      ? { ...base, empty: false, segments: [{ kind: 'text', text: element.name }], element }
      : empty();
  }
  if (field.kind === 'process' && typeof value === 'string') {
    const name = ctx.processes?.get(value);
    return {
      ...base,
      empty: false,
      segments: [{ kind: 'text', text: name ?? `${value} (missing)` }],
    };
  }
  if (field.kind === 'condition') {
    const text = conditionSummary(value as Condition, ctx.index);
    return text ? { ...base, empty: false, segments: parseTemplate(text) } : empty();
  }
  return { ...base, empty: false, segments: parseTemplate(displayValue(field, value)) };
}

export function displayValue(field: FieldInfo, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (field.kind === 'choice' && typeof value === 'string')
    return field.options?.find((o) => o.value === value)?.label ?? value;
  if (Array.isArray(value))
    return value.map((v) => (typeof v === 'object' ? '…' : String(v))).join(', ');
  if (value && typeof value === 'object') return Object.keys(value).join(', ');
  return truncate(String(value), 60);
}

export function conditionSummary(value: Condition | undefined, index: CatalogIndex): string {
  if (!value) return '';
  const condition = normalizeCondition(value);
  if (condition.expression?.trim()) return condition.expression.trim();
  const rules = (condition.rules ?? []).filter((r) => r.left !== '' && r.left !== undefined);
  if (!rules.length) return '';
  const joiner = condition.match === 'any' ? ' or ' : ' and ';
  return rules
    .map((r) => {
      const op = index.operatorLabel(r.op);
      const needs = index.catalog.operators.find((o) => o.name === r.op)?.needs_value ?? true;
      const right = needs
        ? ` ${r.right === '' || r.right === undefined ? '…' : quoteIfText(r.right)}`
        : '';
      return `${String(r.left)} ${op}${right}`;
    })
    .join(joiner);
}

function quoteIfText(value: unknown): string {
  const text = String(value);
  return text.includes('{{') || /^-?\d+(\.\d+)?$/.test(text) ? text : `"${text}"`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
