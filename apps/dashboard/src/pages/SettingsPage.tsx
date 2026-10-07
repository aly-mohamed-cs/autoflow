import { Button, Field, Icon, Input, Segmented, Select, Switch, Textarea } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import { useMe } from '../App';
import { Card, PageHeader } from '../components/common';
import { api, can, useApi, type Role } from '../lib/api';
import { bytes, dateTime } from '../lib/format';

interface Ldap {
  enabled: boolean;
  url: string;
  domain: string;
  baseDn: string;
  startTls: boolean;
  allowInvalidCert: boolean;
  groupRoles: Record<Role, string[]>;
  defaultRole: Role | null;
}

export function SettingsPage() {
  const me = useMe();
  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <Appearance />
        <Downloads />
        {can(me.role, 'admin') && <Directory />}
      </div>
    </>
  );
}

function Appearance() {
  const [theme, setTheme] = useState(() => localStorage.getItem('autoflow.theme') ?? 'system');
  return (
    <Card title="Appearance">
      <Field label="Theme" inline>
        <Segmented
          value={theme}
          onChange={(t) => {
            setTheme(t);
            localStorage.setItem('autoflow.theme', t);
            window.dispatchEvent(new StorageEvent('storage'));
          }}
          options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'Same as Windows' }]}
        />
      </Field>
    </Card>
  );
}

function Downloads() {
  const { data } = useApi<{ files: { name: string; size: number; modified: string; url: string }[] }>('/api/downloads');
  return (
    <Card title="Downloads" padded={false}>
      {!data?.files.length ? (
        <p className="p-4 text-[13px] text-muted">No installers on this server yet. The administrator copies them here with <code>update-server.ps1</code>.</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.files.map((f) => (
            <li key={f.name} className="flex items-center gap-3 px-4 py-3">
              <Icon name={/robot/i.test(f.name) ? 'bot' : 'monitor'} size={18} className="text-primary" />
              <div className="flex-1">
                <p className="font-medium">{f.name}</p>
                <p className="text-xs text-subtle">{bytes(f.size)} · {dateTime(f.modified)}</p>
              </div>
              <a href={f.url} download>
                <Button size="sm" icon={<Icon name="download" size={14} />}>Download</Button>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const ROLE_ROWS: { role: Role; label: string; hint: string }[] = [
  { role: 'admin', label: 'Administrators', hint: 'e.g. RPA-Admins' },
  { role: 'builder', label: 'Builders', hint: 'e.g. RPA-Builders' },
  { role: 'operator', label: 'Operators', hint: 'e.g. RPA-Operators' },
  { role: 'viewer', label: 'Viewers', hint: 'e.g. RPA-Viewers' },
];

function Directory() {
  const { data, reload } = useApi<{ ldap: Ldap }>('/api/settings/ldap');
  const [form, setForm] = useState<Ldap | null>(null);
  const [saved, setSaved] = useState('');
  const [test, setTest] = useState({ username: '', password: '' });
  const [testResult, setTestResult] = useState<string>('');
  useEffect(() => {
    if (data) setForm(data.ldap);
  }, [data]);
  if (!form) return null;
  const set = (patch: Partial<Ldap>) => {
    setForm({ ...form, ...patch });
    setSaved('');
  };

  return (
    <Card title="Directory sign-in (Active Directory)" actions={<Switch checked={form.enabled} onChange={(enabled) => set({ enabled })} label="Use directory sign-in" />}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Server address" help="ldaps://dc01.company.local:636 is recommended." htmlFor="lu"><Input id="lu" value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="ldaps://dc01.company.local" /></Field>
        <Field label="Windows domain" help="People sign in as user@domain." htmlFor="ld"><Input id="ld" value={form.domain} onChange={(e) => set({ domain: e.target.value })} placeholder="company.local" /></Field>
        <Field label="Search base" htmlFor="lb" className="md:col-span-2"><Input id="lb" value={form.baseDn} onChange={(e) => set({ baseDn: e.target.value })} placeholder="DC=company,DC=local" /></Field>
        <Field label="Use StartTLS (for ldap:// addresses)" inline><Switch checked={form.startTls} onChange={(startTls) => set({ startTls })} /></Field>
        <Field label="Accept self-signed domain controller certificates" inline help="Only if IT confirms it's needed."><Switch checked={form.allowInvalidCert} onChange={(allowInvalidCert) => set({ allowInvalidCert })} /></Field>
      </div>
      <h3 className="mt-6 mb-2 text-[13px] font-semibold">Who gets which role</h3>
      <p className="mb-3 text-xs text-subtle">Windows group names (or full DNs), one per line. A person gets the highest role of any group they're in.</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {ROLE_ROWS.map((r) => (
          <Field key={r.role} label={r.label} htmlFor={`g-${r.role}`}>
            <Textarea id={`g-${r.role}`} rows={2} placeholder={r.hint} value={form.groupRoles[r.role].join('\n')}
              onChange={(e) => set({ groupRoles: { ...form.groupRoles, [r.role]: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) } })} />
          </Field>
        ))}
      </div>
      <Field label="Everyone else in the directory" className="mt-3 max-w-sm">
        <Select value={form.defaultRole ?? 'none'} onChange={(v) => set({ defaultRole: v === 'none' ? null : (v as Role) })}
          options={[{ value: 'none', label: 'No access' }, { value: 'viewer', label: 'Viewer' }, { value: 'operator', label: 'Operator' }]} />
      </Field>

      <div className="mt-6 rounded-md bg-surface-2 p-3">
        <p className="mb-2 text-[13px] font-medium">Test with a real account (settings above, not yet saved)</p>
        <div className="flex flex-wrap gap-2">
          <Input className="w-48" placeholder="username" value={test.username} onChange={(e) => setTest({ ...test, username: e.target.value })} aria-label="Test username" />
          <Input className="w-48" type="password" placeholder="password" value={test.password} onChange={(e) => setTest({ ...test, password: e.target.value })} aria-label="Test password" />
          <Button onClick={async () => {
            setTestResult('Testing…');
            const r = await api<{ ok: boolean; error?: string; user?: { displayName: string; role: Role | null; groups: string[] } }>('/api/settings/ldap/test', { body: { settings: form, ...test } });
            setTestResult(r.ok ? `Signed in as ${r.user!.displayName}. Role: ${r.user!.role ?? 'no access'}. Groups: ${r.user!.groups.map((g) => /^CN=([^,]+)/i.exec(g)?.[1] ?? g).join(', ') || 'none'}` : `Failed: ${r.error}`);
          }}>Test sign-in</Button>
        </div>
        {testResult && <p className="mt-2 text-[13px]">{testResult}</p>}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button variant="primary" onClick={async () => {
          try {
            await api('/api/settings/ldap', { method: 'PUT', body: form });
            setSaved('Saved.');
            reload();
          } catch (e) {
            setSaved((e as Error).message);
          }
        }}>Save directory settings</Button>
        {saved && <span className="text-[13px] text-muted">{saved}</span>}
      </div>
    </Card>
  );
}
