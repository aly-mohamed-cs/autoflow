import type { Flow } from '@autoflow/flow-types';
import { Badge, Button, cn, Dialog, EmptyState, Icon, Tabs } from '@autoflow/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { findStep } from '../lib/flowOps';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { formatDuration, useRun, type LogEntry } from '../store/run';
import { formatPreview } from './fields/VariablePicker';

export function RunPanel({ height, onResize }: { height: number; onResize: (h: number) => void }) {
  const [tab, setTab] = useState('log');
  const issues = useEditor((s) => s.issues);
  const phase = useRun((s) => s.phase);
  const result = useRun((s) => s.result);
  const errorCount = issues.filter((i) => i.severity === 'error').length;

  useEffect(() => {
    if (phase === 'starting') setTab('log');
  }, [phase]);

  return (
    <section className="flex shrink-0 flex-col border-t border-border bg-surface" style={{ height }} aria-label="Run and problems">
      <ResizeHandle height={height} onResize={onResize} />
      <Tabs
        value={tab}
        onChange={setTab}
        className="min-h-0 flex-1"
        tabs={[
          {
            value: 'log',
            label: (
              <>
                <Icon name="list-video" size={14} /> Test run
                {result && (
                  <Badge tone={result.status === 'succeeded' ? 'success' : result.status === 'failed' ? 'danger' : 'neutral'}>
                    {result.status === 'succeeded' ? 'passed' : result.status === 'failed' ? 'failed' : 'stopped'}
                  </Badge>
                )}
              </>
            ),
            content: <RunLog />,
          },
          { value: 'variables', label: <><Icon name="variable" size={14} /> Variables</>, content: <VariablesView /> },
          {
            value: 'problems',
            label: (
              <>
                <Icon name="triangle-alert" size={14} /> Problems
                {issues.length > 0 && <Badge tone={errorCount ? 'danger' : 'warning'}>{issues.length}</Badge>}
              </>
            ),
            content: <ProblemsView />,
          },
        ]}
      />
    </section>
  );
}

function ResizeHandle({ height, onResize }: { height: number; onResize: (h: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize panel"
      tabIndex={0}
      className="h-1 cursor-row-resize bg-transparent hover:bg-primary/40"
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') onResize(Math.min(height + 24, 600));
        if (e.key === 'ArrowDown') onResize(Math.max(height - 24, 120));
      }}
      onPointerDown={(e) => {
        const startY = e.clientY;
        const start = height;
        const move = (ev: PointerEvent) => onResize(Math.min(Math.max(start + startY - ev.clientY, 120), window.innerHeight * 0.7));
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

const LEVEL_ICON: Record<LogEntry['level'], { icon: string; className: string }> = {
  info: { icon: 'info', className: 'text-subtle' },
  step: { icon: 'dot', className: 'text-subtle' },
  warning: { icon: 'triangle-alert', className: 'text-warning' },
  error: { icon: 'circle-x', className: 'text-danger' },
  success: { icon: 'circle-check', className: 'text-success' },
};

function RunLog() {
  const log = useRun((s) => s.log);
  const phase = useRun((s) => s.phase);
  const startedAt = useRun((s) => s.startedAt);
  const flow = useEditor((s) => s.flow);
  const select = useEditor((s) => s.select);
  const index = useApp((s) => s.index);
  const bottom = useRef<HTMLDivElement>(null);
  const [shot, setShot] = useState<string | null>(null);

  useEffect(() => {
    // Braces matter: newer Chromium returns a Promise from scrollIntoView, which React would treat as a cleanup.
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [log.length]);

  if (phase === 'idle' && log.length === 0) {
    return (
      <EmptyState icon={<Icon name="play" size={24} />} title="Test your automation here" className="py-6">
        Press <strong>Test run</strong> to run it on this computer. You'll see every step, its results and screenshots.
      </EmptyState>
    );
  }

  const stepName = (id?: string) => {
    if (!id || !flow) return null;
    const step = findStep(flow, id);
    return step ? step.label || index.get(step.activity)?.title || step.activity : null;
  };

  return (
    <div className="font-[450]">
      {phase === 'starting' && <p className="px-4 py-2 text-[13px] text-muted">Starting… {startedAt && ''}</p>}
      <ul className="divide-y divide-border/60">
        {log.map((entry) => {
          const level = LEVEL_ICON[entry.level];
          const name = stepName(entry.stepId);
          return (
            <li key={entry.id} className="flex items-start gap-2 px-4 py-1.5 text-[13px]">
              <Icon name={level.icon} size={15} className={cn('mt-0.5 shrink-0', level.className)} />
              <div className="min-w-0 flex-1">
                <p className="break-words">{entry.message}</p>
                {entry.hint && <p className="text-xs text-muted">{entry.hint}</p>}
                {entry.screenshot && (
                  <button type="button" onClick={() => setShot(entry.screenshot!)} className="mt-1 block">
                    <img src={window.autoflow.app.fileUrl(entry.screenshot)} alt="Screenshot" className="h-20 rounded border border-border" />
                  </button>
                )}
              </div>
              {name && (
                <button type="button" onClick={() => select(entry.stepId!)} className="shrink-0 truncate text-xs text-primary hover:underline">
                  {name}
                </button>
              )}
              <time className="shrink-0 text-[11px] text-subtle tabular-nums">{new Date(entry.ts * 1000).toLocaleTimeString()}</time>
            </li>
          );
        })}
      </ul>
      <div ref={bottom} />
      <Dialog open={!!shot} onOpenChange={(o) => !o && setShot(null)} title="Screenshot" width="xl">
        {shot && <img src={window.autoflow.app.fileUrl(shot)} alt="Screenshot of the screen during the run" className="w-full rounded border border-border" />}
      </Dialog>
    </div>
  );
}

function VariablesView() {
  const values = useRun((s) => s.values);
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  const [table, setTable] = useState<{ name: string; value: TablePreview } | null>(null);
  if (!entries.length) {
    return (
      <EmptyState icon={<Icon name="variable" size={24} />} title="No values yet" className="py-6">
        After a test run you can see what each variable contained.
      </EmptyState>
    );
  }
  return (
    <>
      <table className="w-full text-[13px]">
        <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
          <tr>
            <th className="px-4 py-1.5 font-medium">Variable</th>
            <th className="px-4 py-1.5 font-medium">Value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {entries.map(([name, value]) => (
            <tr key={name}>
              <td className="w-56 px-4 py-1.5 align-top font-medium">{name}</td>
              <td className="px-4 py-1.5">
                {isTable(value) ? (
                  <button type="button" className="text-primary hover:underline" onClick={() => setTable({ name, value })}>
                    Table · {value.row_count} rows · {value.columns.join(', ')}
                  </button>
                ) : (
                  <span className="line-clamp-2 font-mono text-xs break-all">{formatPreview(value)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Dialog open={!!table} onOpenChange={(o) => !o && setTable(null)} title={table?.name ?? ''} description={table ? `${table.value.row_count} rows (first ${table.value.rows.length} shown)` : ''} width="xl">
        {table && <TableView value={table.value} />}
      </Dialog>
    </>
  );
}

interface TablePreview {
  $type: 'table';
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
}

const isTable = (v: unknown): v is TablePreview => !!v && typeof v === 'object' && (v as { $type?: string }).$type === 'table';

function TableView({ value }: { value: TablePreview }) {
  return (
    <div className="max-h-[60vh] overflow-auto rounded border border-border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface-2">
          <tr>
            <th className="px-2 py-1 text-right text-subtle">#</th>
            {value.columns.map((c) => (
              <th key={c} className="px-2 py-1 text-left font-semibold whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {value.rows.map((row, i) => (
            <tr key={i}>
              <td className="px-2 py-1 text-right text-subtle">{i + 1}</td>
              {value.columns.map((c) => (
                <td key={c} className="px-2 py-1 whitespace-nowrap">{formatPreview(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProblemsView() {
  const issues = useEditor((s) => s.issues);
  const flow = useEditor((s) => s.flow);
  const select = useEditor((s) => s.select);
  const index = useApp((s) => s.index);
  const sorted = useMemo(() => [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)), [issues]);
  if (!issues.length) {
    return (
      <EmptyState icon={<Icon name="circle-check" size={24} className="text-success" />} title="No problems found" className="py-6">
        Every step has the settings it needs.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-border/60">
      {sorted.map((issue, i) => {
        const step = issue.step_id && flow ? findStep(flow, issue.step_id) : undefined;
        return (
          <li key={i}>
            <button
              type="button"
              onClick={() => issue.step_id && select(issue.step_id)}
              className="flex w-full items-start gap-2 px-4 py-1.5 text-left text-[13px] hover:bg-surface-2"
            >
              <Icon
                name={issue.severity === 'error' ? 'circle-x' : 'triangle-alert'}
                size={15}
                className={cn('mt-0.5 shrink-0', issue.severity === 'error' ? 'text-danger' : 'text-warning')}
              />
              <span className="flex-1">{issue.message}</span>
              {step && <span className="text-xs text-subtle">{step.label || index.get(step.activity)?.title}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function flowCredentialNames(flow: Flow): string[] {
  const names: string[] = [];
  const visit = (steps: Flow['steps']) => {
    for (const s of steps ?? []) {
      const c = s.params?.credential;
      if (typeof c === 'string' && c) names.push(c);
      for (const block of Object.values(s.blocks ?? {})) visit(block);
    }
  };
  visit(flow.steps);
  return names;
}

export { formatDuration };
