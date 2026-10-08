import type { Flow } from '@autoflow/flow-types';
import { Badge, Button, cn, Dialog, EmptyState, Field, Icon, Input, Select, Switch, Tabs } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import { useMe } from '../App';
import { AiFixes } from '../components/AiFixes';
import { Card, ConfirmButton, ErrorBox, Loading, PageHeader, RunsTable } from '../components/common';
import { StepTree } from '../components/StepTree';
import { api, can, useApi, type AiFix, type FlowSummary, type InputVar, type Job, type Schedule } from '../lib/api';
import { dateTime, duration, percent, relative } from '../lib/format';
import { useLiveReload } from '../lib/live';
import { go, href } from '../lib/router';
import { DAY_NAMES, describe, EVERY_OPTIONS, fromCron, toCron, type Friendly } from '../lib/schedule';

interface Detail {
  flow: FlowSummary;
  versions: { version: number; notes: string; publishedBy: string | null; publishedAt: string }[];
  definition: Flow | null;
  inputs: InputVar[];
  credentials: string[];
  stats: { runs30d: number; succeeded30d: number; avgDurationMs: number | null };
  fixes: AiFix[];
}

export function AutomationPage({ id }: { id: string }) {
  const me = useMe();
  const detail = useApi<Detail>(`/api/flows/${encodeURIComponent(id)}`, [id]);
  const runs = useApi<{ jobs: Job[] }>(`/api/jobs?flowId=${encodeURIComponent(id)}&limit=25`, [id]);
  const [tab, setTab] = useState('runs');
  const [running, setRunning] = useState(false);
  useLiveReload(runs.reload, (e) => e.type === 'job.updated' && e.job.flowId === id);
  useLiveReload(detail.reload, (e) => e.type === 'repair.updated' && e.flowId === id);

  if (detail.error) return <ErrorBox error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Loading />;
  const { flow, stats } = detail.data;

  return (
    <>
      <PageHeader
        back={{ label: 'Automations', to: href('automations') }}
        title={flow.name}
        subtitle={flow.description || undefined}
        actions={
          can(me.role, 'operator') && (
            <Button variant="primary" icon={<Icon name="play" size={15} />} onClick={() => setRunning(true)}>
              Run now
            </Button>
          )
        }
      />
      <div className="mb-6 flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
        <span>Version {flow.latestVersion}</span>
        <span>{stats.runs30d} {stats.runs30d === 1 ? 'run' : 'runs'} in 30 days</span>
        <span>Success {percent(stats.runs30d ? stats.succeeded30d / stats.runs30d : null)}</span>
        <span>Typical run {duration(stats.avgDurationMs ? Math.round(stats.avgDurationMs) : null)}</span>
        {detail.data.credentials.length > 0 && <span>Uses credentials: {detail.data.credentials.join(', ')}</span>}
      </div>

      <AiFixes fixes={detail.data.fixes} flow={detail.data.definition} onDecided={detail.reload} />

      <Card padded={false}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'runs', label: 'Runs', content: <RunsTable jobs={runs.data?.jobs ?? []} showFlow={false} empty="Press Run now, or add a schedule." /> },
            { value: 'schedules', label: 'Schedules', content: <Schedules flowId={id} inputs={detail.data.inputs} /> },
            { value: 'webhooks', label: 'Webhooks', content: <Webhooks flowId={id} /> },
            { value: 'steps', label: 'Steps', content: detail.data.definition ? <div className="p-4"><StepTree flow={detail.data.definition} /></div> : null },
            { value: 'versions', label: 'Versions', content: <Versions versions={detail.data.versions} /> },
            { value: 'settings', label: 'Settings', content: <FlowSettings flow={flow} onSaved={detail.reload} /> },
          ]}
        />
      </Card>
      <RunDialog open={running} onClose={() => setRunning(false)} flowId={id} inputs={detail.data.inputs} />
    </>
  );
}

// -- run now -------------------------------------------------------------------------------

function InputsForm({ inputs, values, onChange }: { inputs: InputVar[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  if (!inputs.length) return <p className="text-[13px] text-muted">This automation has no start values.</p>;
  return (
    <div className="space-y-4">
      {inputs.map((v) => (
        <Field key={v.name} label={v.name} help={v.description || `${v.type === 'any' ? 'Value' : v.type}${v.default != null ? ` · default: ${String(v.default)}` : ''}`} htmlFor={`in-${v.name}`}>
          <Input
            id={`in-${v.name}`}
            type={v.sensitive ? 'password' : v.type === 'number' ? 'number' : 'text'}
            value={values[v.name] ?? ''}
            placeholder={v.default != null ? String(v.default) : ''}
            onChange={(e) => onChange({ ...values, [v.name]: e.target.value })}
          />
        </Field>
      ))}
      <p className="text-xs text-subtle">Files and folders must be reachable from the robot computer (e.g. a shared drive path).</p>
    </div>
  );
}

const cleanInputs = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));

function RunDialog({ open, onClose, flowId, inputs }: { open: boolean; onClose: () => void; flowId: string; inputs: InputVar[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValues({});
      setError('');
    }
  }, [open]);
  const start = async () => {
    setBusy(true);
    try {
      const { job } = await api<{ job: Job }>(`/api/flows/${encodeURIComponent(flowId)}/run`, { body: { inputs: cleanInputs(values) } });
      onClose();
      go('runs', job.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Run now"
      description="The next free robot picks it up. You can watch it live."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={start} icon={<Icon name="play" size={15} />}>
            Start
          </Button>
        </>
      }
    >
      <InputsForm inputs={inputs} values={values} onChange={setValues} />
      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
    </Dialog>
  );
}

// -- schedules -----------------------------------------------------------------------------

function Schedules({ flowId, inputs }: { flowId: string; inputs: InputVar[] }) {
  const me = useMe();
  const { data, reload } = useApi<{ schedules: Schedule[] }>(`/api/schedules?flowId=${encodeURIComponent(flowId)}`, [flowId]);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const edit = can(me.role, 'operator');
  return (
    <div>
      {!data?.schedules.length ? (
        <EmptyState
          icon={<Icon name="calendar-clock" size={26} />}
          title="No schedules"
          action={edit && <Button variant="primary" onClick={() => setEditing('new')}>Add a schedule</Button>}
        >
          Run this automation automatically, for example every weekday at 08:00.
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {data.schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Icon name="calendar-clock" size={18} className={s.enabled ? 'text-primary' : 'text-subtle'} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {s.name} {!s.enabled && <Badge>paused</Badge>}
                  </p>
                  <p className="text-[13px] text-muted">
                    {describe(fromCron(s.cron))} · {s.timezone}
                  </p>
                </div>
                <div className="text-right text-xs text-subtle">
                  <p>Next: {s.nextRunAt ? dateTime(s.nextRunAt, s.timezone) : '—'}</p>
                  <p>Last: {s.lastRunAt ? relative(s.lastRunAt) : 'never'}</p>
                </div>
                {edit && (
                  <>
                    <Button size="sm" onClick={() => setEditing(s)}>Edit</Button>
                    <ConfirmButton title={`Delete “${s.name}”?`} onConfirm={async () => { await api(`/api/schedules/${s.id}`, { method: 'DELETE' }); reload(); }} icon={<Icon name="trash" size={14} />}>
                      <span className="sr-only">Delete</span>
                    </ConfirmButton>
                  </>
                )}
              </li>
            ))}
          </ul>
          {edit && (
            <div className="border-t border-border p-3">
              <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setEditing('new')}>Add schedule</Button>
            </div>
          )}
        </>
      )}
      <ScheduleDialog
        value={editing}
        flowId={flowId}
        inputs={inputs}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </div>
  );
}

const KINDS: { value: Friendly['kind']; label: string }[] = [
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'On certain days of the week' },
  { value: 'monthly', label: 'Once a month' },
  { value: 'every', label: 'Every few minutes or hours' },
  { value: 'cron', label: 'Custom (cron, advanced)' },
];

function defaultFor(kind: Friendly['kind'], time = '08:00'): Friendly {
  switch (kind) {
    case 'weekly':
      return { kind, days: [1], time };
    case 'monthly':
      return { kind, day: 1, time };
    case 'every':
      return { kind, minutes: 30, from: '08:00', to: '18:00', weekdaysOnly: true };
    case 'cron':
      return { kind, cron: '0 8 * * 1-5' };
    default:
      return { kind, time };
  }
}

function ScheduleDialog({ value, flowId, inputs, onClose, onSaved }: { value: Schedule | 'new' | null; flowId: string; inputs: InputVar[]; onClose: () => void; onSaved: () => void }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState('');
  const [friendly, setFriendly] = useState<Friendly>(defaultFor('weekdays'));
  const [enabled, setEnabled] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!value) return;
    setError('');
    if (value === 'new') {
      setName('Every weekday morning');
      setFriendly(defaultFor('weekdays'));
      setEnabled(true);
      setValues({});
    } else {
      setName(value.name);
      setFriendly(fromCron(value.cron));
      setEnabled(value.enabled);
      setValues(Object.fromEntries(Object.entries(value.inputs).map(([k, v]) => [k, String(v)])));
    }
  }, [value]);

  const cron = toCron(friendly);
  const timezone = value && value !== 'new' ? value.timezone : tz;
  useEffect(() => {
    if (!value) return;
    const t = setTimeout(() => {
      api<{ next: string[] }>('/api/schedules/preview', { body: { cron, timezone } })
        .then((r) => {
          setPreview(r.next);
          setError('');
        })
        .catch((e) => {
          setPreview([]);
          setError((e as Error).message);
        });
    }, 300);
    return () => clearTimeout(t);
  }, [cron, timezone, value]);

  const save = async () => {
    const body = { flowId, name, cron, timezone, enabled, inputs: cleanInputs(values) };
    try {
      if (value === 'new') await api('/api/schedules', { body });
      else await api(`/api/schedules/${value!.id}`, { method: 'PUT', body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const timeInput = (t: string, set: (t: string) => void, label = 'At') => (
    <Field label={label} htmlFor="sched-time">
      <Input id="sched-time" type="time" value={t} onChange={(e) => set(e.target.value)} className="w-32" />
    </Field>
  );

  return (
    <Dialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      title={value === 'new' ? 'New schedule' : 'Edit schedule'}
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!name.trim() || !!error}>
            Save schedule
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="sched-name">
          <Input id="sched-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Run">
          <Select value={friendly.kind} onChange={(k) => setFriendly(defaultFor(k as Friendly['kind'], 'time' in friendly ? friendly.time : '08:00'))} options={KINDS} />
        </Field>
        <div className="flex flex-wrap items-end gap-4 rounded-md bg-surface-2 p-3">
          {(friendly.kind === 'daily' || friendly.kind === 'weekdays') && timeInput(friendly.time, (time) => setFriendly({ ...friendly, time }))}
          {friendly.kind === 'weekly' && (
            <>
              <Field label="On">
                <div className="flex flex-wrap gap-1">
                  {DAY_NAMES.map((d, i) => {
                    const on = friendly.days.includes(i);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setFriendly({ ...friendly, days: on ? friendly.days.filter((x) => x !== i) : [...friendly.days, i] })}
                        className={cn('h-8 w-12 rounded-md border text-[13px]', on ? 'border-primary bg-primary text-on-primary' : 'border-border bg-surface hover:border-border-strong')}
                      >
                        {d.slice(0, 3)}
                      </button>
                    );
                  })}
                </div>
              </Field>
              {timeInput(friendly.time, (time) => setFriendly({ ...friendly, time }))}
            </>
          )}
          {friendly.kind === 'monthly' && (
            <>
              <Field label="On day">
                <Select
                  className="w-40"
                  value={String(friendly.day)}
                  onChange={(d) => setFriendly({ ...friendly, day: d === 'last' ? 'last' : Number(d) })}
                  options={[...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })), { value: 'last', label: 'Last day' }]}
                />
              </Field>
              {timeInput(friendly.time, (time) => setFriendly({ ...friendly, time }))}
            </>
          )}
          {friendly.kind === 'every' && (
            <>
              <Field label="Every">
                <Select
                  className="w-36"
                  value={String(friendly.minutes)}
                  onChange={(m) => setFriendly({ ...friendly, minutes: Number(m) })}
                  options={EVERY_OPTIONS.map((m) => ({ value: String(m), label: m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours` }))}
                />
              </Field>
              {timeInput(friendly.from, (from) => setFriendly({ ...friendly, from }), 'From')}
              {timeInput(friendly.to, (to) => setFriendly({ ...friendly, to }), 'Until')}
              <Field label="Weekdays only" inline>
                <Switch checked={friendly.weekdaysOnly} onChange={(weekdaysOnly) => setFriendly({ ...friendly, weekdaysOnly })} />
              </Field>
            </>
          )}
          {friendly.kind === 'cron' && (
            <Field label="Cron expression" help="minute hour day-of-month month day-of-week" className="flex-1">
              <Input value={friendly.cron} onChange={(e) => setFriendly({ kind: 'cron', cron: e.target.value })} className="font-mono" />
            </Field>
          )}
        </div>
        <div className="text-[13px]">
          <p className="font-medium">{describe(friendly)} <span className="font-normal text-subtle">({timezone})</span></p>
          {error ? (
            <p className="text-danger">{error}</p>
          ) : (
            <p className="text-muted">Next runs: {preview.slice(0, 3).map((p) => dateTime(p, timezone)).join(' · ') || '—'}</p>
          )}
        </div>
        <Field label="Active" inline>
          <Switch checked={enabled} onChange={setEnabled} />
        </Field>
        {inputs.length > 0 && (
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-[13px] font-medium">Start values for scheduled runs</summary>
            <div className="mt-3">
              <InputsForm inputs={inputs} values={values} onChange={setValues} />
            </div>
          </details>
        )}
      </div>
    </Dialog>
  );
}

// -- webhooks, versions, settings --------------------------------------------------------------

function Webhooks({ flowId }: { flowId: string }) {
  const me = useMe();
  const allowed = can(me.role, 'operator');
  const { data, reload } = useApi<{ webhooks: { id: string; name: string; tokenHint: string; createdAt: string; lastCalledAt: string | null }[] }>(
    allowed ? `/api/webhooks?flowId=${encodeURIComponent(flowId)}` : null,
    [flowId],
  );
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  if (!allowed) return <p className="p-4 text-[13px] text-muted">Operators can connect other systems with webhooks.</p>;
  return (
    <div className="space-y-4 p-4">
      <p className="text-[13px] text-muted">
        A webhook is a secret web address. When another system sends a POST request to it (with JSON start values), this
        automation runs.
      </p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {(data?.webhooks ?? []).map((w) => (
          <li key={w.id} className="flex items-center gap-3 px-3 py-2">
            <Icon name="webhook" size={16} className="text-primary" />
            <span className="flex-1 text-[13px] font-medium">{w.name}</span>
            <span className="font-mono text-xs text-subtle">{w.tokenHint}</span>
            <span className="text-xs text-subtle">last called {relative(w.lastCalledAt)}</span>
            <ConfirmButton title={`Delete webhook “${w.name}”?`} description="Systems using this address will stop working." onConfirm={async () => { await api(`/api/webhooks/${w.id}`, { method: 'DELETE' }); reload(); }} icon={<Icon name="trash" size={14} />}>
              <span className="sr-only">Delete</span>
            </ConfirmButton>
          </li>
        ))}
        {!data?.webhooks.length && <li className="px-3 py-3 text-[13px] text-subtle">No webhooks yet.</li>}
      </ul>
      <div className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. ERP new order" className="max-w-xs" />
        <Button
          icon={<Icon name="plus" size={14} />}
          disabled={!name.trim()}
          onClick={async () => {
            const r = await api<{ url: string }>('/api/webhooks', { body: { flowId, name } });
            setCreated(r.url);
            setName('');
            reload();
          }}
        >
          Create webhook
        </Button>
      </div>
      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)} title="Webhook created" description="Copy this address now — for security it is not shown again." footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
        <div className="flex gap-2">
          <Input readOnly value={created ?? ''} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button onClick={() => created && void navigator.clipboard.writeText(created)} icon={<Icon name="copy" size={14} />}>Copy</Button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Example: <code className="rounded bg-surface-2 px-1">curl -X POST -H "Content-Type: application/json" -d '{'{'}"customer":"Acme"{'}'}' &lt;address&gt;</code>
        </p>
      </Dialog>
    </div>
  );
}

function Versions({ versions }: { versions: Detail['versions'] }) {
  return (
    <ul className="divide-y divide-border">
      {versions.map((v, i) => (
        <li key={v.version} className="flex items-start gap-3 px-4 py-3">
          <Badge tone={i === 0 ? 'primary' : 'neutral'}>v{v.version}</Badge>
          <div className="flex-1">
            <p className="text-[13px]">{v.notes || <span className="text-subtle">No release notes</span>}</p>
            <p className="text-xs text-subtle">Published by {v.publishedBy ?? 'unknown'} · {dateTime(v.publishedAt)}</p>
          </div>
          {i === 0 && <span className="text-xs text-success">in use</span>}
        </li>
      ))}
    </ul>
  );
}

function FlowSettings({ flow, onSaved }: { flow: FlowSummary; onSaved: () => void }) {
  const me = useMe();
  const [minutes, setMinutes] = useState(String(flow.minutesSaved));
  const builder = can(me.role, 'builder');
  const { data: ai } = useApi<{ enabled: boolean }>('/api/ai/status');
  return (
    <div className="max-w-lg space-y-5 p-4">
      {ai?.enabled && (
        <Field
          label="Let the AI assistant fix failed steps on robots"
          inline
          help="When a step fails, the assistant adjusts that step and tries it again (up to 3 times) without repeating earlier steps. A fix that works is offered here for a builder to keep; the automation never changes on its own."
        >
          <Switch
            checked={flow.aiRepair}
            disabled={!builder}
            onChange={async (aiRepair) => {
              await api(`/api/flows/${flow.id}`, { method: 'PATCH', body: { aiRepair } });
              onSaved();
            }}
          />
        </Field>
      )}
      <Field label="Minutes of manual work saved per run" help="Used for the “time saved” figure on the overview." htmlFor="mins">
        <div className="flex gap-2">
          <Input id="mins" type="number" min={0} value={minutes} disabled={!builder} onChange={(e) => setMinutes(e.target.value)} className="w-32" />
          {builder && (
            <Button onClick={async () => { await api(`/api/flows/${flow.id}`, { method: 'PATCH', body: { minutesSaved: Number(minutes) || 0 } }); onSaved(); }}>
              Save
            </Button>
          )}
        </div>
      </Field>
      {builder && (
        <div className="rounded-md border border-danger/30 p-4">
          <p className="font-medium">Archive this automation</p>
          <p className="mb-3 text-[13px] text-muted">It disappears from the list and can no longer be started. Run history is kept.</p>
          <ConfirmButton
            variant="secondary"
            title={`Archive “${flow.name}”?`}
            description="Schedules and webhooks stop starting it. Publishing it again from Studio brings it back."
            confirmLabel="Archive"
            onConfirm={async () => {
              await api(`/api/flows/${flow.id}`, { method: 'PATCH', body: { archived: true } });
              go('automations');
            }}
          >
            Archive
          </ConfirmButton>
        </div>
      )}
    </div>
  );
}
