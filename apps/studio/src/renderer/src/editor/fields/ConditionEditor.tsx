import { normalizeCondition, type Condition, type Rule } from '@autoflow/flow-types';
import { Button, Icon, Segmented, Select, Tooltip } from '@autoflow/ui';
import type { VariableInfo } from '../../lib/scope';
import { useApp } from '../../store/app';
import { TokenInput } from './TokenInput';

/**
 * "Keep rows where [Amount] [is greater than] [1000]" - rules instead of formulas.
 * An advanced formula can be used instead, but rules are the default.
 */
export function ConditionEditor({
  value,
  onChange,
  variables,
  columnsFor,
  rowVariable,
}: {
  /** Usually a Condition, but AI drafts and older versions can leave text (see normalizeCondition). */
  value: unknown;
  onChange: (value: Condition) => void;
  variables: VariableInfo[];
  columnsFor: (name: string) => string[];
  /** For table filters: rules refer to row["Column"]. */
  rowVariable?: { name: string; columns: string[] };
}) {
  const operators = useApp((s) => s.index.catalog.operators);
  // Every edit saves this cleaned-up shape, which also repairs conditions damaged by Studio 0.3.0.
  const condition = normalizeCondition(value);
  const rules = condition.rules ?? [];
  const usingFormula = condition.expression !== undefined && condition.expression !== null;

  const scopeVars: VariableInfo[] = rowVariable
    ? [{ name: rowVariable.name, type: 'any', source: 'Current row' }, ...variables]
    : variables;
  const scopeColumns = (name: string) =>
    rowVariable && name === rowVariable.name ? rowVariable.columns : columnsFor(name);

  const setRule = (i: number, patch: Partial<Rule>) =>
    onChange({ ...condition, rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  if (usingFormula) {
    return (
      <div className="space-y-2">
        <TokenInput
          value={condition.expression ?? ''}
          onChange={(expression) => onChange({ ...condition, expression })}
          variables={scopeVars}
          columnsFor={scopeColumns}
          placeholder="A formula that is true or false"
          ariaLabel="Condition formula"
        />
        <Button size="sm" variant="ghost" onClick={() => onChange({ match: condition.match ?? 'all', rules, expression: null })}>
          Use simple rules instead
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rules.length > 1 && (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          Continue when
          <Segmented
            size="sm"
            value={condition.match ?? 'all'}
            onChange={(match) => onChange({ ...condition, match })}
            options={[
              { value: 'all', label: 'all rules match' },
              { value: 'any', label: 'any rule matches' },
            ]}
          />
        </div>
      )}
      {rules.map((rule, i) => {
        const needsValue = operators.find((o) => o.name === rule.op)?.needs_value ?? true;
        return (
          <div key={i} className="space-y-1.5 rounded-md border border-border bg-surface-2 p-2">
            <div className="flex items-start gap-1">
              <TokenInput
                className="flex-1"
                value={String(rule.left ?? '')}
                onChange={(left) => setRule(i, { left })}
                variables={scopeVars}
                columnsFor={scopeColumns}
                placeholder={rowVariable ? 'Pick a column' : 'Pick a variable'}
                ariaLabel={`Rule ${i + 1} value to check`}
                preferVariables
              />
              <Tooltip content="Remove rule">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove rule ${i + 1}`}
                  onClick={() => onChange({ ...condition, rules: rules.filter((_, j) => j !== i) })}
                >
                  <Icon name="x" size={14} />
                </Button>
              </Tooltip>
            </div>
            <Select
              value={rule.op}
              onChange={(op) => setRule(i, { op })}
              options={operators.map((o) => ({ value: o.name, label: o.label }))}
            />
            {needsValue && (
              <TokenInput
                value={String(rule.right ?? '')}
                onChange={(right) => setRule(i, { right })}
                variables={scopeVars}
                columnsFor={scopeColumns}
                placeholder="Value"
                ariaLabel={`Rule ${i + 1} comparison value`}
              />
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          icon={<Icon name="plus" size={14} />}
          onClick={() => onChange({ ...condition, rules: [...rules, { left: '', op: 'equals', right: '' }] })}
        >
          Add rule
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange({ ...condition, expression: '' })}>
          Use a formula
        </Button>
      </div>
      <p className="text-xs text-subtle">Text comparisons ignore upper/lower case and extra spaces.</p>
    </div>
  );
}
