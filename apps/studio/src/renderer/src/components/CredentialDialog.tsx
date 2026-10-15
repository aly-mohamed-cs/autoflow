import { Button, Dialog, Field, Input } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import type { CredentialSummary } from '../../../shared/api';
import { errorMessage } from '../store/app';

/**
 * Add (value "new", optionally with a name and username filled in) or edit a credential saved
 * on this PC. Used by the Credentials page and by steps' credential settings.
 */
export function CredentialDialog({
  value,
  preset,
  onClose,
  onSaved,
}: {
  value: CredentialSummary | 'new' | null;
  preset?: { name: string; username: string };
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const isNew = value === 'new';
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setName(value && value !== 'new' ? value.name : (preset?.name ?? ''));
    setUsername(value && value !== 'new' ? value.username : (preset?.username ?? ''));
    setPassword('');
    setError('');
  }, [value, preset]);

  const save = async () => {
    try {
      await window.autoflow.vault.save({ name, username, password: password || undefined });
      onSaved(name.trim());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={value !== null}
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'Add credential' : `Edit “${name}”`}
      description={isNew ? 'Saved on this PC for test runs; the password is encrypted with your Windows account.' : undefined}
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
          <Input id="cred-name" value={name} disabled={!isNew} onChange={(e) => setName(e.target.value)} autoFocus={isNew && !preset?.name} />
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
          <Input
            id="cred-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus={isNew && !!preset?.name}
          />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
