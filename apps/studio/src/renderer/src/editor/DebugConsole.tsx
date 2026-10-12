// Debug console (Brity "debugging console"): try formulas against the values of the current
// test run - most useful while it is paused at a step.
import { Button, Icon, Input } from '@autoflow/ui';
import { useState } from 'react';
import { useRun } from '../store/run';

interface Entry {
  expression: string;
  ok: boolean;
  text: string;
  hint?: string | null;
}

export function DebugConsole() {
  const phase = useRun((s) => s.phase);
  const [expression, setExpression] = useState('');
  const [history, setHistory] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);

  const evaluate = async () => {
    const text = expression.trim().replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
    if (!text) return;
    setBusy(true);
    try {
      const r = await window.autoflow.engine.call<{
        ok: boolean;
        value?: unknown;
        error?: string;
        hint?: string | null;
      }>('run.evaluate', { expression: text });
      setHistory((h) => [
        ...h.slice(-49),
        r.ok
          ? { expression: text, ok: true, text: show(r.value) }
          : {
              expression: text,
              ok: false,
              text: r.error ?? 'Could not work it out.',
              hint: r.hint,
            },
      ]);
      setExpression('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 font-mono text-[12.5px]"
        aria-live="polite"
      >
        {history.length === 0 && (
          <p className="font-sans text-[13px] text-subtle">
            {phase === 'idle'
              ? 'Start a test run - pause it at a step (F9 on the step) - then type a formula below to see its value, e.g. row["Total"] * 1.14.'
              : 'Type a formula below to see its value with the variables the run has right now.'}
          </p>
        )}
        {history.map((entry, i) => (
          <div key={i}>
            <p className="text-muted">› {entry.expression}</p>
            <pre
              className={
                entry.ok ? 'whitespace-pre-wrap text-fg' : 'whitespace-pre-wrap text-danger'
              }
            >
              {entry.text}
            </pre>
            {entry.hint && <p className="font-sans text-xs text-subtle">{entry.hint}</p>}
          </div>
        ))}
      </div>
      <form
        className="flex gap-2 border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void evaluate();
        }}
      >
        <Input
          aria-label="Formula to work out"
          className="font-mono"
          placeholder='UPPER(row["Customer"])'
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
        />
        <Button type="submit" loading={busy} icon={<Icon name="corner-down-left" size={14} />}>
          Show value
        </Button>
      </form>
    </div>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return JSON.stringify(value);
  const text = JSON.stringify(value, null, 2);
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}
