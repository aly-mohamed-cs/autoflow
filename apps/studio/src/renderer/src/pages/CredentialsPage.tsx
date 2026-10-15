import { Button, Dialog, EmptyState, Icon } from '@autoflow/ui';
import { useCallback, useEffect, useState } from 'react';
import type { CredentialSummary } from '../../../shared/api';
import { CredentialDialog } from '../components/CredentialDialog';
import { errorMessage, useApp } from '../store/app';
import { relativeTime } from './HomePage';

export function CredentialsPage() {
  const toast = useApp((s) => s.toast);
  const connected = useApp((s) => !!s.orchestrator);
  const [items, setItems] = useState<CredentialSummary[]>([]);
  const [remote, setRemote] = useState<{ name: string; username: string }[]>([]);
  const [available, setAvailable] = useState(true);
  const [editing, setEditing] = useState<CredentialSummary | 'new' | null>(null);
  const [preset, setPreset] = useState<{ name: string; username: string } | undefined>();
  const [removing, setRemoving] = useState<CredentialSummary | null>(null);

  const refresh = useCallback(() => {
    void window.autoflow.vault.list().then(setItems);
    void window.autoflow.vault.available().then(setAvailable);
    void window.autoflow.orchestrator.credentials().then(setRemote);
  }, []);
  useEffect(refresh, [refresh, connected]);

  const local = new Set(items.map((c) => c.name.toLowerCase()));
  const missing = remote.filter((r) => !local.has(r.name.toLowerCase()));
  const add = (from?: { name: string; username: string }) => {
    setPreset(from);
    setEditing('new');
  };

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
          <Button variant="primary" icon={<Icon name="plus" size={16} />} onClick={() => add()} disabled={!available}>
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
          places. The Orchestrator never sends its passwords to this PC: add them here to test.
        </p>
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-surface shadow-card">
          {items.length === 0 ? (
            <EmptyState icon={<Icon name="key-round" size={28} />} title="No credentials on this PC yet">
              Add one, then use the “Get credential” step to sign in to websites and applications.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border" aria-label="Credentials on this PC">
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
        {missing.length > 0 && (
          <section className="mt-8" aria-label="Only on the Orchestrator">
            <h2 className="text-[13px] font-semibold text-muted">Only on the Orchestrator</h2>
            <p className="mt-0.5 mb-3 text-xs text-subtle">
              Robots use these. To test automations that use them on this PC, add them here with the same name.
            </p>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
              {missing.map((c) => (
                <li key={c.name} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon name="server" size={16} className="text-subtle" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">{c.name}</p>
                    <p className="text-xs text-subtle">{c.username || 'no username'}</p>
                  </div>
                  <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => add(c)} disabled={!available}>
                    Add on this PC
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <CredentialDialog
        value={editing}
        preset={preset}
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
