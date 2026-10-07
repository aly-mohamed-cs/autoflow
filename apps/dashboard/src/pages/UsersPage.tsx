import { Badge, Button, Dialog, Field, Icon, Input, Select } from '@autoflow/ui';
import { useState } from 'react';
import { useMe } from '../App';
import { Card, ErrorBox, Loading, PageHeader } from '../components/common';
import { api, useApi, type Role } from '../lib/api';
import { relative } from '../lib/format';

interface User {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  roleLabel: string;
  source: 'local' | 'ldap';
  disabled: boolean;
  lastLoginAt: string | null;
}

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer', description: 'Sees automations, runs and robots' },
  { value: 'operator', label: 'Operator', description: '+ runs automations, schedules, queues' },
  { value: 'builder', label: 'Builder', description: '+ publishes from Studio, manages credentials' },
  { value: 'admin', label: 'Administrator', description: '+ users, robots, settings' },
];

export function UsersPage() {
  const me = useMe();
  const { data, error, reload } = useApi<{ users: User[] }>('/api/users');
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Directory users appear here after their first sign-in; their role follows their Windows groups (Settings → Directory sign-in)."
        actions={<Button icon={<Icon name="plus" size={15} />} onClick={() => setAdding(true)}>Add local user</Button>}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? (
        !error && <Loading />
      ) : (
        <Card padded={false}>
          <table className="w-full text-[13px]">
            <thead className="border-b border-border bg-surface-2 text-left text-xs text-muted">
              <tr><th className="px-4 py-2">Name</th><th className="px-4 py-2">Sign-in</th><th className="px-4 py-2">Role</th><th className="px-4 py-2">Last sign-in</th><th className="px-4 py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.users.map((u) => (
                <tr key={u.id} className={u.disabled ? 'opacity-60' : ''}>
                  <td className="px-4 py-2">
                    <p className="font-medium">{u.displayName} {u.disabled && <Badge>disabled</Badge>}</p>
                    <p className="text-xs text-subtle">{u.username}{u.email ? ` · ${u.email}` : ''}</p>
                  </td>
                  <td className="px-4 py-2 text-muted">{u.source === 'ldap' ? 'Windows (directory)' : 'Local account'}</td>
                  <td className="px-4 py-2">
                    {u.source === 'ldap' ? (
                      <span title="Set by directory groups">{u.roleLabel}</span>
                    ) : (
                      <Select className="w-40" value={u.role} disabled={u.id === me.id} options={ROLE_OPTIONS} onChange={async (role) => { await api(`/api/users/${u.id}`, { method: 'PATCH', body: { role } }); reload(); }} />
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted">{relative(u.lastLoginAt)}</td>
                  <td className="px-4 py-2 text-right">
                    {u.source === 'local' && <Button size="sm" variant="ghost" onClick={() => setResetting(u)}>Reset password</Button>}
                    {u.id !== me.id && (
                      <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }); reload(); }}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <AddUserDialog open={adding} onClose={() => { setAdding(false); reload(); }} />
      <ResetDialog user={resetting} onClose={() => setResetting(null)} />
    </>
  );
}

function AddUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ username: '', displayName: '', role: 'viewer', password: '' });
  const [error, setError] = useState('');
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Add local user" description="For people without a Windows account in the company directory. Prefer directory sign-in where possible."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!form.username || !form.displayName || form.password.length < 10} onClick={async () => {
        try { await api('/api/users', { body: form }); setForm({ username: '', displayName: '', role: 'viewer', password: '' }); onClose(); } catch (e) { setError((e as Error).message); }
      }}>Add user</Button></>}>
      <div className="space-y-4">
        <Field label="Username" htmlFor="nu"><Input id="nu" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
        <Field label="Display name" htmlFor="nd"><Input id="nd" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
        <Field label="Role"><Select value={form.role} onChange={(role) => setForm({ ...form, role })} options={ROLE_OPTIONS} /></Field>
        <Field label="Password" htmlFor="np" help="At least 10 characters." error={error || undefined}><Input id="np" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function ResetDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const [password, setPassword] = useState('');
  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()} title={`New password for ${user?.displayName}`} description="They will be signed out everywhere."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={password.length < 10} onClick={async () => { await api(`/api/users/${user!.id}`, { method: 'PATCH', body: { password } }); setPassword(''); onClose(); }}>Set password</Button></>}>
      <Field label="New password" htmlFor="rp" help="At least 10 characters."><Input id="rp" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
    </Dialog>
  );
}
