import { Button, Select } from '@autoflow/ui';
import { useState } from 'react';
import { Card, ErrorBox, Loading, PageHeader, RunsTable } from '../components/common';
import { useApi, type FlowSummary, type Job } from '../lib/api';
import { useLiveReload } from '../lib/live';

export function RunsPage() {
  const [status, setStatus] = useState('');
  const [flowId, setFlowId] = useState('');
  const [pages, setPages] = useState<Job[][]>([]);
  const query = new URLSearchParams({ limit: '50', ...(status ? { status } : {}), ...(flowId ? { flowId } : {}) }).toString();
  const { data, error, reload } = useApi<{ jobs: Job[] }>(`/api/jobs?${query}`);
  const flows = useApi<{ flows: FlowSummary[] }>('/api/flows');
  useLiveReload(() => {
    reload();
    setPages([]);
  }, (e) => e.type === 'job.updated');

  const all = [...(data?.jobs ?? []), ...pages.flat()];
  const loadMore = async () => {
    const last = all[all.length - 1];
    if (!last) return;
    const res = await fetch(`/api/jobs?${query}&before=${encodeURIComponent(last.queuedAt)}`, { credentials: 'same-origin' });
    const more = (await res.json()) as { jobs: Job[] };
    setPages((p) => [...p, more.jobs]);
  };

  return (
    <>
      <PageHeader title="Runs" subtitle="Every run of every automation, with its steps, logs and screenshots." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select
          className="w-48"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPages([]);
          }}
          options={[
            { value: '', label: 'Any status' },
            { value: 'running', label: 'Running' },
            { value: 'queued', label: 'Waiting' },
            { value: 'succeeded', label: 'Succeeded' },
            { value: 'failed', label: 'Failed' },
            { value: 'cancelled', label: 'Stopped' },
          ]}
        />
        <Select
          className="w-72"
          value={flowId}
          onChange={(v) => {
            setFlowId(v);
            setPages([]);
          }}
          options={[{ value: '', label: 'All automations' }, ...(flows.data?.flows ?? []).map((f) => ({ value: f.id, label: f.name }))]}
        />
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? (
        !error && <Loading />
      ) : (
        <Card padded={false}>
          <RunsTable jobs={all} />
          {all.length >= 50 && (pages.length === 0 || pages[pages.length - 1]!.length === 50) && (
            <div className="border-t border-border p-3 text-center">
              <Button size="sm" onClick={loadMore}>Load older runs</Button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
