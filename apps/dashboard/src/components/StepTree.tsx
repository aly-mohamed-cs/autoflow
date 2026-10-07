// Read-only view of an automation's steps, optionally with what happened in a run.
import type { Catalog, Flow, Step } from '@autoflow/flow-types';
import catalogJson from '@autoflow/flow-types/activity-catalog.json';
import { cn, Icon, IconTile, Tooltip } from '@autoflow/ui';
import type { ReactNode } from 'react';

const catalog = catalogJson as unknown as Catalog;
const DEFS = new Map(catalog.activities.map((a) => [a.id, a]));

export type StepStatus = 'running' | 'ok' | 'failed' | 'continued' | 'cancelled';

export interface StepRun {
  status: StepStatus;
  durationMs?: number;
  error?: { message: string; hint?: string | null };
}

interface Props {
  flow: Flow;
  runs?: Record<string, StepRun>;
  details?: (stepId: string) => ReactNode;
}

export function StepTree({ flow, runs, details }: Props) {
  const elements = new Map((flow.elements ?? []).map((e) => [e.id, e.name]));
  return <List steps={flow.steps ?? []} elements={elements} runs={runs} details={details} />;
}

function List({ steps, elements, runs, details }: { steps: Step[]; elements: Map<string, string> } & Pick<Props, 'runs' | 'details'>) {
  return (
    <ol className="space-y-1.5">
      {steps.map((step) => {
        const def = DEFS.get(step.activity);
        const run = runs?.[step.id];
        const reached = !runs || !!run;
        return (
          <li key={step.id}>
            <div
              className={cn(
                'flex items-start gap-2.5 rounded-md border px-2.5 py-2',
                run?.status === 'failed' ? 'border-danger/40 bg-danger-soft/40' : 'border-border bg-surface',
                !reached && 'opacity-50',
                step.disabled && 'opacity-40',
              )}
            >
              <IconTile name={def?.icon ?? 'circle-help'} category={def?.category} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] leading-6">
                  {step.label || sentenceText(step, def?.sentence ?? step.activity, elements)}
                  {step.disabled && <span className="ml-2 text-xs text-subtle">(skipped)</span>}
                </p>
                {run?.error && (
                  <p className="text-xs text-danger">
                    {run.error.message}
                    {run.error.hint && <span className="block text-muted">{run.error.hint}</span>}
                  </p>
                )}
                {details?.(step.id)}
              </div>
              {run && <StatusIcon run={run} />}
            </div>
            {def?.blocks.length ? (
              <div className="mt-1.5 ml-3 space-y-1.5 border-l-2 border-border pl-4">
                {def.blocks.map((b) =>
                  step.blocks?.[b.name]?.length ? (
                    <div key={b.name}>
                      <p className="mb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">{b.title}</p>
                      <List steps={step.blocks[b.name]!} elements={elements} runs={runs} details={details} />
                    </div>
                  ) : null,
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function StatusIcon({ run }: { run: StepRun }) {
  const took = run.durationMs !== undefined ? `${(run.durationMs / 1000).toFixed(1)} s` : '';
  const map: Record<StepStatus, { icon: string; cls: string; label: string }> = {
    running: { icon: 'loader', cls: 'text-primary animate-spin', label: 'Running' },
    ok: { icon: 'circle-check', cls: 'text-success', label: 'Done' },
    failed: { icon: 'circle-x', cls: 'text-danger', label: 'Failed' },
    continued: { icon: 'circle-alert', cls: 'text-warning', label: 'Failed, continued' },
    cancelled: { icon: 'circle-slash', cls: 'text-subtle', label: 'Stopped' },
  };
  const s = map[run.status];
  return (
    <Tooltip content={`${s.label}${took ? ` · ${took}` : ''}`}>
      <span className="flex items-center gap-1 pt-1 text-[11px] text-subtle tabular-nums">
        {took}
        <Icon name={s.icon} size={15} className={s.cls} aria-label={s.label} />
      </span>
    </Tooltip>
  );
}

/** "Type {text} into {element}" -> "Type row › Name into Username box". */
function sentenceText(step: Step, sentence: string, elements: Map<string, string>): string {
  return sentence.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = step.params?.[name];
    if (value === undefined || value === null || value === '') return '…';
    if (name === 'element' && typeof value === 'string') return elements.get(value) ?? '…';
    if (typeof value === 'object') {
      const cond = value as { rules?: { left?: unknown; op?: string; right?: unknown }[]; expression?: string };
      if (cond.expression) return cond.expression;
      if (cond.rules) return cond.rules.map((r) => `${pretty(String(r.left ?? ''))} ${(r.op ?? '').replace(/_/g, ' ')} ${pretty(String(r.right ?? ''))}`.trim()).join(' and ');
      return Array.isArray(value) ? value.join(', ') : Object.keys(value).join(', ');
    }
    return pretty(String(value));
  });
}

function pretty(text: string): string {
  const out = text.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (_m, expr: string) =>
    expr.replace(/\["([^"]+)"\]/g, ' › $1').replace(/\./g, ' › '),
  );
  return out.length > 70 ? `${out.slice(0, 69)}…` : out;
}
