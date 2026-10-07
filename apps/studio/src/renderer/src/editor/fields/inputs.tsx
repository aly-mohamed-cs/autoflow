import { Button, cn, Icon, Input, Popover, Select } from '@autoflow/ui';
import { useEffect, useMemo, useState } from 'react';
import type { FieldInfo } from '../../lib/catalog';
import { humanize } from '../../lib/catalog';
import { toVariableName, TYPE_ICONS, type VariableInfo } from '../../lib/scope';
import { TokenInput } from './TokenInput';

interface ValueProps {
  variables: VariableInfo[];
  columnsFor: (name: string) => string[];
}

/** Number box that can switch to a variable or formula. */
export function NumberInput({
  value,
  onChange,
  field,
  id,
  ...rest
}: ValueProps & { value: unknown; onChange: (v: unknown) => void; field: FieldInfo; id?: string }) {
  const isTemplate = typeof value === 'string' && value.includes('{{');
  if (isTemplate) {
    return (
      <div className="flex items-start gap-1">
        <TokenInput className="flex-1" value={value} onChange={(v) => onChange(v || undefined)} id={id} ariaLabel={field.title} {...rest} />
        <Button variant="ghost" size="icon" aria-label="Type a number instead" onClick={() => onChange(undefined)}>
          <Icon name="hash" size={14} />
        </Button>
      </div>
    );
  }
  const min = field.schema.minimum ?? field.schema.exclusiveMinimum;
  return (
    <div className="flex items-center gap-1">
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={field.default !== undefined && field.default !== null ? String(field.default) : field.placeholder}
        min={min}
        max={field.schema.maximum}
        step={field.schema.type === 'integer' ? 1 : 'any'}
        onChange={(e) => {
          const text = e.target.value;
          onChange(text === '' ? undefined : Number(text));
        }}
        className="flex-1"
      />
      {field.kind === 'duration' && <span className="text-xs text-subtle">seconds</span>}
      <VariableSwitch onPick={(expr) => onChange(`{{${expr}}}`)} {...rest} />
    </div>
  );
}

/** Small {x} button that replaces a typed value with a variable. */
function VariableSwitch({ onPick, variables, columnsFor }: ValueProps & { onPick: (expr: string) => void }) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => {
    const out: { expr: string; label: string }[] = [];
    for (const v of variables) {
      out.push({ expr: v.name, label: v.name });
      for (const c of columnsFor(v.name)) out.push({ expr: `${v.name}[${JSON.stringify(c)}]`, label: `${v.name} › ${c}` });
    }
    return out;
  }, [variables, columnsFor]);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-64 p-1"
      trigger={
        <Button variant="ghost" size="icon" aria-label="Use a variable" title="Use a variable">
          <Icon name="braces" size={14} />
        </Button>
      }
    >
      {options.length === 0 && <p className="p-3 text-[13px] text-subtle">No variables yet.</p>}
      <ul className="max-h-64 overflow-y-auto">
        {options.map((o) => (
          <li key={o.expr}>
            <button
              type="button"
              className="w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-surface-2"
              onClick={() => {
                setOpen(false);
                onPick(o.expr);
              }}
            >
              {o.label}
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

/** Editable list of short texts (column names, keys...). */
export function ListInput({
  value,
  onChange,
  suggestions = [],
  placeholder = 'Add…',
  id,
}: {
  value: unknown;
  onChange: (v: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  id?: string;
}) {
  const items = Array.isArray(value) ? value.map(String) : [];
  const [draft, setDraft] = useState('');
  const add = (text: string) => {
    const t = text.trim();
    if (t && !items.includes(t)) onChange([...items, t]);
    setDraft('');
  };
  const remaining = suggestions.filter((s) => !items.includes(s));
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1 rounded-md border border-border bg-surface p-1 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
        {items.map((item, i) => (
          <span key={`${item}-${i}`} className="inline-flex items-center gap-1 rounded bg-surface-2 py-0.5 pr-1 pl-2 text-[13px]">
            {item}
            <button type="button" aria-label={`Remove ${item}`} className="text-subtle hover:text-danger" onClick={() => onChange(items.filter((_, j) => j !== i))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && items.length) {
              onChange(items.slice(0, -1));
            }
          }}
          onBlur={() => draft && add(draft)}
          placeholder={items.length ? '' : placeholder}
          className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-subtle"
        />
      </div>
      {remaining.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {remaining.slice(0, 12).map((s) => (
            <button key={s} type="button" onClick={() => add(s)} className="rounded-full border border-dashed border-border-strong px-2 py-0.5 text-xs text-muted hover:border-primary hover:text-primary">
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Column name -> value pairs (e.g. values for a new Excel row). */
export function KeyValuesInput({
  value,
  onChange,
  keySuggestions = [],
  ...rest
}: ValueProps & { value: unknown; onChange: (v: Record<string, unknown>) => void; keySuggestions?: string[] }) {
  const entries = Object.entries((value && typeof value === 'object' ? value : {}) as Record<string, unknown>);
  const [newKey, setNewKey] = useState('');
  const write = (pairs: [string, unknown][]) => onChange(Object.fromEntries(pairs));
  const addKey = (key: string) => {
    const k = key.trim();
    if (!k || entries.some(([e]) => e === k)) return;
    write([...entries, [k, '']]);
    setNewKey('');
  };
  const unused = keySuggestions.filter((k) => !entries.some(([e]) => e === k));
  return (
    <div className="space-y-1.5">
      {entries.map(([key, val], i) => (
        <div key={i} className="grid grid-cols-[minmax(80px,40%)_1fr_auto] items-start gap-1">
          <Input
            value={key}
            aria-label="Column"
            onChange={(e) => write(entries.map(([k, v], j) => (j === i ? [e.target.value, v] : [k, v])))}
          />
          <TokenInput
            value={typeof val === 'string' ? val : val === undefined || val === null ? '' : String(val)}
            onChange={(v) => write(entries.map(([k, old], j) => (j === i ? [k, v] : [k, old])))}
            ariaLabel={`Value for ${key}`}
            {...rest}
          />
          <Button variant="ghost" size="icon" aria-label={`Remove ${key}`} onClick={() => write(entries.filter((_, j) => j !== i))}>
            <Icon name="x" size={14} />
          </Button>
        </div>
      ))}
      <div className="flex gap-1">
        <Input
          value={newKey}
          placeholder="Column name"
          aria-label="New column name"
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addKey(newKey);
            }
          }}
        />
        <Button icon={<Icon name="plus" size={14} />} onClick={() => addKey(newKey)} disabled={!newKey.trim()}>
          Add
        </Button>
      </div>
      {unused.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {unused.slice(0, 12).map((k) => (
            <button key={k} type="button" onClick={() => addKey(k)} className="rounded-full border border-dashed border-border-strong px-2 py-0.5 text-xs text-muted hover:border-primary hover:text-primary">
              + {k}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Choose an existing variable or type a new name (spaces become underscores). */
export function VariableNameInput({
  value,
  onChange,
  variables,
  id,
  placeholder = 'Variable name',
}: {
  value: unknown;
  onChange: (v: string) => void;
  variables: VariableInfo[];
  id?: string;
  placeholder?: string;
}) {
  const current = typeof value === 'string' ? value : '';
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(current);
  useEffect(() => {
    setDraft(current);
  }, [current]);
  const matches = variables.filter((v) => v.name !== current && v.name.toLowerCase().includes(draft.toLowerCase()));
  return (
    <div className="relative">
      <Icon name="variable" size={14} className="pointer-events-none absolute top-2 left-2.5 text-primary" />
      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        className="pl-8 font-medium"
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setTimeout(() => setOpen(false), 120);
          const name = toVariableName(draft);
          setDraft(name);
          if (name !== current) onChange(name);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {open && matches.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-pop">
          {matches.slice(0, 20).map((v) => (
            <li key={v.name}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setDraft(v.name);
                  onChange(v.name);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] hover:bg-surface-2"
              >
                <Icon name={TYPE_ICONS[v.type]} size={13} className="text-subtle" />
                {v.name}
                <span className="ml-auto truncate text-[11px] text-subtle">{v.source}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Pick a column of a table (known from the last test run) or type its name. */
export function ColumnInput({
  value,
  onChange,
  columns,
  id,
}: {
  value: unknown;
  onChange: (v: string) => void;
  columns: string[];
  id?: string;
}) {
  const current = typeof value === 'string' ? value : '';
  if (columns.length && (!current || columns.includes(current))) {
    return (
      <div className="flex gap-1">
        <Select
          id={id}
          value={current}
          onChange={onChange}
          placeholder="Choose a column"
          options={columns.map((c) => ({ value: c, label: c }))}
          className="flex-1"
        />
      </div>
    );
  }
  return (
    <div>
      <Input id={id} value={current} onChange={(e) => onChange(e.target.value)} placeholder="Column name" />
      {!columns.length && <p className="mt-1 text-xs text-subtle">Run the automation once to choose from the real columns.</p>}
    </div>
  );
}

/** Rows of small forms, e.g. the calculations of "Group and summarize". */
export function ObjectListInput({
  value,
  onChange,
  field,
  columns,
}: {
  value: unknown;
  onChange: (v: Record<string, unknown>[]) => void;
  field: FieldInfo;
  columns: string[];
}) {
  const items = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  const fields = field.itemFields ?? [];
  const blank = () => Object.fromEntries(fields.map((f) => [f.name, f.default ?? '']));
  return (
    <div className="space-y-1.5">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-1 rounded-md border border-border bg-surface-2 p-1.5">
          <div className="grid flex-1 grid-cols-3 gap-1">
            {fields.map((f) => {
              const v = item[f.name];
              const set = (nv: unknown) => onChange(items.map((it, j) => (j === i ? { ...it, [f.name]: nv } : it)));
              if (f.options) {
                return <Select key={f.name} value={String(v ?? f.default ?? '')} onChange={set} options={f.options} />;
              }
              if (f.name === 'column' && columns.length) {
                return (
                  <Select key={f.name} value={String(v ?? '')} onChange={set} placeholder="Column" options={columns.map((c) => ({ value: c, label: c }))} />
                );
              }
              return <Input key={f.name} value={String(v ?? '')} placeholder={humanize(f.name)} aria-label={f.title} onChange={(e) => set(e.target.value)} />;
            })}
          </div>
          <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <Icon name="x" size={14} />
          </Button>
        </div>
      ))}
      <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => onChange([...items, blank()])}>
        Add
      </Button>
    </div>
  );
}

export function FileAddon({ kind, fileTypes, onPick }: { kind: 'file' | 'folder' | 'save_file'; fileTypes?: string[]; onPick: (path: string) => void }) {
  const browse = async () => {
    const filters = fileTypes?.length ? [{ name: fileTypes.join(', ').toUpperCase(), extensions: fileTypes }] : undefined;
    const path =
      kind === 'folder'
        ? await window.autoflow.dialog.openFolder()
        : kind === 'save_file'
          ? await window.autoflow.dialog.saveFile({ filters })
          : await window.autoflow.dialog.openFile({ filters });
    if (path) onPick(path);
  };
  return (
    <Button variant="ghost" size="icon-sm" aria-label={kind === 'folder' ? 'Browse for folder' : 'Browse for file'} title="Browse…" onClick={browse}>
      <Icon name={kind === 'folder' ? 'folder-open' : 'file-search'} size={14} />
    </Button>
  );
}
