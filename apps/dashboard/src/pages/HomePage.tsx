import { Icon } from '@autoflow/ui';
import { useMe } from '../App';
import { Card, ErrorBox, Loading, PageHeader, RunsTable, Stat } from '../components/common';
import { RunsChart } from '../components/RunsChart';
import { useApi, type Job } from '../lib/api';
import { percent } from '../lib/format';
import { useLiveReload } from '../lib/live';
import { href } from '../lib/router';

interface Stats {
  today: { total: number; succeeded: number; failed: number; active: number };
  successRate7d: number | null;
  hoursSaved30d: number;
  daily: { day: string; succeeded: number; failed: number }[];
  robots: { total: number; online: number; busy: number };
}

export function HomePage() {
  const me = useMe();
  const stats = useApi<Stats>('/api/stats');
  const recent = useApi<{ jobs: Job[] }>('/api/jobs?limit=8');
  const failures = useApi<{ jobs: Job[] }>('/api/jobs?status=failed&limit=5');
  useLiveReload(() => {
    stats.reload();
    recent.reload();
    failures.reload();
  }, (e) => e.type === 'job.updated' || e.type === 'robot.updated');

  if (stats.error) return <ErrorBox error={stats.error} onRetry={stats.reload} />;
  if (!stats.data) return <Loading />;
  const s = stats.data;
  const firstName = me.displayName.split(' ')[0];

  return (
    <>
      <PageHeader title={`Hello, ${firstName}`} subtitle="Here's how your automations are doing." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon="play" label="Runs today" value={s.today.total} hint={s.today.active ? `${s.today.active} running or waiting` : 'none running now'} />
        <Stat icon="circle-check" label="Success rate (7 days)" value={percent(s.successRate7d)} hint="finished runs that succeeded" />
        <Stat icon="hourglass" label="Time saved (30 days)" value={`${s.hoursSaved30d} h`} hint="based on minutes saved per run" />
        <Stat icon="bot" label="Robots online" value={`${s.robots.online} / ${s.robots.total}`} hint={`${s.robots.busy} busy`} tone={s.robots.total > 0 && s.robots.online === 0 ? 'danger' : undefined} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Runs per day" className="xl:col-span-2">
          <RunsChart daily={s.daily} />
        </Card>
        <Card title="Needs attention" padded={false}>
          {failures.data?.jobs.length ? (
            <ul className="divide-y divide-border">
              {failures.data.jobs.map((j) => (
                <li key={j.id}>
                  <a href={href('runs', j.id)} className="flex gap-3 px-4 py-3 hover:bg-surface-2">
                    <Icon name="circle-x" size={16} className="mt-0.5 shrink-0 text-danger" />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{j.flowName}</span>
                      <span className="line-clamp-2 text-xs text-muted">{j.error?.message ?? 'Failed'}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 p-4 text-[13px] text-muted">
              <Icon name="circle-check" size={16} className="text-success" /> No failed runs. Nice.
            </p>
          )}
        </Card>
      </div>

      <Card title="Latest runs" className="mt-6" padded={false} actions={<a href={href('runs')} className="text-[13px] text-primary">See all</a>}>
        <RunsTable jobs={recent.data?.jobs ?? []} empty="Runs appear here once automations are published from Studio and started." />
      </Card>
    </>
  );
}
