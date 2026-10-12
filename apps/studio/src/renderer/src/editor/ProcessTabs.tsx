// Sub-processes (Brity RPA "tasks"): the tab strip above the steps, and their settings panel.
import type { ProcessInput, SubProcess, VariableType } from '@autoflow/flow-types';
import {
  Button,
  cn,
  Dialog,
  Field,
  Icon,
  Input,
  Menu,
  SectionTitle,
  Select,
  Textarea,
} from '@autoflow/ui';
import { useEffect, useRef, useState } from 'react';
import {
  addProcess,
  duplicateProcess,
  findStep,
  NO_PROCESSES,
  processUsers,
  removeProcess,
  updateProcess,
} from '../lib/flowOps';
import { toVariableName, TYPE_LABELS } from '../lib/scope';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { useSentenceText } from './stepParts';

/** "Main process" plus one tab per sub-process, and a button to add one. */
export function ProcessTabs() {
  const processes = useEditor((s) => s.flow?.processes ?? NO_PROCESSES);
  const current = useEditor((s) => s.processId);
  const showProcess = useEditor((s) => s.showProcess);
  const change = useEditor((s) => s.change);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SubProcess | null>(null);

  const add = () => {
    let id = '';
    change((f) => {
      const r = addProcess(f, `Sub-process ${(f.processes?.length ?? 0) + 1}`);
      id = r.id;
      return r.flow;
    });
    if (id) {
      showProcess(id);
      setRenaming(id);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Processes"
      className="flex min-w-0 items-center gap-1 overflow-x-auto"
    >
      <Tab
        label="Main process"
        icon="play"
        active={current === null}
        onSelect={() => showProcess(null)}
      />
      {processes.map((p) => (
        <Tab
          key={p.id}
          label={p.name}
          icon="workflow"
          active={current === p.id}
          renaming={renaming === p.id}
          onSelect={() => showProcess(p.id)}
          onRename={(name) => {
            setRenaming(null);
            if (name.trim() && name.trim() !== p.name)
              change((f) => updateProcess(f, p.id, (x) => ({ ...x, name: name.trim() })));
          }}
          menu={[
            {
              label: 'Rename',
              icon: <Icon name="pencil" size={14} />,
              onSelect: () => setRenaming(p.id),
            },
            {
              label: 'Duplicate',
              icon: <Icon name="copy" size={14} />,
              onSelect: () => {
                let id: string | null = null;
                change((f) => {
                  const r = duplicateProcess(f, p.id);
                  id = r.id;
                  return r.flow;
                });
                if (id) showProcess(id);
              },
            },
            'separator',
            {
              label: 'Delete',
              icon: <Icon name="trash" size={14} />,
              danger: true,
              onSelect: () => setDeleting(p),
            },
          ]}
        />
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0"
        icon={<Icon name="plus" size={14} />}
        onClick={add}
        title="A part of this automation you can run from several places, like Brity RPA tasks"
      >
        Sub-process
      </Button>
      <DeleteProcess process={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function Tab({
  label,
  icon,
  active,
  renaming,
  onSelect,
  onRename,
  menu,
}: {
  label: string;
  icon: string;
  active: boolean;
  renaming?: boolean;
  onSelect: () => void;
  onRename?: (name: string) => void;
  menu?: Parameters<typeof Menu>[0]['items'];
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);
  return (
    <div
      className={cn(
        'group flex h-8 shrink-0 items-center rounded-md border text-[13px]',
        active
          ? 'border-primary/40 bg-primary-soft text-fg'
          : 'border-transparent text-muted hover:bg-surface-2',
      )}
    >
      {renaming ? (
        <input
          ref={input}
          aria-label="Sub-process name"
          defaultValue={label}
          className="mx-1 h-6 w-40 rounded border border-border bg-surface px-1.5 text-[13px] outline-none focus:border-primary"
          onBlur={(e) => onRename?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRename?.(e.currentTarget.value);
            if (e.key === 'Escape') onRename?.(label);
          }}
        />
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={active}
          className="flex h-full items-center gap-1.5 pr-1 pl-2.5 font-medium"
          onClick={onSelect}
          onDoubleClick={() =>
            onRename && menu?.[0] && typeof menu[0] !== 'string' && menu[0].onSelect()
          }
        >
          <Icon name={icon} size={13} className={active ? 'text-primary' : 'text-subtle'} />
          <span className="max-w-44 truncate">{label}</span>
        </button>
      )}
      {menu && !renaming ? (
        <Menu
          align="start"
          items={menu}
          trigger={
            <button
              type="button"
              aria-label={`${label} options`}
              className={cn(
                'mr-1 rounded p-0.5 text-subtle hover:bg-surface hover:text-fg',
                !active && 'opacity-0 group-hover:opacity-100',
              )}
            >
              <Icon name="ellipsis" size={14} />
            </button>
          }
        />
      ) : (
        <span className="w-1.5" />
      )}
    </div>
  );
}

function DeleteProcess({ process, onClose }: { process: SubProcess | null; onClose: () => void }) {
  const flow = useEditor((s) => s.flow);
  const change = useEditor((s) => s.change);
  const users = process && flow ? processUsers(flow, process.id).length : 0;
  return (
    <Dialog
      open={!!process}
      onOpenChange={(o) => !o && onClose()}
      title={`Delete “${process?.name}”?`}
      description={
        users
          ? `${users} “Run sub-process” step${users === 1 ? '' : 's'} use${users === 1 ? 's' : ''} it and will need another sub-process. You can undo this.`
          : `Its ${process?.steps?.length ?? 0} step(s) are deleted too. You can undo this.`
      }
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (process) change((f) => removeProcess(f, process.id));
              onClose();
            }}
          >
            Delete
          </Button>
        </>
      }
    />
  );
}

const TYPES = Object.keys(TYPE_LABELS) as VariableType[];

/** Shown in the settings panel when a sub-process tab is open and no step is selected. */
export function ProcessPanel({ processId }: { processId: string }) {
  const process = useEditor((s) => s.flow?.processes?.find((p) => p.id === processId));
  const flow = useEditor((s) => s.flow);
  const change = useEditor((s) => s.change);
  if (!process || !flow) return null;
  const edit = (fn: (p: SubProcess) => SubProcess, key?: string) =>
    change((f) => updateProcess(f, processId, fn), key);
  const inputs = process.inputs ?? [];
  const setInput = (i: number, patch: Partial<ProcessInput>) =>
    edit(
      (p) => ({ ...p, inputs: (p.inputs ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) }),
      `process:${processId}:input:${i}`,
    );
  const users = processUsers(flow, processId);

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Icon name="workflow" size={16} className="text-primary" /> Sub-process
        </h2>
        <Field label="Name" htmlFor="process-name">
          <Input
            id="process-name"
            value={process.name}
            onChange={(e) =>
              edit((p) => ({ ...p, name: e.target.value || p.name }), `process:${processId}:name`)
            }
          />
        </Field>
        <Field label="Description" htmlFor="process-description">
          <Textarea
            id="process-description"
            rows={2}
            value={process.description ?? ''}
            placeholder="What does this part do? E.g. “Log in to the ERP”"
            onChange={(e) =>
              edit(
                (p) => ({ ...p, description: e.target.value }),
                `process:${processId}:description`,
              )
            }
          />
        </Field>
        <p className="text-xs text-subtle">
          It uses the same variables as the rest of the automation. Add a{' '}
          <strong>Run sub-process</strong> step wherever it should run.
        </p>
      </section>

      <section>
        <SectionTitle
          action={
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon name="plus" size={14} />}
              onClick={() =>
                edit((p) => ({
                  ...p,
                  inputs: [...(p.inputs ?? []), { name: uniqueName(p.inputs ?? []), type: 'text' }],
                }))
              }
            >
              Add
            </Button>
          }
        >
          Inputs
        </SectionTitle>
        <p className="mb-2 px-1 text-xs text-subtle">
          Values each “Run sub-process” step can hand over, e.g. which user to log in as. They
          become variables while it runs.
        </p>
        {inputs.length === 0 ? (
          <p className="rounded-md border border-dashed border-border-strong p-3 text-center text-[13px] text-subtle">
            No inputs
          </p>
        ) : (
          <ul className="space-y-2" aria-label="Inputs">
            {inputs.map((input, i) => (
              <li key={i} className="space-y-2 rounded-md border border-border p-2.5">
                <div className="flex gap-2">
                  <Input
                    aria-label="Input name"
                    value={input.name}
                    className="font-mono text-[13px]"
                    onChange={(e) =>
                      setInput(i, { name: toVariableName(e.target.value) || input.name })
                    }
                  />
                  <Select
                    aria-label="Input type"
                    value={input.type ?? 'any'}
                    onChange={(v) => setInput(i, { type: v as VariableType })}
                    options={TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove input ${input.name}`}
                    onClick={() =>
                      edit((p) => ({ ...p, inputs: (p.inputs ?? []).filter((_, j) => j !== i) }))
                    }
                  >
                    <Icon name="trash" size={14} />
                  </Button>
                </div>
                <Input
                  aria-label="Default value"
                  placeholder="Default value (used when a step leaves it empty)"
                  value={input.default == null ? '' : String(input.default)}
                  onChange={(e) =>
                    setInput(i, { default: e.target.value === '' ? null : e.target.value })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionTitle>Used by</SectionTitle>
        {users.length === 0 ? (
          <p className="px-1 text-[13px] text-subtle">
            No step runs it yet. Add a <strong>Run sub-process</strong> step (Control) in the main
            process.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {users.map((step) => (
              <UserRow key={step.id} stepId={step.id} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function UserRow({ stepId }: { stepId: string }) {
  const flow = useEditor((s) => s.flow)!;
  const select = useEditor((s) => s.select);
  const index = useApp((s) => s.index);
  const step = findStep(flow, stepId)!;
  const text = useSentenceText(step, index.get(step.activity));
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-2"
        onClick={() => select(stepId)}
      >
        <Icon name="workflow" size={14} className="text-subtle" />
        <span className="truncate">{step.label || text}</span>
      </button>
    </li>
  );
}

function uniqueName(inputs: ProcessInput[]): string {
  const taken = new Set(inputs.map((i) => i.name));
  let n = inputs.length + 1;
  while (taken.has(`input_${n}`)) n++;
  return `input_${n}`;
}
