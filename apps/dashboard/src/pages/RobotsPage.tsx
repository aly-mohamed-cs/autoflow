import { Badge, Button, Dialog, EmptyState, Field, Icon, Input, Menu, Switch } from '@autoflow/ui';
import { useState } from 'react';
import { useMe } from '../App';
import { Card, ErrorBox, Loading, PageHeader } from '../components/common';
import { RobotScreen } from '../components/RobotScreen';
import { api, can, useApi, type Robot } from '../lib/api';
import { relative } from '../lib/format';
import { useLiveReload } from '../lib/live';
import { href } from '../lib/router';

export function RobotsPage() {
  const me = useMe();
  const { data, error, reload } = useApi<{ robots: Robot[]; latestVersion: string | null; automaticUpdates: boolean }>('/api/robots');
  const [updateMessage, setUpdateMessage] = useState('');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Robot | null>(null);
  const [watching, setWatching] = useState<Robot | null>(null);
  useLiveReload(reload, (e) => e.type === 'robot.updated' || e.type === 'job.updated');
  const admin = can(me.role, 'admin');

  return (
    <>
      <PageHeader
        title="Robots"
        subtitle="Computers that run automations unattended. Each robot connects to this server on its own."
        actions={admin && <Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={() => setAdding(true)}>Add robot</Button>}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && data.robots.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3 text-[13px] shadow-card">
          <span className="flex items-center gap-2">
            <Icon name="package" size={16} className="text-primary" />
            {data.latestVersion ? <>Newest robot version on this server: <strong>{data.latestVersion}</strong></> : 'No robot package on this server yet (update-server.ps1 -Installers copies it here).'}
          </span>
          <span className="flex-1" />
          {admin ? (
            <label htmlFor="auto-updates" className="flex cursor-pointer items-center gap-2.5">
              Update robots automatically
              <Switch
                id="auto-updates"
                checked={data.automaticUpdates}
                onChange={async (automatic) => {
                  await api('/api/settings/robot-updates', { method: 'PUT', body: { automatic } });
                  reload();
                }}
              />
            </label>
          ) : (
            <span className="text-muted">{data.automaticUpdates ? 'Robots update automatically' : 'Automatic robot updates are off'}</span>
          )}
        </div>
      )}
      {updateMessage && (
        <p className="mb-4 text-[13px] text-muted" role="status">
          {updateMessage}
        </p>
      )}
      {!data ? (
        !error && <Loading />
      ) : data.robots.length === 0 ? (
        <Card>
          <EmptyState icon={<Icon name="bot" size={30} />} title="No robots yet" action={admin && <Button variant="primary" onClick={() => setAdding(true)}>Add your first robot</Button>}>
            A robot is a Windows computer (or virtual machine) with Autoflow Robot installed, signed in with a dedicated robot account.
          </EmptyState>
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {data.robots.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                <span className={`flex h-9 w-9 items-center justify-center rounded-full ${r.online ? 'bg-success-soft text-success' : 'bg-surface-2 text-subtle'}`}>
                  <Icon name="bot" size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {r.name}
                    {!r.enabled && <Badge>disabled</Badge>}
                    {r.pool !== 'default' && <Badge tone="primary">{r.pool}</Badge>}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-subtle">
                    <span className="truncate">{r.machine || 'unknown computer'} · v{r.version || '?'}</span>
                    {r.updateAvailable && !r.updating && <Badge tone="primary">update to {data.latestVersion}</Badge>}
                  </p>
                  {r.updateError && (
                    <p className="mt-0.5 flex items-start gap-1 text-xs text-warning">
                      <Icon name="triangle-alert" size={13} className="mt-px shrink-0" /> {r.updateError}
                    </p>
                  )}
                </div>
                <div className="w-64 text-[13px]">
                  {r.updating ? (
                    <span className="flex items-center gap-1.5 text-primary">
                      <Icon name="loader" size={14} className="animate-spin" /> Updating to {r.updating}…
                    </span>
                  ) : r.online ? (
                    r.jobId ? (
                      <a href={href('runs', r.jobId)} className="flex items-center gap-1.5 text-primary">
                        <Icon name="loader" size={14} className="animate-spin" /> Running {r.jobFlowName}
                      </a>
                    ) : (
                      <span className="flex items-center gap-1.5 text-success"><Icon name="circle-check" size={14} /> Online, waiting for work</span>
                    )
                  ) : (
                    <span className="flex items-center gap-1.5 text-muted"><Icon name="circle-off" size={14} /> Offline · seen {relative(r.lastSeenAt)}</span>
                  )}
                </div>
                {can(me.role, 'operator') && r.online && (
                  <Button size="sm" variant="ghost" icon={<Icon name="monitor" size={14} />} onClick={() => setWatching(r)}>
                    Screen
                  </Button>
                )}
                {admin && (
                  <Menu
                    trigger={<Button variant="ghost" size="icon" aria-label={`Actions for ${r.name}`}><Icon name="ellipsis" size={16} /></Button>}
                    items={[
                      ...(r.updateAvailable && !r.updating
                        ? [
                            {
                              label: `Update now to ${data.latestVersion}`,
                              icon: <Icon name="download" size={14} />,
                              onSelect: async () => {
                                try {
                                  await api(`/api/robots/${r.id}/update`, { method: 'POST', body: {} });
                                  setUpdateMessage(`${r.name} installs version ${data.latestVersion} as soon as it isn't running anything.`);
                                } catch (e) {
                                  setUpdateMessage((e as Error).message);
                                }
                                reload();
                              },
                            },
                          ]
                        : []),
                      { label: 'Rename or change pool', icon: <Icon name="pencil" size={14} />, onSelect: () => setRenaming(r) },
                      {
                        label: r.enabled ? 'Disable' : 'Enable',
                        icon: <Icon name={r.enabled ? 'pause' : 'play'} size={14} />,
                        onSelect: async () => { await api(`/api/robots/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }); reload(); },
                      },
                      'separator',
                      { label: 'Remove', icon: <Icon name="trash" size={14} />, danger: true, onSelect: async () => { if (confirm(`Remove ${r.name}? It must be enrolled again to come back.`)) { await api(`/api/robots/${r.id}`, { method: 'DELETE' }); reload(); } } },
                    ]}
                  />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <AddRobotDialog open={adding} onClose={() => { setAdding(false); reload(); }} />
      <RenameDialog robot={renaming} onClose={() => { setRenaming(null); reload(); }} />
      <RobotScreen robot={watching} onClose={() => setWatching(null)} />
    </>
  );
}

function AddRobotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pool, setPool] = useState('default');
  const [key, setKey] = useState<{ key: string; expiresAt: string; serverUrl: string } | null>(null);
  const info = useApi<{ fingerprint: string | null; publicUrl: string }>(open ? '/api/server-info' : null, [open]);
  const create = async () => setKey(await api('/api/robots/enrollment-keys', { body: { pool, hours: 24 } }));
  const close = () => {
    setKey(null);
    onClose();
  };
  const command = key
    ? `autoflow-robot enroll --server ${key.serverUrl} --key ${key.key}${info.data?.fingerprint ? ' --trust-certificate' : ''}`
    : '';
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Add a robot" width="lg" footer={<Button variant="primary" onClick={close}>Done</Button>}>
      {!key ? (
        <div className="space-y-4">
          <ol className="list-decimal space-y-2 pl-5 text-[13px] text-muted">
            <li>On the robot computer, sign in with the Windows account the robot should use.</li>
            <li>Install <strong>Autoflow Robot</strong> (Settings → Downloads).</li>
            <li>Create a one-time key here and run the command it shows.</li>
          </ol>
          <Field label="Robot pool" help="Robots in a pool share work. Keep “default” unless you separate, for example, finance robots." htmlFor="pool">
            <Input id="pool" value={pool} onChange={(e) => setPool(e.target.value)} className="w-56" />
          </Field>
          <Button variant="primary" onClick={create} icon={<Icon name="key-round" size={15} />}>Create enrollment key</Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px]">Run this in PowerShell on the robot computer (the key works once, for 24 hours):</p>
          <div className="flex gap-2">
            <Input readOnly value={command} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button icon={<Icon name="copy" size={14} />} onClick={() => void navigator.clipboard.writeText(command)}>Copy</Button>
          </div>
          {info.data?.fingerprint && (
            <div className="rounded-md bg-warning-soft p-3 text-[13px]">
              <p className="font-medium text-warning">This server uses its own certificate.</p>
              <p className="mt-1 text-muted">Check that the robot shows the same fingerprint before trusting it:</p>
              <code className="mt-1 block font-mono text-[11px] break-all">{info.data.fingerprint}</code>
            </div>
          )}
          <p className="text-[13px] text-muted">
            Then run <code className="rounded bg-surface-2 px-1">install-robot.ps1</code> so the robot starts every time the robot account signs in.
            The robot appears in this list as soon as it connects.
          </p>
        </div>
      )}
    </Dialog>
  );
}

function RenameDialog({ robot, onClose }: { robot: Robot | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [pool, setPool] = useState('');
  const [last, setLast] = useState<Robot | null>(null);
  if (robot !== last) {
    setLast(robot);
    setName(robot?.name ?? '');
    setPool(robot?.pool ?? '');
  }
  return (
    <Dialog
      open={!!robot}
      onOpenChange={(o) => !o && onClose()}
      title="Robot settings"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={async () => { await api(`/api/robots/${robot!.id}`, { method: 'PATCH', body: { name, pool } }); onClose(); }}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="rn"><Input id="rn" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Pool" htmlFor="rp"><Input id="rp" value={pool} onChange={(e) => setPool(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}
