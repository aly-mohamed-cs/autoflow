import { Button, Dialog, EmptyState, Field, Icon, Input, Select } from '@autoflow/ui';
import { useState } from 'react';
import { Card, ConfirmButton, ErrorBox, Loading, PageHeader } from '../components/common';
import { api, useApi } from '../lib/api';
import { bytes, relative } from '../lib/format';

type Kind = 'text' | 'number' | 'yesno' | 'file';

interface Asset {
  name: string;
  kind: Kind;
  value: string;
  fileName: string | null;
  fileSize: number | null;
  description: string;
  updatedBy: string | null;
  updatedAt: string;
}

const KINDS: { value: Kind; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'yesno', label: 'Yes / No' },
  { value: 'file', label: 'File' },
];
const MAX_FILE = 20 * 1024 * 1024;

function shown(a: Asset): string {
  if (a.kind === 'file') return `${a.fileName ?? 'file'}${a.fileSize !== null ? ` (${bytes(a.fileSize)})` : ''}`;
  if (a.kind === 'yesno') return a.value === 'true' ? 'Yes' : 'No';
  return a.value.length > 80 ? `${a.value.slice(0, 80)}…` : a.value || '(empty)';
}

export function AssetsPage() {
  const { data, error, reload } = useApi<{ assets: Asset[] }>('/api/assets');
  const [editing, setEditing] = useState<Asset | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="Shared values"
        subtitle="Company-wide values and files automations read while they run (step “Get shared value”) — change a portal address or a price list here once, instead of in every automation."
        actions={<Button variant="primary" icon={<Icon name="plus" size={15} />} onClick={() => setEditing('new')}>Add shared value</Button>}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data ? (
        !error && <Loading />
      ) : (
        <Card padded={false}>
          {data.assets.length === 0 ? (
            <EmptyState icon={<Icon name="library" size={28} />} title="No shared values yet">
              For passwords use Credentials instead — shared values are visible to every builder.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border" aria-label="Shared values">
              {data.assets.map((a) => (
                <li key={a.name} className="flex items-center gap-3 px-4 py-3">
                  <Icon name={a.kind === 'file' ? 'file' : 'library'} size={18} className="text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{a.name}</p>
                    <p className="truncate text-sm">{shown(a)}</p>
                    <p className="text-xs text-subtle">
                      {KINDS.find((k) => k.value === a.kind)?.label}
                      {a.description ? ` · ${a.description}` : ''} · updated {relative(a.updatedAt)} by {a.updatedBy ?? '—'}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => setEditing(a)}>Edit</Button>
                  <ConfirmButton
                    title={`Delete “${a.name}”?`}
                    description="Automations that read it will fail until it is added again."
                    onConfirm={async () => {
                      await api(`/api/assets/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
                      reload();
                    }}
                    icon={<Icon name="trash" size={14} />}
                  >
                    <span className="sr-only">Delete</span>
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <AssetDialog value={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
    </>
  );
}

const EMPTY = { name: '', kind: 'text' as Kind, value: '', description: '' };

function AssetDialog({ value, onClose, onSaved }: { value: Asset | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const isNew = value === 'new';
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [last, setLast] = useState<typeof value>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  if (value !== last) {
    setLast(value);
    setError('');
    setFile(null);
    setForm(value && value !== 'new' ? { name: value.name, kind: value.kind, value: value.kind === 'file' ? '' : value.value, description: value.description } : EMPTY);
  }
  const hadFile = value && value !== 'new' && value.kind === 'file';
  const ready = form.name.trim() && (form.kind !== 'file' || file || hadFile) && (form.kind !== 'number' || form.value.trim() !== '');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = { ...form, value: form.kind === 'yesno' ? form.value || 'false' : form.value };
      if (form.kind === 'file' && file) {
        if (file.size > MAX_FILE) throw new Error('Files can be at most 20 MB.');
        body.fileName = file.name;
        body.content = await toBase64(file);
      }
      await api('/api/assets', { method: 'PUT', body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'Add shared value' : `Edit “${form.name}”`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready || saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form className="space-y-4" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        <Field label="Name" htmlFor="an" required help="Automations use this name, e.g. “Vendor portal address”.">
          <Input id="an" disabled={!isNew} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Kind" htmlFor="ak">
          <Select id="ak" value={form.kind} onChange={(k) => setForm({ ...form, kind: k as Kind, value: k === 'yesno' ? 'false' : '' })} options={KINDS} />
        </Field>
        {form.kind === 'text' && (
          <Field label="Value" htmlFor="av"><Input id="av" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></Field>
        )}
        {form.kind === 'number' && (
          <Field label="Value" htmlFor="av" required><Input id="av" type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></Field>
        )}
        {form.kind === 'yesno' && (
          <Field label="Value" htmlFor="av">
            <Select id="av" value={form.value || 'false'} onChange={(v) => setForm({ ...form, value: v })} options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} />
          </Field>
        )}
        {form.kind === 'file' && (
          <Field label="File" htmlFor="af" required={!hadFile} help={hadFile ? `Now: ${value.fileName}. Choose a file to replace it.` : 'At most 20 MB.'}>
            <input id="af" type="file" className="block w-full text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:text-fg hover:file:bg-surface" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        )}
        <Field label="Description" htmlFor="ad" error={error || undefined}>
          <Input id="ad" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Used by the invoice automations" />
        </Field>
      </form>
    </Dialog>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}
