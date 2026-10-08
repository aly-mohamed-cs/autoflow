// Conditions (If / Repeat while / filter rows) in their one valid shape.
// Mirrors normalize_condition in engine/src/autoflow_engine/runtime/conditions.py.
import type { Condition, Rule } from './catalog';

/**
 * Any stored condition value as a proper Condition. AI drafts may write a condition as text
 * ("{{row['Paid']}}"), and Studio 0.3.0 and older split such text into one entry per character
 * when a rule was added ({"0":"{","1":"{",...}). Text becomes a formula; split text is joined back.
 */
export function normalizeCondition(value: unknown): Condition {
  if (typeof value === 'string') {
    return value.trim() ? { match: 'all', rules: [], expression: asExpression(value) } : { match: 'all', rules: [] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { match: 'all', rules: [] };
  const raw = value as Record<string, unknown>;
  const condition: Condition = {
    match: raw.match === 'any' ? 'any' : 'all',
    rules: Array.isArray(raw.rules) ? (raw.rules as Rule[]) : [],
  };
  if (typeof raw.expression === 'string') {
    condition.expression = raw.expression;
  } else if (!condition.rules!.length) {
    const text = splitText(raw);
    if (text.trim()) condition.expression = asExpression(text);
  }
  return condition;
}

/**
 * One formula from condition text. "{{row["Amount"]}} > 100" would otherwise become the text
 * "250 > 100" (always true); it becomes {{row["Amount"] > 100}}.
 */
export function asExpression(text: string): string {
  const trimmed = text.trim();
  if (/^\{\{[\s\S]*\}\}$/.test(trimmed) && !trimmed.slice(2).includes('{{')) return trimmed;
  return `{{${trimmed.replace(/\{\{|\}\}/g, '').trim()}}}`;
}

function splitText(raw: Record<string, unknown>): string {
  let text = '';
  for (let i = 0; typeof raw[String(i)] === 'string'; i++) text += raw[String(i)];
  return text;
}
