import { Button } from '@autoflow/ui';
import { useState } from 'react';
import { Card, ErrorBox, Loading, PageHeader } from '../components/common';
import { api, useApi } from '../lib/api';
import { dateTime } from '../lib/format';

interface Entry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

const LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.failed': 'Failed sign-in',
  'auth.denied': 'Sign-in denied (no group)',
  'flow.published': 'Published an automation',
  'flow.updated': 'Changed an automation',
  'job.started': 'Started a run',
  'job.cancelled': 'Stopped a run',
  'credential.created': 'Added a credential',
  'credential.updated': 'Changed a credential',
  'credential.deleted': 'Deleted a credential',
  'credentials.read': 'Robot read credentials',
  'robot.enrolled': 'Robot enrolled',
  'robot.key_created': 'Created a robot key',
  'robot.updated': 'Changed a robot',
  'robot.removed': 'Removed a robot',
  'schedule.created': 'Added a schedule',
  'schedule.updated': 'Changed a schedule',
  'schedule.deleted': 'Deleted a schedule',
  'webhook.created': 'Added a webhook',
  'webhook.deleted': 'Deleted a webhook',
  'queue.created': 'Added a queue',
  'queue.deleted': 'Deleted a queue',
  'queue.items_added': 'Added queue items',
  'user.created': 'Added a user',
  'user.updated': 'Changed a user',
  'settings.ldap_updated': 'Changed directory sign-in',
  'setup.admin_created': 'Set up Autoflow',
};

export function AuditPage() {
  const { data, error, reload } = useApi<{ entries: Entry[] }>('/api/audit');
  const [older, setOlder] = useState<Entry[]>([]);
  const all = [...(data?.entries ?? []), ...older];
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader title="Audit log" subtitle="Who did what, and when. Kept for compliance; it can't be edited." />
      <Card padded={false}>
        <table className="w-full text-[13px]">
          <thead className="border-b border-border bg-surface-2 text-left text-xs text-muted">
            <tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Who</th><th className="px-4 py-2">What</th><th className="px-4 py-2">Details</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {all.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2 whitespace-nowrap text-muted">{dateTime(e.ts)}</td>
                <td className="px-4 py-2">{e.actor}</td>
                <td className="px-4 py-2">{LABELS[e.action] ?? e.action}</td>
                <td className="max-w-md truncate px-4 py-2 font-mono text-xs text-muted">
                  {[e.target, ...Object.entries(e.details).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)].filter(Boolean).join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {all.length >= 200 && (
          <div className="border-t border-border p-3 text-center">
            <Button size="sm" onClick={async () => {
              const r = await api<{ entries: Entry[] }>(`/api/audit?before=${all[all.length - 1]!.id}`);
              setOlder((o) => [...o, ...r.entries]);
            }}>Load older</Button>
          </div>
        )}
      </Card>
    </>
  );
}
