import { Badge, Button, Dialog, Field, Icon, Input, Select, Textarea } from '@autoflow/ui';
import { useState } from 'react';
import { api, useApi } from '../lib/api';
import { dateTime, relative } from '../lib/format';
import { Card, ConfirmButton } from './common';

interface ApiKey {
  id: string;
  name: string;
  hint: string;
  role: 'viewer' | 'operator';
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revoked: boolean;
}

/** Keys other systems (ERP, scripts) use to start automations, add queue items or read runs. */
export function ApiKeys() {
  const { data, reload } = useApi<{ keys: ApiKey[] }>('/api/api-keys');
  const [form, setForm] = useState({ name: '', role: 'operator', days: '365' });
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState('');
  const origin = window.location.origin;
  return (
    <Card title="API keys">
      <div className="max-w-3xl space-y-4">
        <p className="text-[13px] text-muted">
          Other systems use an API key instead of signing in, e.g. to start an automation or add items to a queue. An <em>operator</em> key
          can start runs and add queue items; a <em>viewer</em> key can only read. Keys can never publish or change settings.
        </p>
        <ul className="divide-y divide-border rounded-md border border-border" aria-label="API keys">
          {(data?.keys ?? []).map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <Icon name="key-square" size={16} className={k.revoked ? 'text-subtle' : 'text-primary'} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  {k.name} <Badge>{k.role}</Badge>
                  {k.revoked && <Badge tone="danger">revoked</Badge>}
                  {!k.revoked && k.expiresAt && k.expiresAt < new Date().toISOString() && <Badge tone="warning">expired</Badge>}
                </p>
                <p className="text-xs text-subtle">
                  <span className="font-mono">{k.hint}</span> · used {relative(k.lastUsedAt)} · {k.expiresAt ? `valid until ${dateTime(k.expiresAt)}` : 'never expires'}
                </p>
              </div>
              {!k.revoked && (
                <ConfirmButton title={`Revoke “${k.name}”?`} description="Systems using it stop working at once." confirmLabel="Revoke" onConfirm={async () => { await api(`/api/api-keys/${k.id}`, { method: 'DELETE' }); reload(); }} icon={<Icon name="ban" size={14} />}>
                  Revoke
                </ConfirmButton>
              )}
            </li>
          ))}
          {!data?.keys.length && <li className="px-3 py-3 text-[13px] text-subtle">No API keys yet.</li>}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Name" htmlFor="kn">
            <Input id="kn" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. ERP" className="w-48" />
          </Field>
          <Field label="Can" htmlFor="kr">
            <Select id="kr" value={form.role} onChange={(role) => setForm({ ...form, role })} options={[{ value: 'operator', label: 'Start runs (operator)' }, { value: 'viewer', label: 'Only read (viewer)' }]} className="w-52" />
          </Field>
          <Field label="Valid for" htmlFor="kd">
            <Select id="kd" value={form.days} onChange={(days) => setForm({ ...form, days })} options={[{ value: '30', label: '30 days' }, { value: '365', label: '1 year' }, { value: 'never', label: 'Never expires' }]} className="w-40" />
          </Field>
          <Button
            icon={<Icon name="plus" size={14} />}
            disabled={!form.name.trim()}
            onClick={async () => {
              try {
                setError('');
                const r = await api<{ key: string }>('/api/api-keys', { body: { name: form.name, role: form.role, days: form.days === 'never' ? null : Number(form.days) } });
                setCreated(r.key);
                setForm({ ...form, name: '' });
                reload();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Create key
          </Button>
        </div>
        {error && <p className="text-[13px] text-danger" role="alert">{error}</p>}
      </div>
      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)} title="API key created" description="Copy it now — for security it is not shown again." width="lg" footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
        <div className="flex gap-2">
          <Input readOnly value={created ?? ''} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label="New API key" />
          <Button onClick={() => created && void navigator.clipboard.writeText(created)} icon={<Icon name="copy" size={14} />}>Copy</Button>
        </div>
        <p className="mt-3 text-xs text-muted">Start an automation (its id is in the dashboard address of the automation):</p>
        <pre className="mt-1 overflow-x-auto rounded bg-surface-2 p-2 text-xs">{`curl -X POST ${origin}/api/flows/<automation id>/run \\
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \\
  -d '{"inputs": {"customer": "Acme"}}'`}</pre>
      </Dialog>
    </Card>
  );
}

interface Notice {
  id: string;
  message: string;
  tone: 'info' | 'warning';
  until: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** Messages for everyone who uses Autoflow (dashboard and Studio), e.g. planned maintenance. */
export function Notices() {
  const { data, reload } = useApi<{ notices: Notice[] }>('/api/notices?all=1');
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState('info');
  const [until, setUntil] = useState('');
  const now = new Date().toISOString();
  return (
    <Card title="Notices">
      <div className="max-w-3xl space-y-4">
        <p className="text-[13px] text-muted">Shown at the top of the dashboard and in Studio until they expire, e.g. “Robots are updated tonight at 22:00.”</p>
        <ul className="divide-y divide-border rounded-md border border-border" aria-label="Notices">
          {(data?.notices ?? []).map((n) => {
            const active = !n.until || n.until > now;
            return (
              <li key={n.id} className="flex items-start gap-3 px-3 py-2 text-[13px]">
                <Icon name={n.tone === 'warning' ? 'triangle-alert' : 'megaphone'} size={16} className={n.tone === 'warning' ? 'mt-0.5 text-warning' : 'mt-0.5 text-primary'} />
                <div className="min-w-0 flex-1">
                  <p className={active ? '' : 'text-subtle line-through'}>{n.message}</p>
                  <p className="text-xs text-subtle">
                    {n.createdBy ?? '—'} · {relative(n.createdAt)} · {n.until ? `${active ? 'until' : 'ended'} ${dateTime(n.until)}` : 'until deleted'}
                  </p>
                </div>
                <ConfirmButton title="Delete this notice?" onConfirm={async () => { await api(`/api/notices/${n.id}`, { method: 'DELETE' }); reload(); }} icon={<Icon name="trash" size={14} />}>
                  <span className="sr-only">Delete</span>
                </ConfirmButton>
              </li>
            );
          })}
          {!data?.notices.length && <li className="px-3 py-3 text-[13px] text-subtle">No notices.</li>}
        </ul>
        <Field label="New notice" htmlFor="nm">
          <Textarea id="nm" value={message} onChange={(e) => setMessage(e.target.value)} rows={2} maxLength={1000} />
        </Field>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Kind" htmlFor="nt">
            <Select id="nt" value={tone} onChange={setTone} options={[{ value: 'info', label: 'Information' }, { value: 'warning', label: 'Warning' }]} className="w-40" />
          </Field>
          <Field label="Show until" htmlFor="nu" help="Empty: until you delete it.">
            <Input id="nu" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} className="w-56" />
          </Field>
          <Button
            icon={<Icon name="megaphone" size={14} />}
            disabled={!message.trim()}
            onClick={async () => {
              await api('/api/notices', { body: { message, tone, until: until ? new Date(until).toISOString() : null } });
              setMessage('');
              setUntil('');
              reload();
            }}
          >
            Publish notice
          </Button>
        </div>
      </div>
    </Card>
  );
}
