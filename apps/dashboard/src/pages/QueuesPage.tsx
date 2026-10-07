import { Badge, Button, Dialog, EmptyState, Field, Icon, Input, Select, Textarea } from '@autoflow/ui';
import { useState } from 'react';
import { useMe } from '../App';
import { Card, ConfirmButton, ErrorBox, Loading, PageHeader } from '../components/common';
import { api, can, useApi, type FlowSummary } from '../lib/api';
import { relative } from '../lib/format';
import { useLiveReload } from '../lib/live';
import { go, href } from '../lib/router';

interface Queue {
  id: string;
  name: string;
  description: string;
  flowId: string | null;
  flowName: string | null;
  maxRetries: number;
  enabled: boolean;
  counts: { new?: number; in_progress?: number; done?: number; failed?: number };
}

interface Item {
  id: string;
  reference: string;
  status: 'new' | 'in_progress' | 'done' | 'failed';
  data: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  jobId: string | null;
  updatedAt: string;
}

const ITEM_STATUS: Record<Item['status'], { label: string; tone: 'neutral' | 'primary' | 'success' | 'danger'; icon: string }> = {
  new: { label: 'Waiting', tone: 'neutral', icon: 'clock' },
  in_progress: { label: 'In progress', tone: 'primary', icon: 'loader' },
  done: { label: 'Done', tone: 'success', icon: 'circle-check' },
  failed: { label: 'Failed', tone: 'danger', icon: 'circle-x' },
};

export function QueuesPage() {
  const me = useMe();
  const { data, error, reload } = useApi<{ queues: Queue[] }>('/api/queues');
  const [creating, setCreating] = useState(false);
  useLiveReload(reload, (e) => e.type === 'queue.updated');
  return (
    <>
      <PageHeader
        title="Queues"
        subtitle="Lists of work items (for example invoices to process). Each item is handled by one run of the queue's automation, with automatic retries."
        actions={can(me.role, 'operator') && <Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={() => setCreating(true)}>New queue</Button>}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? (
        !error && <Loading />
      ) : data.queues.length === 0 ? (
        <Card>
          <EmptyState icon={<Icon name="inbox" size={28} />} title="No queues yet">
            Use a queue when work arrives as many separate items. In the automation, use the start value <code>queue_item</code>.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.queues.map((q) => (
            <a key={q.id} href={href('queues', q.id)} className="group rounded-lg border border-border bg-surface p-4 shadow-card hover:border-primary/50">
              <p className="font-semibold group-hover:text-primary">{q.name} {!q.enabled && <Badge>paused</Badge>}</p>
              <p className="text-[13px] text-muted">{q.flowName ? `Processed by “${q.flowName}”` : 'No automation chosen'}</p>
              <div className="mt-3 flex gap-4 text-[13px] tabular-nums">
                <span>{q.counts.new ?? 0} waiting</span>
                <span className="text-primary">{q.counts.in_progress ?? 0} in progress</span>
                <span className="text-success">{q.counts.done ?? 0} done</span>
                <span className={q.counts.failed ? 'text-danger' : ''}>{q.counts.failed ?? 0} failed</span>
              </div>
            </a>
          ))}
        </div>
      )}
      <QueueDialog open={creating} onClose={() => setCreating(false)} onSaved={(id) => go('queues', id)} />
    </>
  );
}

function QueueDialog({ open, onClose, onSaved, queue }: { open: boolean; onClose: () => void; onSaved: (id: string) => void; queue?: Queue }) {
  const flows = useApi<{ flows: FlowSummary[] }>(open ? '/api/flows' : null, [open]);
  const [form, setForm] = useState({ name: queue?.name ?? '', description: queue?.description ?? '', flowId: queue?.flowId ?? '', maxRetries: String(queue?.maxRetries ?? 2) });
  const [error, setError] = useState('');
  const save = async () => {
    const body = { name: form.name, description: form.description, flowId: form.flowId || null, maxRetries: Number(form.maxRetries), enabled: queue?.enabled ?? true };
    try {
      if (queue) {
        await api(`/api/queues/${queue.id}`, { method: 'PUT', body });
        onSaved(queue.id);
      } else {
        const r = await api<{ id: string }>('/api/queues', { body });
        onSaved(r.id);
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={queue ? 'Queue settings' : 'New queue'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={!form.name.trim()}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Name" htmlFor="qn"><Input id="qn" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Description" htmlFor="qd"><Input id="qd" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Automation that processes each item">
          <Select value={form.flowId} onChange={(flowId) => setForm({ ...form, flowId })} options={[{ value: '', label: 'Choose later' }, ...(flows.data?.flows ?? []).map((f) => ({ value: f.id, label: f.name }))]} />
        </Field>
        <Field label="Retries for failed items" inline>
          <Select className="w-28" value={form.maxRetries} onChange={(maxRetries) => setForm({ ...form, maxRetries })} options={['0', '1', '2', '3', '5'].map((v) => ({ value: v, label: v }))} />
        </Field>
        {error && <p className="text-[13px] text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

export function QueuePage({ id }: { id: string }) {
  const me = useMe();
  const queues = useApi<{ queues: Queue[] }>('/api/queues');
  const [status, setStatus] = useState('');
  const items = useApi<{ items: Item[] }>(`/api/queues/${id}/items${status ? `?status=${status}` : ''}`, [id, status]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  useLiveReload(() => { items.reload(); queues.reload(); }, (e) => e.type === 'queue.updated' && e.queueId === id);
  const queue = queues.data?.queues.find((q) => q.id === id);
  if (queues.error) return <ErrorBox error={queues.error} />;
  if (!queues.data) return <Loading />;
  if (!queue) return <ErrorBox error="This queue does not exist." />;
  const operator = can(me.role, 'operator');

  return (
    <>
      <PageHeader
        back={{ label: 'Queues', to: href('queues') }}
        title={queue.name}
        subtitle={queue.flowName ? `Each item starts “${queue.flowName}” with the item as start value queue_item.` : 'Choose an automation to start processing items.'}
        actions={operator && (
          <>
            {!!queue.counts.failed && <Button onClick={async () => { await api(`/api/queues/${id}/retry-failed`, { method: 'POST' }); items.reload(); }}>Retry failed</Button>}
            <Button onClick={() => setEditing(true)} icon={<Icon name="settings-2" size={14} />}>Settings</Button>
            <Button variant="primary" onClick={() => setAdding(true)} icon={<Icon name="plus" size={15} />}>Add items</Button>
            <ConfirmButton variant="secondary" size="md" title={`Delete queue “${queue.name}”?`} description="All its items are deleted too." onConfirm={async () => { await api(`/api/queues/${id}`, { method: 'DELETE' }); go('queues'); }}>Delete</ConfirmButton>
          </>
        )}
      />
      <div className="mb-3">
        <Select className="w-48" value={status} onChange={setStatus} options={[{ value: '', label: 'All items' }, ...Object.entries(ITEM_STATUS).map(([value, s]) => ({ value, label: s.label }))]} />
      </div>
      <Card padded={false}>
        {!items.data?.items.length ? (
          <EmptyState icon={<Icon name="inbox" size={26} />} title="No items">Add items by pasting a list or a CSV.</EmptyState>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="border-b border-border bg-surface-2 text-left text-xs text-muted">
              <tr><th className="px-4 py-2">Status</th><th className="px-4 py-2">Reference</th><th className="px-4 py-2">Data</th><th className="px-4 py-2">Tries</th><th className="px-4 py-2">Updated</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.data.items.map((it) => {
                const s = ITEM_STATUS[it.status];
                return (
                  <tr key={it.id}>
                    <td className="px-4 py-2"><Badge tone={s.tone}><Icon name={s.icon} size={12} />{s.label}</Badge></td>
                    <td className="px-4 py-2 font-medium">{it.reference || '—'}</td>
                    <td className="max-w-md px-4 py-2">
                      <span className="line-clamp-1 font-mono text-xs text-muted">{JSON.stringify(it.data)}</span>
                      {it.error && <span className="block text-xs text-danger">{it.error}</span>}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{it.attempts}</td>
                    <td className="px-4 py-2 text-muted">{it.jobId ? <a className="text-primary" href={href('runs', it.jobId)}>{relative(it.updatedAt)}</a> : relative(it.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <AddItemsDialog open={adding} queueId={id} onClose={() => { setAdding(false); items.reload(); }} />
      {editing && <QueueDialog open queue={queue} onClose={() => setEditing(false)} onSaved={() => queues.reload()} />}
    </>
  );
}

/** Paste CSV (with a header row) or one value per line. */
export function parseItems(text: string): { reference: string; data: Record<string, unknown> }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0]!.includes('\t') ? '\t' : lines[0]!.includes(';') && !lines[0]!.includes(',') ? ';' : ',';
  const split = (line: string) => line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  const header = split(lines[0]!);
  if (header.length === 1) return lines.map((l) => ({ reference: l.trim(), data: { value: l.trim() } }));
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const data = Object.fromEntries(header.map((h, i) => [h || `Column${i + 1}`, cells[i] ?? '']));
    return { reference: String(cells[0] ?? ''), data };
  });
}

function AddItemsDialog({ open, queueId, onClose }: { open: boolean; queueId: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const parsed = parseItems(text);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add items"
      description="Paste rows copied from Excel (with the column names in the first row), a CSV, or one value per line."
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!parsed.length} onClick={async () => {
            try {
              await api(`/api/queues/${queueId}/items`, { body: { items: parsed } });
              setText('');
              onClose();
            } catch (e) {
              setError((e as Error).message);
            }
          }}>
            Add {parsed.length || ''} item{parsed.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" placeholder={'Invoice No\tCustomer\tAmount\nINV-1\tAcme\t120'} aria-label="Items" />
      {parsed.length > 0 && <p className="mt-2 text-xs text-muted">First item: <code>{JSON.stringify(parsed[0]!.data)}</code></p>}
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
    </Dialog>
  );
}
