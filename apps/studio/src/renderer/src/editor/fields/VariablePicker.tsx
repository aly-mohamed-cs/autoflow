import type { VariableType } from '@autoflow/flow-types';
import { Button, cn, Dialog, Icon, Input, Popover, Textarea } from '@autoflow/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { columnRef } from '../../lib/catalog';
import { TYPE_ICONS, TYPE_LABELS, type VariableInfo } from '../../lib/scope';
import { useApp } from '../../store/app';
import { useRun } from '../../store/run';

interface Option {
  key: string;
  expr: string;
  label: string;
  detail: string;
  icon: string;
  indent?: boolean;
}

function buildOptions(variables: VariableInfo[], columnsFor: (name: string) => string[]): Option[] {
  const out: Option[] = [];
  for (const v of variables) {
    out.push({ key: v.name, expr: v.name, label: v.name, detail: `${TYPE_LABELS[v.type]} · ${v.source}`, icon: TYPE_ICONS[v.type as VariableType] });
    if (v.type === 'credential') {
      for (const part of ['username', 'password']) {
        out.push({ key: `${v.name}.${part}`, expr: `${v.name}.${part}`, label: part, detail: `of ${v.name}`, icon: part === 'password' ? 'lock' : 'user', indent: true });
      }
    }
    if (v.type !== 'table') {
      for (const column of columnsFor(v.name)) {
        out.push({ key: `${v.name}[${column}]`, expr: columnRef(v.name, column), label: column, detail: `column of ${v.name}`, icon: 'columns-3', indent: true });
      }
    }
  }
  return out;
}

export function VariablePicker({
  trigger,
  open,
  onOpenChange,
  variables,
  columnsFor,
  onPick,
}: {
  trigger: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variables: VariableInfo[];
  columnsFor: (name: string) => string[];
  onPick: (expr: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [formulaOpen, setFormulaOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const options = useMemo(() => buildOptions(variables, columnsFor), [variables, columnsFor]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.detail.toLowerCase().includes(q)) : options;
  }, [options, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange} trigger={trigger} align="end" className="w-80 p-0">
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            value={query}
            placeholder="Search variables and columns"
            aria-label="Search variables"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && filtered[active]) {
                e.preventDefault();
                onPick(filtered[active]!.expr);
              }
            }}
          />
        </div>
        <ul ref={listRef} role="listbox" aria-label="Variables" className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <li className="px-2 py-6 text-center text-[13px] text-subtle">
              {options.length === 0
                ? 'No variables yet. Steps that produce results (like “Read Excel sheet”) create them.'
                : 'Nothing matches.'}
            </li>
          )}
          {filtered.map((o, i) => (
            <li
              key={o.key}
              role="option"
              aria-selected={i === active}
              data-index={i}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(o.expr);
              }}
              className={cn(
                'flex cursor-default items-center gap-2 rounded px-2 py-1.5',
                o.indent && 'pl-7',
                i === active && 'bg-primary-soft',
              )}
            >
              <Icon name={o.icon} size={14} className="shrink-0 text-subtle" />
              <span className="truncate text-[13px] font-medium">{o.label}</span>
              <span className="ml-auto truncate text-[11px] text-subtle">{o.detail}</span>
            </li>
          ))}
        </ul>
        <div className="border-t border-border p-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg"
            onClick={() => {
              onOpenChange(false);
              setFormulaOpen(true);
            }}
          >
            <Icon name="sigma" size={14} /> Write a formula…
            <span className="ml-auto text-[11px] text-subtle">advanced</span>
          </button>
        </div>
      </Popover>
      <FormulaDialog open={formulaOpen} onOpenChange={setFormulaOpen} onInsert={onPick} variables={variables} />
    </>
  );
}

/** Excel-style formula builder with a function list and a live preview. */
export function FormulaDialog({
  open,
  onOpenChange,
  onInsert,
  variables,
  initial = '',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (expr: string) => void;
  variables: VariableInfo[];
  initial?: string;
}) {
  const functions = useApp((s) => s.index.catalog.functions);
  const values = useRun((s) => s.values);
  const [text, setText] = useState(initial);
  const [preview, setPreview] = useState<{ ok: boolean; value?: unknown; error?: string } | null>(null);
  const [category, setCategory] = useState('Text');
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) setText(initial);
  }, [open, initial]);

  useEffect(() => {
    if (!open || !text.trim()) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      const sample = Object.fromEntries(variables.map((v) => [v.name, sampleValue(values[v.name])]));
      window.autoflow.engine
        .call<{ ok: boolean; value?: unknown; error?: string }>('expression.evaluate', { expression: text, variables: sample })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [text, open, variables, values]);

  const categories = [...new Set(functions.map((f) => f.category))];
  const insertText = (snippet: string) => {
    const el = area.current;
    if (!el) return setText((t) => t + snippet);
    const start = el.selectionStart;
    const next = text.slice(0, start) + snippet + text.slice(el.selectionEnd);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Formula"
      description="Calculate a value, like in Excel. Example: ROUND(row[&quot;Total&quot;] * 1.14, 2)"
      width="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!text.trim()}
            onClick={() => {
              onInsert(text.trim());
              onOpenChange(false);
            }}
          >
            Insert
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_220px] gap-4">
        <div className="space-y-2">
          <Textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            spellCheck={false}
            className="font-mono text-[13px]"
            aria-label="Formula"
            autoFocus
          />
          <div
            className={cn(
              'min-h-9 rounded-md px-3 py-2 text-[13px]',
              !preview ? 'bg-surface-2 text-subtle' : preview.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
            )}
          >
            {!preview ? 'The result appears here.' : preview.ok ? <>Result: <strong>{formatPreview(preview.value)}</strong></> : preview.error}
          </div>
          <p className="text-xs text-subtle">
            Variables: {variables.map((v) => v.name).join(', ') || 'none yet'}. Values from your last test run are used
            for the preview.
          </p>
        </div>
        <div className="flex max-h-72 flex-col rounded-md border border-border">
          <select
            className="border-b border-border bg-surface-2 px-2 py-1.5 text-[13px]"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Function category"
          >
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <ul className="flex-1 overflow-y-auto p-1">
            {functions
              .filter((f) => f.category === category)
              .map((f) => (
                <li key={f.name}>
                  <button
                    type="button"
                    title={f.description}
                    onClick={() => insertText(`${f.name}()`)}
                    className="w-full rounded px-2 py-1 text-left hover:bg-surface-2"
                  >
                    <span className="font-mono text-xs font-semibold">{f.signature}</span>
                    <span className="block text-[11px] leading-tight text-subtle">{f.description}</span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}

/** Turn a run preview ({$type: table, ...}) back into something the evaluator can use. */
function sampleValue(preview: unknown): unknown {
  if (preview && typeof preview === 'object' && '$type' in preview) {
    const p = preview as { $type: string; value?: unknown; rows?: unknown[] };
    if (p.$type === 'date') return p.value;
    if (p.$type === 'table') return p.rows ?? [];
  }
  return preview;
}

export function formatPreview(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'object') {
    const v = value as { $type?: string; value?: unknown; row_count?: number };
    if (v.$type === 'date') return String(v.value);
    if (v.$type === 'table') return `table with ${v.row_count} rows`;
    return JSON.stringify(value);
  }
  return String(value);
}
