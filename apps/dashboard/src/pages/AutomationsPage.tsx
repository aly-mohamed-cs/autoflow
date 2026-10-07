import { EmptyState, Icon, IconTile, Input } from '@autoflow/ui';
import { useMemo, useState } from 'react';
import { ErrorBox, Loading, PageHeader, StatusBadge } from '../components/common';
import { useApi, type FlowSummary } from '../lib/api';
import { relative } from '../lib/format';
import { useLiveReload } from '../lib/live';
import { href } from '../lib/router';

export function AutomationsPage() {
  const { data, error, reload } = useApi<{ flows: FlowSummary[] }>('/api/flows');
  const [query, setQuery] = useState('');
  useLiveReload(reload, (e) => e.type === 'job.updated');
  const flows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.flows ?? []).filter((f) => !q || f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q));
  }, [data, query]);

  return (
    <>
      <PageHeader
        title="Automations"
        subtitle="Published from Autoflow Studio. Run them now, schedule them, or connect them to other systems."
        actions={
          <div className="relative w-64">
            <Icon name="search" size={15} className="absolute top-2 left-2.5 text-subtle" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search automations" className="pl-8" />
          </div>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? (
        !error && <Loading />
      ) : data.flows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-surface">
          <EmptyState icon={<Icon name="workflow" size={30} />} title="No automations published yet">
            Build an automation in Autoflow Studio, test it, then press <strong>Publish</strong>. It appears here, ready to run on
            robots.
          </EmptyState>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {flows.map((f) => (
            <a key={f.id} href={href('automations', f.id)} className="group rounded-lg border border-border bg-surface p-4 shadow-card transition hover:border-primary/50 hover:shadow-pop">
              <div className="flex items-start gap-3">
                <IconTile name="workflow" category="Control" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold group-hover:text-primary">{f.name}</p>
                  <p className="line-clamp-2 min-h-[2.5em] text-[13px] text-muted">{f.description || 'No description'}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-subtle">
                <span>Version {f.latestVersion}</span>
                {!!f.activeSchedules && (
                  <span className="flex items-center gap-1">
                    <Icon name="calendar-clock" size={12} /> {f.activeSchedules} schedule{f.activeSchedules > 1 ? 's' : ''}
                  </span>
                )}
                <span className="flex-1" />
                {f.lastJob ? (
                  <span className="flex items-center gap-1.5">
                    {relative(f.lastJob.finishedAt ?? f.lastJob.queuedAt)} <StatusBadge status={f.lastJob.status} />
                  </span>
                ) : (
                  <span>Never run</span>
                )}
              </div>
            </a>
          ))}
          {flows.length === 0 && <p className="text-muted">Nothing matches “{query}”.</p>}
        </div>
      )}
    </>
  );
}
