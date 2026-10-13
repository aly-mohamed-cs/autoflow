import { Badge, Button, Dialog, Field, Icon, Input, Select, Switch } from '@autoflow/ui';
import { useState } from 'react';
import { useMe } from '../App';
import { api, can, useApi, type FlowSummary, type InputVar, type Robot } from '../lib/api';
import { relative } from '../lib/format';
import { ConfirmButton } from './common';

type Kind = 'file' | 'email';

interface FileConfig {
  folder: string;
  pattern: string;
  subfolders: boolean;
  intervalS: number;
}
interface EmailConfig {
  server: string;
  credential: string;
  mailbox: string;
  folder: string;
  subjectContains: string;
  fromContains: string;
  unreadOnly: boolean;
  intervalS: number;
}
export interface EventTrigger {
  id: string;
  flowId: string;
  name: string;
  kind: Kind;
  config: FileConfig & EmailConfig;
  pool: string;
  enabled: boolean;
  includeExisting: boolean;
  watcher: { id: string; name: string; online: boolean } | null;
  lastFiredAt: string | null;
  lastError: string | null;
  runs: number;
}

/** The start values each kind of trigger gives the run (the automation adds them in Studio). */
const START_VALUES: Record<Kind, string[]> = {
  file: ['trigger_file', 'trigger_file_name'],
  email: ['trigger_email'],
};

function summary(t: EventTrigger): string {
  if (t.kind === 'file') return `${t.config.pattern || '*'} in ${t.config.folder}${t.config.subfolders ? ' (and subfolders)' : ''}`;
  const filters = [t.config.subjectContains && `subject has “${t.config.subjectContains}”`, t.config.fromContains && `from “${t.config.fromContains}”`].filter(Boolean);
  return `${t.config.unreadOnly ? 'Unread emails' : 'Emails'} in ${t.config.mailbox || t.config.credential}/${t.config.folder || 'Inbox'}${filters.length ? `, ${filters.join(', ')}` : ''}`;
}

export function EventTriggers({ flowId, inputs }: { flowId: string; inputs: InputVar[] }) {
  const me = useMe();
  const builder = can(me.role, 'builder');
  const { data, reload } = useApi<{ triggers: EventTrigger[] }>(can(me.role, 'operator') ? `/api/event-triggers?flowId=${encodeURIComponent(flowId)}` : null, [flowId]);
  const [editing, setEditing] = useState<EventTrigger | Kind | null>(null);
  if (!can(me.role, 'operator')) return <p className="p-4 text-[13px] text-muted">Operators can see the event triggers of this automation.</p>;
  const declared = new Set(inputs.map((i) => i.name));
  const triggers = data?.triggers ?? [];

  const save = async (t: EventTrigger, patch: Partial<EventTrigger>) => {
    const next = { ...t, ...patch };
    await api(`/api/event-triggers/${t.id}`, {
      method: 'PUT',
      body: { kind: next.kind, flowId, name: next.name, pool: next.pool, enabled: next.enabled, includeExisting: next.includeExisting, config: next.config },
    });
    reload();
  };

  return (
    <div className="space-y-4 p-4">
      <p className="text-[13px] text-muted">
        Start this automation when a new file appears in a folder or a new email arrives. A robot of the chosen pool watches the folder or
        mailbox, so it must be able to open it.
      </p>
      <ul className="divide-y divide-border rounded-md border border-border" aria-label="Event triggers">
        {triggers.map((t) => {
          // Any one of them is enough to use the file / email in the steps.
          const missing = START_VALUES[t.kind].some((n) => declared.has(n)) ? [] : START_VALUES[t.kind];
          return (
            <li key={t.id} className="flex items-start gap-3 px-3 py-3">
              <Icon name={t.kind === 'file' ? 'folder-search' : 'mail-search'} size={18} className="mt-0.5 text-primary" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                  {t.name}
                  {!t.enabled ? (
                    <Badge>Off</Badge>
                  ) : t.watcher?.online ? (
                    <Badge tone="success">Watched by {t.watcher.name}</Badge>
                  ) : (
                    <Badge tone="warning">No robot of pool “{t.pool}” is online to watch</Badge>
                  )}
                </p>
                <p className="truncate text-xs text-muted">{summary(t)}</p>
                <p className="text-xs text-subtle">
                  {t.runs} {t.runs === 1 ? 'run' : 'runs'} started{t.lastFiredAt ? `, last ${relative(t.lastFiredAt)}` : ''} · checks every {t.config.intervalS} s
                </p>
                {t.lastError && (
                  <p className="flex items-start gap-1 text-xs text-danger" role="alert">
                    <Icon name="triangle-alert" size={13} className="mt-px shrink-0" /> {t.lastError}
                  </p>
                )}
                {missing.length > 0 && (
                  <p className="text-xs text-warning">
                    To use the {t.kind === 'file' ? 'file' : 'email'} in the steps, add the start value{' '}
                    {missing.map((n, i) => (
                      <span key={n}>
                        {i > 0 && ' or '}
                        <code className="rounded bg-surface-2 px-1">{n}</code>
                      </span>
                    ))}{' '}
                    to the automation in Studio.
                  </p>
                )}
              </div>
              {builder && (
                <div className="flex items-center gap-2">
                  <Switch label={`${t.name} on`} checked={t.enabled} onChange={(enabled) => void save(t, { enabled })} />
                  <Button size="sm" onClick={() => setEditing(t)}>Edit</Button>
                  <ConfirmButton title={`Delete trigger “${t.name}”?`} onConfirm={async () => { await api(`/api/event-triggers/${t.id}`, { method: 'DELETE' }); reload(); }} icon={<Icon name="trash" size={14} />}>
                    <span className="sr-only">Delete</span>
                  </ConfirmButton>
                </div>
              )}
            </li>
          );
        })}
        {!triggers.length && <li className="px-3 py-3 text-[13px] text-subtle">No event triggers yet.</li>}
      </ul>
      {builder ? (
        <div className="flex flex-wrap gap-2">
          <Button icon={<Icon name="folder-search" size={14} />} onClick={() => setEditing('file')}>When a file appears</Button>
          <Button icon={<Icon name="mail-search" size={14} />} onClick={() => setEditing('email')}>When an email arrives</Button>
        </div>
      ) : (
        <p className="text-xs text-subtle">Builders add event triggers.</p>
      )}
      <TriggerDialog value={editing} flowId={flowId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
    </div>
  );
}

const FILE_DEFAULTS: FileConfig = { folder: '', pattern: '*', subfolders: false, intervalS: 30 };
const EMAIL_DEFAULTS: EmailConfig = { server: '', credential: '', mailbox: '', folder: 'Inbox', subjectContains: '', fromContains: '', unreadOnly: true, intervalS: 60 };

function TriggerDialog({ value, flowId, onClose, onSaved }: { value: EventTrigger | Kind | null; flowId: string; onClose: () => void; onSaved: () => void }) {
  const kind: Kind = typeof value === 'string' ? value : (value?.kind ?? 'file');
  const existing = value && typeof value === 'object' ? value : null;
  const [form, setForm] = useState({ name: '', pool: 'default', includeExisting: false, file: FILE_DEFAULTS, email: EMAIL_DEFAULTS });
  const [last, setLast] = useState<typeof value>(null);
  const [error, setError] = useState('');
  const robots = useApi<{ robots: Robot[] }>(value ? '/api/robots' : null, [!!value]);
  const credentials = useApi<{ credentials: { name: string }[] }>(value && kind === 'email' ? '/api/credentials' : null, [value, kind]);
  if (value !== last) {
    setLast(value);
    setError('');
    setForm({
      name: existing?.name ?? (kind === 'file' ? 'New file' : 'New email'),
      pool: existing?.pool ?? 'default',
      includeExisting: existing?.includeExisting ?? false,
      file: existing?.kind === 'file' ? { ...FILE_DEFAULTS, ...existing.config } : FILE_DEFAULTS,
      email: existing?.kind === 'email' ? { ...EMAIL_DEFAULTS, ...existing.config } : EMAIL_DEFAULTS,
    });
  }
  const pools = [...new Set(['default', form.pool, ...(robots.data?.robots ?? []).map((r) => r.pool)])].map((p) => ({ value: p, label: p }));
  const file = form.file;
  const email = form.email;
  const setFile = (patch: Partial<FileConfig>) => setForm({ ...form, file: { ...file, ...patch } });
  const setEmail = (patch: Partial<EmailConfig>) => setForm({ ...form, email: { ...email, ...patch } });
  const ready = form.name.trim() && (kind === 'file' ? file.folder.trim() : email.server.trim() && email.credential);

  const save = async () => {
    try {
      const body = { kind, flowId, name: form.name, pool: form.pool, enabled: existing?.enabled ?? true, includeExisting: form.includeExisting, config: kind === 'file' ? file : email };
      if (existing) await api(`/api/event-triggers/${existing.id}`, { method: 'PUT', body });
      else await api('/api/event-triggers', { body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      title={kind === 'file' ? 'When a file appears in a folder' : 'When an email arrives'}
      description={
        kind === 'file'
          ? 'Each new file starts one run, once the file is complete. The run gets trigger_file (the full path) and trigger_file_name.'
          : 'Each new email starts one run. The run gets trigger_email (id, from, subject, received, text, attachments); "Read emails" with "Only this message" opens it, e.g. to save its attachments.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
        <Field label="Name" htmlFor="tn" required>
          <Input id="tn" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        {kind === 'file' ? (
          <>
            <Field label="Folder" htmlFor="tf" required help="As the robot sees it, e.g. \\fileserver\scans\invoices or D:\Incoming.">
              <Input id="tf" value={file.folder} onChange={(e) => setFile({ folder: e.target.value })} />
            </Field>
            <Field label="Only files named" htmlFor="tp" help="e.g. *.pdf or invoice-*.xlsx">
              <Input id="tp" value={file.pattern} onChange={(e) => setFile({ pattern: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch label="Also look in subfolders" checked={file.subfolders} onChange={(subfolders) => setFile({ subfolders })} /> Also look in subfolders
            </label>
          </>
        ) : (
          <>
            <Field label="Exchange server" htmlFor="ts" required>
              <Input id="ts" value={email.server} onChange={(e) => setEmail({ server: e.target.value })} placeholder="mail.company.local" />
            </Field>
            <Field label="Mailbox credential" htmlFor="tc" required help="Saved under Credentials.">
              <Select id="tc" value={email.credential} onChange={(credential) => setEmail({ credential })} options={(credentials.data?.credentials ?? []).map((c) => ({ value: c.name, label: c.name }))} placeholder="Choose a credential" />
            </Field>
            <Field label="Mailbox address" htmlFor="tm" help="Leave empty for the credential's own mailbox.">
              <Input id="tm" value={email.mailbox} onChange={(e) => setEmail({ mailbox: e.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Mail folder" htmlFor="tmf">
                <Input id="tmf" value={email.folder} onChange={(e) => setEmail({ folder: e.target.value })} placeholder="Inbox or Inbox/Invoices" />
              </Field>
              <Field label="Subject contains" htmlFor="tsc">
                <Input id="tsc" value={email.subjectContains} onChange={(e) => setEmail({ subjectContains: e.target.value })} />
              </Field>
              <Field label="From contains" htmlFor="tfc">
                <Input id="tfc" value={email.fromContains} onChange={(e) => setEmail({ fromContains: e.target.value })} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch checked={email.unreadOnly} onChange={(unreadOnly) => setEmail({ unreadOnly })} label="Only unread emails" /> Only unread emails
            </label>
          </>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Watched by a robot of pool" htmlFor="tpool">
            <Select id="tpool" value={form.pool} onChange={(pool) => setForm({ ...form, pool })} options={pools} />
          </Field>
          <Field label="Check every (seconds)" htmlFor="ti">
            <Input
              id="ti"
              type="number"
              min={kind === 'file' ? 10 : 30}
              value={kind === 'file' ? file.intervalS : email.intervalS}
              onChange={(e) => (kind === 'file' ? setFile({ intervalS: Number(e.target.value) }) : setEmail({ intervalS: Number(e.target.value) }))}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <Switch checked={form.includeExisting} onChange={(includeExisting) => setForm({ ...form, includeExisting })} label="Also start runs for what is already there" />
          Also start runs for {kind === 'file' ? 'files' : 'emails'} that are already there
        </label>
        {error && <p className="text-[13px] text-danger" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

// -- "then start" (chained automations) ----------------------------------------------------------

interface Chains {
  next: { id: string; runWhen: 'succeeded' | 'failed' | 'finished'; nextFlowId: string; nextFlowName: string; passOutputs: boolean; enabled: boolean }[];
  startedBy: { id: string; runWhen: string; flowId: string; flowName: string }[];
}

const WHEN = [
  { value: 'succeeded', label: 'succeeds' },
  { value: 'failed', label: 'fails' },
  { value: 'finished', label: 'finishes (either way)' },
];

export function FollowUps({ flowId }: { flowId: string }) {
  const me = useMe();
  const allowed = can(me.role, 'operator');
  const { data, reload } = useApi<Chains>(`/api/flows/${encodeURIComponent(flowId)}/chains`, [flowId]);
  const flows = useApi<{ flows: FlowSummary[] }>(allowed ? '/api/flows' : null);
  const [when, setWhen] = useState('succeeded');
  const [next, setNext] = useState('');
  const [pass, setPass] = useState(true);
  const [error, setError] = useState('');
  const others = (flows.data?.flows ?? []).filter((f) => !f.archived && f.id !== flowId);
  const label = (w: string) => WHEN.find((x) => x.value === w)?.label ?? w;

  return (
    <div className="space-y-4 p-4">
      <p className="text-[13px] text-muted">
        Start another automation after this one, e.g. “Send the report” when “Download the report” succeeds, or “Tell IT” when it fails. With
        “hand over results”, its results become start values of the next one (same names); <code className="rounded bg-surface-2 px-1">previous_run</code>{' '}
        tells it how this run went.
      </p>
      <ul className="divide-y divide-border rounded-md border border-border" aria-label="Then start">
        {(data?.next ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
            <Icon name="arrow-right" size={16} className="text-primary" />
            <span className="flex-1">
              When it {label(c.runWhen)}, start <a className="font-medium text-primary hover:underline" href={`#/automations/${encodeURIComponent(c.nextFlowId)}`}>{c.nextFlowName}</a>
              {c.passOutputs && <span className="text-subtle"> · hands over its results</span>}
            </span>
            {allowed && (
              <>
                <Switch label={`Start ${c.nextFlowName}`} checked={c.enabled} onChange={async (enabled) => { await api(`/api/chains/${c.id}`, { method: 'PATCH', body: { enabled } }); reload(); }} />
                <ConfirmButton title={`Stop starting “${c.nextFlowName}”?`} onConfirm={async () => { await api(`/api/chains/${c.id}`, { method: 'DELETE' }); reload(); }} icon={<Icon name="trash" size={14} />}>
                  <span className="sr-only">Delete</span>
                </ConfirmButton>
              </>
            )}
          </li>
        ))}
        {!data?.next.length && <li className="px-3 py-3 text-[13px] text-subtle">Nothing starts after this automation.</li>}
      </ul>
      {allowed && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span>When it</span>
          <Select aria-label="When" value={when} onChange={setWhen} options={WHEN} className="w-48" />
          <span>start</span>
          <Select aria-label="Next automation" value={next} onChange={setNext} options={others.map((f) => ({ value: f.id, label: f.name }))} placeholder="Choose an automation" className="w-64" />
          <label className="flex items-center gap-2">
            <Switch checked={pass} onChange={setPass} label="Hand over results" /> hand over results
          </label>
          <Button
            icon={<Icon name="plus" size={14} />}
            disabled={!next}
            onClick={async () => {
              try {
                setError('');
                await api(`/api/flows/${encodeURIComponent(flowId)}/chains`, { body: { runWhen: when, nextFlowId: next, passOutputs: pass } });
                setNext('');
                reload();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Add
          </Button>
          {error && <span className="text-danger" role="alert">{error}</span>}
        </div>
      )}
      {!!data?.startedBy.length && (
        <p className="text-xs text-subtle">
          Started after: {data.startedBy.map((s) => `${s.flowName} (when it ${label(s.runWhen)})`).join(', ')}
        </p>
      )}
    </div>
  );
}
