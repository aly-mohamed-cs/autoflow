import { Button, Dialog, EmptyState, Field, Icon, Input } from '@autoflow/ui';
import { useState } from 'react';
import { Card, ConfirmButton, ErrorBox, Loading, PageHeader } from '../components/common';
import { api, useApi } from '../lib/api';
import { relative } from '../lib/format';

interface Credential {
  name: string;
  username: string;
  description: string;
  updatedBy: string | null;
  updatedAt: string;
}

export function CredentialsPage() {
  const { data, error, reload } = useApi<{ credentials: Credential[] }>('/api/credentials');
  const [editing, setEditing] = useState<Credential | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="Credentials"
        subtitle="Logins robots use. Passwords are encrypted, never shown again, and given to a robot only while it runs an automation that needs them."
        actions={<Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={() => setEditing('new')}>Add credential</Button>}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? (
        !error && <Loading />
      ) : (
        <Card padded={false}>
          {data.credentials.length === 0 ? (
            <EmptyState icon={<Icon name="key-round" size={28} />} title="No credentials yet">
              Use the same name as in Studio's “Get credential” step, e.g. “Vendor portal”.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {data.credentials.map((c) => (
                <li key={c.name} className="flex items-center gap-3 px-4 py-3">
                  <Icon name="key-round" size={18} className="text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-subtle">{c.username || 'no username'}{c.description ? ` · ${c.description}` : ''} · updated {relative(c.updatedAt)} by {c.updatedBy ?? '—'}</p>
                  </div>
                  <Button size="sm" onClick={() => setEditing(c)}>Edit</Button>
                  <ConfirmButton title={`Delete “${c.name}”?`} description="Automations that use it will fail until it is added again." onConfirm={async () => { await api(`/api/credentials/${encodeURIComponent(c.name)}`, { method: 'DELETE' }); reload(); }} icon={<Icon name="trash" size={14} />}>
                    <span className="sr-only">Delete</span>
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <CredentialDialog value={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
    </>
  );
}

function CredentialDialog({ value, onClose, onSaved }: { value: Credential | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const isNew = value === 'new';
  const [form, setForm] = useState({ name: '', username: '', password: '', description: '' });
  const [last, setLast] = useState<typeof value>(null);
  const [error, setError] = useState('');
  if (value !== last) {
    setLast(value);
    setError('');
    setForm(value && value !== 'new' ? { name: value.name, username: value.username, password: '', description: value.description } : { name: '', username: '', password: '', description: '' });
  }
  return (
    <Dialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'Add credential' : `Edit “${form.name}”`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!form.name.trim() || (isNew && !form.password)}
            onClick={async () => {
              try {
                await api('/api/credentials', { method: 'PUT', body: { ...form, password: form.password || undefined } });
                onSaved();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <form className="space-y-4" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        <Field label="Name" htmlFor="cn" required><Input id="cn" disabled={!isNew} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Username" htmlFor="cu"><Input id="cu" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
        <Field label="Password" htmlFor="cp" required={isNew} help={isNew ? undefined : 'Leave empty to keep the current password.'} error={error || undefined}>
          <Input id="cp" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label="Description" htmlFor="cd"><Input id="cd" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Service account for the vendor portal" /></Field>
      </form>
    </Dialog>
  );
}
