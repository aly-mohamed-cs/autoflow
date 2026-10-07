import { Badge, Button, cn, Dialog, EmptyState, Icon, Spinner, Tooltip } from '@autoflow/ui';
import { useState, type ReactNode } from 'react';
import type { Job, JobStatus } from '../lib/api';
import { dateTime, duration, relative, TRIGGER_LABELS } from '../lib/format';
import { href } from '../lib/router';

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { label: string; to: string } }) {
  return (
    <header className="mb-6">
      {back && (
        <a href={back.to} className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted hover:text-primary">
          <Icon name="arrow-left" size={14} /> {back.label}
        </a>
      )}
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface shadow-card', className)}>
      {(title || actions) && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h2 className="flex-1 font-semibold">{title}</h2>
          {actions}
        </div>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

const STATUS: Record<JobStatus, { tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger'; icon: string; label: string }> = {
  queued: { tone: 'neutral', icon: 'clock', label: 'Waiting' },
  running: { tone: 'primary', icon: 'loader', label: 'Running' },
  succeeded: { tone: 'success', icon: 'circle-check', label: 'Succeeded' },
  failed: { tone: 'danger', icon: 'circle-x', label: 'Failed' },
  cancelled: { tone: 'warning', icon: 'circle-slash', label: 'Stopped' },
};

/** Status always shows icon + label, never color alone. */
export function StatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone}>
      <Icon name={s.icon} size={12} className={status === 'running' ? 'animate-spin' : undefined} />
      {s.label}
    </Badge>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-muted" role="status">
      <Spinner /> {what}…
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft p-4 text-[13px]">
      <Icon name="circle-alert" size={18} className="text-danger" />
      <p className="flex-1">{error}</p>
      {onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function RunsTable({ jobs, showFlow = true, empty }: { jobs: Job[]; showFlow?: boolean; empty?: ReactNode }) {
  if (!jobs.length) {
    return <EmptyState icon={<Icon name="list-video" size={26} />} title="No runs yet">{empty}</EmptyState>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead className="border-b border-border bg-surface-2 text-left text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Status</th>
            {showFlow && <th className="px-4 py-2 font-medium">Automation</th>}
            <th className="px-4 py-2 font-medium">Started by</th>
            <th className="px-4 py-2 font-medium">Robot</th>
            <th className="px-4 py-2 font-medium">When</th>
            <th className="px-4 py-2 text-right font-medium">Took</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {jobs.map((j) => (
            <tr key={j.id} className="group cursor-pointer hover:bg-surface-2" onClick={() => (window.location.hash = href('runs', j.id).slice(1))}>
              <td className="px-4 py-2">
                <a href={href('runs', j.id)} className="outline-none" onClick={(e) => e.stopPropagation()}>
                  <StatusBadge status={j.status} />
                </a>
              </td>
              {showFlow && <td className="max-w-64 truncate px-4 py-2 font-medium group-hover:text-primary">{j.flowName}</td>}
              <td className="px-4 py-2 text-muted">
                <Tooltip content={TRIGGER_LABELS[j.trigger]}>
                  <span className="truncate">{j.triggeredBy ?? TRIGGER_LABELS[j.trigger]}</span>
                </Tooltip>
              </td>
              <td className="px-4 py-2 text-muted">{j.robotName ?? '—'}</td>
              <td className="px-4 py-2 text-muted" title={dateTime(j.queuedAt)}>{relative(j.queuedAt)}</td>
              <td className="px-4 py-2 text-right text-muted tabular-nums">{duration(j.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A button that asks before doing something destructive. */
export function ConfirmButton({
  children,
  title,
  description,
  confirmLabel = 'Delete',
  onConfirm,
  variant = 'ghost',
  size = 'sm',
  icon,
}: {
  children: ReactNode;
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | void;
  variant?: 'ghost' | 'secondary' | 'danger';
  size?: 'sm' | 'md';
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} icon={icon} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        width="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      />
    </>
  );
}

export function Stat({ label, value, hint, icon, tone }: { label: string; value: ReactNode; hint?: ReactNode; icon: string; tone?: 'danger' | 'success' }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Icon name={icon} size={15} /> {label}
      </div>
      <p className={cn('mt-2 text-3xl font-semibold tracking-tight tabular-nums', tone === 'danger' && 'text-danger')}>{value}</p>
      {hint && <p className="mt-1 text-xs text-subtle">{hint}</p>}
    </div>
  );
}
