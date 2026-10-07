import { Button, Dialog, EmptyState, Field, Icon, Input } from '@autoflow/ui';
import { useCallback, useEffect, useState } from 'react';
import type { CredentialSummary } from '../../../shared/api';
import { errorMessage, useApp } from '../store/app';
import { relativeTime } from './HomePage';

export function CredentialsPage() {
  const toast = useApp((s) => s.toast);
  const [items, setItems] = useState<CredentialSummary[]>([]);
  const [available, setAvailable] = useState(true);
  const [editing, setEditing] = useState<CredentialSummary | 'new' | null>(null);
  const [removing, setRemoving] = useState<CredentialSummary | null>(null);

  const refresh = useCallback(() => {
    void window.autoflow.vault.list().then(setItems);
    void window.autoflow.vault.available().then(setAvailable);
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <header className="flex items-start gap-3">
          <div className="flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Credentials</h1>
            <p className="mt-0.5 text-muted">
              Logins your automations use while you test them on this computer. Passwords are encrypted with your
              Windows account and are never shown again or written to logs.
            </p>
          </div>
          <Button variant="primary" icon={<Icon name="plus" size={16} />} onClick={() => setEditing('new')} disabled={!available}>
            Add credential
          </Button>
        </header>
        {!available && (
          <p className="mt-4 rounded-md bg-warning-soft p-3 text-warning">
            Secure storage is not available on this computer, so credentials can't be saved.
          </p>
        )}
        <p className="mt-4 rounded-md bg-primary-soft p-3 text-[13px] text-primary">
          <Icon name="info" size={14} className="mr-1.5 inline" />
          On robots, the same names are looked up in the Orchestrator's vault — so use the same credential name in both
          places.
        </p>
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-surface shadow-card">
          {items.length === 0 ? (
            <EmptyState icon={<Icon name="key-round" size={28} />} title="No credentials yet">
              Add one, then use the “Get credential” step to sign in to websites and applications.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((c) => (
                <li key={c.name} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-soft text-primary">
                    <Icon name="key-round" size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-subtle">
                      {c.username || 'no username'} · updated {relativeTime(c.updated)}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${c.name}`} onClick={() => setRemoving(c)}>
                    <Icon name="trash" size={15} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <CredentialDialog
        value={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
          toast('Credential saved', 'success');
        }}
      />
      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete “${removing?.name}”?`}
        description="Automations that use it will fail on this computer until you add it again."
        width="sm"
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await window.autoflow.vault.remove(removing!.name);
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
                setRemoving(null);
                refresh();
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

function CredentialDialog({
  value,
  onClose,
  onSaved,
}: {
  value: CredentialSummary | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = value === 'new';
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setName(value && value !== 'new' ? value.name : '');
    setUsername(value && value !== 'new' ? value.username : '');
    setPassword('');
    setError('');
  }, [value]);

  const save = async () => {
    try {
      await window.autoflow.vault.save({ name, username, password: password || undefined });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={value !== null}
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'Add credential' : `Edit “${name}”`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!name.trim() || (isNew && !password)}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" htmlFor="cred-name" required help="How steps refer to it, e.g. “Vendor portal”.">
          <Input id="cred-name" value={name} disabled={!isNew} onChange={(e) => setName(e.target.value)} autoFocus={isNew} />
        </Field>
        <Field label="Username" htmlFor="cred-user">
          <Input id="cred-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </Field>
        <Field
          label="Password"
          htmlFor="cred-pass"
          required={isNew}
          help={isNew ? undefined : 'Leave empty to keep the current password.'}
          error={error || undefined}
        >
          <Input id="cred-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
