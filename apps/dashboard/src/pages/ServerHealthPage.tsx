import { Button, cn, Icon } from '@autoflow/ui';
import { Card, ErrorBox, Loading, PageHeader } from '../components/common';
import { useApi } from '../lib/api';
import { bytes, dateTime, relative } from '../lib/format';

interface Health {
  version: string;
  node: string;
  host: { name: string; os: string; cpus: number; uptimeS: number };
  startedAt: string;
  memory: { total: number; free: number; server: number };
  disk: { free: number; total: number } | null;
  database: { size: number };
  lastBackup: string | null;
  certificate: { validTo: string } | null;
  robots: { total: number; enabled: number; online: number };
  jobs: { queued: number; running: number; failed24h: number; finished24h: number };
  queueBacklog: number;
  checks: { name: string; status: 'ok' | 'warning' | 'problem'; message: string }[];
}

const STATUS = {
  ok: { icon: 'circle-check', className: 'text-success', label: 'OK' },
  warning: { icon: 'triangle-alert', className: 'text-warning', label: 'Needs attention' },
  problem: { icon: 'circle-x', className: 'text-danger', label: 'Problem' },
} as const;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="text-[13px] font-medium">{value}</dd>
    </div>
  );
}

export function ServerHealthPage() {
  const { data, error, reload, loading } = useApi<Health>('/api/server-health');
  return (
    <>
      <PageHeader
        title="Server health"
        subtitle="What to look at first when something seems wrong."
        actions={<Button icon={<Icon name="refresh-cw" size={14} />} onClick={reload} disabled={loading}>Check again</Button>}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? (
        !error && <Loading />
      ) : (
        <div className="space-y-6">
          <Card title="Checks" padded={false}>
            <ul className="divide-y divide-border" aria-label="Checks">
              {data.checks.map((c) => {
                const s = STATUS[c.status];
                return (
                  <li key={c.name} className="flex items-start gap-3 px-4 py-3">
                    <Icon name={s.icon} size={18} className={cn('mt-0.5 shrink-0', s.className)} aria-label={s.label} />
                    <div>
                      <p className="text-[13px] font-medium">{c.name}</p>
                      <p className="text-[13px] text-muted">{c.message}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
          <Card title="Server">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Autoflow version" value={data.version} />
              <Fact label="Computer" value={`${data.host.name} (${data.host.os})`} />
              <Fact label="Running since" value={`${dateTime(data.startedAt)} (${relative(data.startedAt)})`} />
              <Fact label="Node.js" value={data.node} />
              <Fact label="Memory free" value={`${bytes(data.memory.free)} of ${bytes(data.memory.total)} (server uses ${bytes(data.memory.server)})`} />
              <Fact label="Disk free" value={data.disk ? `${bytes(data.disk.free)} of ${bytes(data.disk.total)}` : 'unknown'} />
              <Fact label="Database" value={bytes(data.database.size)} />
              <Fact label="Newest backup" value={data.lastBackup ? relative(data.lastBackup) : 'none'} />
              <Fact label="Certificate valid until" value={data.certificate ? dateTime(data.certificate.validTo) : '—'} />
            </dl>
          </Card>
          <Card title="Work">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Robots online" value={`${data.robots.online} of ${data.robots.enabled}`} />
              <Fact label="Runs waiting / running" value={`${data.jobs.queued} / ${data.jobs.running}`} />
              <Fact label="Failed in 24 hours" value={`${data.jobs.failed24h} of ${data.jobs.finished24h}`} />
              <Fact label="Queue items waiting" value={String(data.queueBacklog)} />
            </dl>
          </Card>
        </div>
      )}
    </>
  );
}
