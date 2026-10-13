// Renders one activity setting with the right widget, chosen from the catalog schema.
import type { Condition } from '@autoflow/flow-types';
import { Field, Select, Switch, Textarea } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import { referencedVariable } from '../../lib/scope';
import type { FieldInfo } from '../../lib/catalog';
import type { VariableInfo } from '../../lib/scope';
import { ConditionEditor } from './ConditionEditor';
import { ElementInput } from './ElementInput';
import { PointInput } from './PointInput';
import { ProcessInputsInput, ProcessSelect } from './ProcessFields';
import { ImageInput, RegionInput } from './ScreenInputs';
import {
  ColumnInput,
  FileAddon,
  KeyValuesInput,
  ListInput,
  NumberInput,
  ObjectListInput,
  VariableNameInput,
} from './inputs';
import { TokenInput } from './TokenInput';

export interface ParamFieldProps {
  field: FieldInfo;
  value: unknown;
  /** All current settings of the step (some widgets look at siblings, e.g. column pickers). */
  params: Record<string, unknown>;
  onChange: (value: unknown) => void;
  /** Change other settings of the step too (e.g. the window a picked position is in). */
  onParams?: (patch: Record<string, unknown>) => void;
  variables: VariableInfo[];
  columnsFor: (name: string) => string[];
  elementKind: 'web' | 'desktop';
  error?: string;
  warning?: string;
}

export function ParamField(props: ParamFieldProps) {
  const { field, value, error, warning } = props;
  const id = `param-${field.name}`;
  const inline = field.kind === 'boolean';
  return (
    <Field
      label={field.title}
      help={field.description}
      error={error}
      warning={warning}
      required={field.required}
      htmlFor={id}
      inline={inline}
    >
      <Widget {...props} id={id} value={value} />
    </Field>
  );
}

function Widget({
  field,
  value,
  params,
  onChange,
  onParams,
  variables,
  columnsFor,
  elementKind,
  error,
  id,
}: ParamFieldProps & { id: string }) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const tokenProps = { variables, columnsFor, invalid: !!error, ariaLabel: field.title, id };
  const sourceColumns = () => {
    const source = field.schema['x-source'];
    const table = source ? referencedVariable(params[source]) : null;
    return table ? columnsFor(table) : [];
  };

  switch (field.kind) {
    case 'boolean':
      return <Switch id={id} label={field.title} checked={Boolean(value ?? field.default)} onChange={onChange} />;

    case 'choice':
      return (
        <Select
          id={id}
          value={String(value ?? field.default ?? '')}
          onChange={onChange}
          options={field.options ?? []}
        />
      );

    case 'number':
    case 'duration':
      return <NumberInput id={id} value={value} onChange={onChange} field={field} variables={variables} columnsFor={columnsFor} />;

    case 'multiline':
      return <TokenInput {...tokenProps} value={text} onChange={(v) => onChange(v || undefined)} multiline placeholder={field.placeholder} />;

    case 'code':
      return (
        <CodeInput id={id} value={text} onChange={(v) => onChange(v || undefined)} placeholder={field.placeholder} />
      );

    case 'file':
    case 'folder':
    case 'save_file':
      return (
        <TokenInput
          {...tokenProps}
          value={text}
          onChange={(v) => onChange(v || undefined)}
          placeholder={field.placeholder ?? (field.kind === 'folder' ? 'Choose a folder' : 'Choose a file')}
          addon={<FileAddon kind={field.kind} fileTypes={field.schema['x-file-types']} onPick={(p) => onChange(p)} />}
        />
      );

    case 'variable':
      return (
        <TokenInput
          {...tokenProps}
          value={text}
          onChange={(v) => onChange(v || undefined)}
          placeholder={field.placeholder ?? 'Choose a variable'}
          preferVariables
        />
      );

    case 'variable_name':
      return (
        <VariableNameInput
          id={id}
          value={value ?? field.default}
          onChange={(v) => onChange(v || undefined)}
          variables={variables}
        />
      );

    case 'condition': {
      const rowTable = field.name === 'condition' && 'table' in params ? referencedVariable(params.table) : null;
      return (
        <ConditionEditor
          value={value}
          onChange={onChange}
          variables={variables}
          columnsFor={columnsFor}
          rowVariable={'table' in params ? { name: 'row', columns: rowTable ? columnsFor(rowTable) : [] } : undefined}
        />
      );
    }

    case 'element':
      return <ElementInput value={value} onChange={onChange} kind={elementKind} />;

    case 'credential':
      return <CredentialInput id={id} value={text} onChange={(v) => onChange(v || undefined)} />;

    case 'column':
      return <ColumnInput id={id} value={value} onChange={(v) => onChange(v || undefined)} columns={sourceColumns()} />;

    case 'list':
      return (
        <ListInput
          id={id}
          value={value}
          onChange={onChange}
          suggestions={guessColumns(params, columnsFor)}
          placeholder={field.placeholder ?? 'Type and press Enter'}
        />
      );

    case 'key_values':
      return (
        <KeyValuesInput
          value={value}
          onChange={onChange}
          variables={variables}
          columnsFor={columnsFor}
          keySuggestions={guessColumns(params, columnsFor)}
        />
      );

    case 'process':
      return <ProcessSelect id={id} value={value} onChange={onChange} />;

    case 'process_inputs':
      return (
        <ProcessInputsInput
          value={value}
          onChange={onChange}
          processId={params[field.schema['x-source'] ?? 'process']}
          variables={variables}
          columnsFor={columnsFor}
        />
      );

    case 'image':
      return <ImageInput value={value} onChange={onChange} />;

    case 'region':
      return (
        <RegionInput
          id={id}
          value={value}
          onChange={onChange}
          params={params}
          onParams={(patch) => onParams?.(patch)}
          ariaLabel={field.title}
          placeholder={field.placeholder}
          variables={variables}
          columnsFor={columnsFor}
        />
      );

    case 'point':
      return (
        <PointInput
          id={id}
          value={value}
          onChange={onChange}
          mode={field.name === 'point' ? 'element' : params.relative_to === 'screen' ? 'screen' : 'window'}
          params={params}
          onParams={(patch) => onParams?.(patch)}
          canPick={elementKind === 'desktop'}
          ariaLabel={field.title}
          placeholder={field.placeholder}
          variables={variables}
          columnsFor={columnsFor}
          invalid={!!error}
        />
      );

    case 'object_list':
      return <ObjectListInput value={value} onChange={onChange} field={field} columns={guessColumns(params, columnsFor)} />;

    default:
      return <TokenInput {...tokenProps} value={text} onChange={(v) => onChange(v || undefined)} placeholder={field.placeholder} />;
  }
}

/** Columns of whichever table this step works on, for suggestions. */
function guessColumns(params: Record<string, unknown>, columnsFor: (name: string) => string[]): string[] {
  for (const key of ['table', 'left', 'items']) {
    const name = referencedVariable(params[key]);
    if (name) return columnsFor(name);
  }
  return [];
}

function CodeInput({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Textarea
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      rows={5}
      className="font-mono text-xs"
    />
  );
}

function CredentialInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    void window.autoflow.vault.list().then((list) => setNames(list.map((c) => c.name)));
  }, []);
  const options = [...new Set([...names, ...(value ? [value] : [])])].map((n) => ({
    value: n,
    label: names.includes(n) ? n : `${n} (not on this computer)`,
  }));
  return (
    <div className="space-y-1">
      <Select id={id} value={value} onChange={onChange} options={options} placeholder="Choose a saved credential" />
      {names.length === 0 && <p className="text-xs text-subtle">Add credentials on the Credentials page first.</p>}
    </div>
  );
}
