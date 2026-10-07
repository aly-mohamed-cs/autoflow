import { Badge, Button, Dialog, EmptyState, Field, Icon, IconTile, Input, Menu, Textarea, cn } from '@autoflow/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FlowSummary } from '../../../shared/api';
import { TEMPLATES, type Template } from '../lib/templates';
import { errorMessage, useApp } from '../store/app';

export function HomePage() {
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<Template | null>(null);
  const [deleting, setDeleting] = useState<FlowSummary | null>(null);

  const refresh = useCallback(() => {
    window.autoflow.flows
      .list()
      .then(setFlows)
      .catch((e) => toast(errorMessage(e), 'error'));
  }, [toast]);
  useEffect(refresh, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (flows ?? []).filter((f) => !q || f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q));
  }, [flows, query]);

  const importFlow = async () => {
    try {
      const flow = await window.autoflow.flows.importFile();
      if (flow) navigate({ page: 'editor', flowId: flow.id });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <header className="flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Automations</h1>
            <p className="mt-0.5 text-muted">Build, test and publish automations — no code needed.</p>
          </div>
          <Button variant="secondary" icon={<Icon name="upload" size={15} />} onClick={importFlow}>
            Import
          </Button>
          <Button variant="primary" icon={<Icon name="plus" size={16} />} onClick={() => setCreating(TEMPLATES[0]!)}>
            New automation
          </Button>
        </header>

        <section className="mt-8">
          <h2 className="mb-3 text-[13px] font-semibold text-muted">Start from a template</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setCreating(t)}
                className="group flex flex-col items-start gap-2 rounded-lg border border-border bg-surface p-4 text-left shadow-card transition hover:border-primary/50 hover:shadow-pop"
              >
                <IconTile name={t.icon} category={t.category} />
                <span className="font-semibold group-hover:text-primary">{t.title}</span>
                <span className="text-[13px] leading-snug text-muted">{t.description}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <div className="mb-3 flex items-center gap-3">
            <h2 className="flex-1 text-[13px] font-semibold text-muted">
              My automations {flows && flows.length > 0 && <span className="text-subtle">({flows.length})</span>}
            </h2>
            {flows && flows.length > 3 && (
              <div className="relative w-64">
                <Icon name="search" size={15} className="absolute top-2 left-2.5 text-subtle" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search automations"
                  aria-label="Search automations"
                  className="pl-8"
                />
              </div>
            )}
          </div>
          {flows === null ? null : flows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-strong bg-surface">
              <EmptyState
                icon={<Icon name="sparkles" size={32} />}
                title="No automations yet"
                action={
                  <Button variant="primary" onClick={() => setCreating(TEMPLATES[0]!)}>
                    Create your first automation
                  </Button>
                }
              >
                Pick a template above, or start from scratch. You can test every step right here before
                publishing it to run on a robot.
              </EmptyState>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((f) => (
                <FlowCard
                  key={f.id}
                  flow={f}
                  onOpen={() => navigate({ page: 'editor', flowId: f.id })}
                  onDuplicate={async () => {
                    await window.autoflow.flows.duplicate(f.id);
                    refresh();
                  }}
                  onDelete={() => setDeleting(f)}
                />
              ))}
              {filtered.length === 0 && <p className="text-muted">No automation matches “{query}”.</p>}
            </div>
          )}
        </section>
      </div>

      <NewFlowDialog template={creating} onClose={() => setCreating(null)} />
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="It moves to the Studio trash folder, so it can still be recovered by an administrator."
        width="sm"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                await window.autoflow.flows.remove(deleting!.id);
                setDeleting(null);
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

function FlowCard({
  flow,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  flow: FlowSummary;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const run = flow.lastRun;
  return (
    <div className="group relative rounded-lg border border-border bg-surface shadow-card transition hover:border-primary/50 hover:shadow-pop">
      <button type="button" onClick={onOpen} className="block w-full p-4 text-left">
        <div className="flex items-start gap-3 pr-8">
          <IconTile name="workflow" category="Control" />
          <div className="min-w-0">
            <p className="truncate font-semibold group-hover:text-primary">{flow.name}</p>
            <p className="line-clamp-2 min-h-[2.5em] text-[13px] text-muted">{flow.description || 'No description'}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-subtle">
          <span>{flow.stepCount} steps</span>
          <span aria-hidden>·</span>
          <span>Edited {relativeTime(flow.modified)}</span>
          <span className="flex-1" />
          {run && (
            <Badge tone={run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'danger' : 'neutral'}>
              {run.status === 'succeeded' ? 'Last test passed' : run.status === 'failed' ? 'Last test failed' : 'Stopped'}
            </Badge>
          )}
        </div>
      </button>
      <div className="absolute top-3 right-3">
        <Menu
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${flow.name}`}>
              <Icon name="ellipsis" size={16} />
            </Button>
          }
          items={[
            { label: 'Open', icon: <Icon name="pencil" size={14} />, onSelect: onOpen },
            { label: 'Duplicate', icon: <Icon name="copy" size={14} />, onSelect: onDuplicate },
            'separator',
            { label: 'Delete', icon: <Icon name="trash" size={14} />, onSelect: onDelete, danger: true },
          ]}
        />
      </div>
    </div>
  );
}

function NewFlowDialog({ template, onClose }: { template: Template | null; onClose: () => void }) {
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState<Template | null>(null);
  useEffect(() => {
    setChosen(template);
    setName(template && template.id !== 'blank' ? template.title : '');
    setDescription('');
  }, [template]);

  const create = async () => {
    if (!chosen || !name.trim()) return;
    const id = `flow_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    try {
      await window.autoflow.flows.save({ id, name: name.trim(), description: description.trim(), ...chosen.build() });
      onClose();
      navigate({ page: 'editor', flowId: id });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <Dialog
      open={!!template}
      onOpenChange={(open) => !open && onClose()}
      title="New automation"
      description="Give it a name people will recognise, like “Enter vendor invoices into the portal”."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={create}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label="Name" htmlFor="flow-name" required>
          <Input id="flow-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="What does it do?" htmlFor="flow-desc" help="Optional. Helps colleagues and reviewers.">
          <Textarea id="flow-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Start from">
          <div className="grid grid-cols-2 gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setChosen(t)}
                aria-pressed={chosen?.id === t.id}
                className={cn(
                  'flex items-center gap-2 rounded-md border p-2 text-left text-[13px]',
                  chosen?.id === t.id ? 'border-primary bg-primary-soft' : 'border-border hover:border-border-strong',
                )}
              >
                <IconTile name={t.icon} category={t.category} size="sm" />
                {t.title}
              </button>
            ))}
          </div>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function relativeTime(ts: number): string {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}
