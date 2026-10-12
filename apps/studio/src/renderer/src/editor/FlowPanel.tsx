import type { Variable, VariableType } from '@autoflow/flow-types';
import {
  Badge,
  Button,
  Dialog,
  Field,
  Icon,
  Input,
  SectionTitle,
  Select,
  Switch,
  Textarea,
} from '@autoflow/ui';
import { useState } from 'react';
import { toVariableName, TYPE_ICONS, TYPE_LABELS } from '../lib/scope';
import { useEditor } from '../store/editor';
import { Thumbnail } from './fields/ElementInput';
import { useFlowVariables } from './hooks';

/** Shown in the inspector when no step is selected: the automation's own settings. */
export function FlowPanel() {
  const flow = useEditor((s) => s.flow)!;
  const change = useEditor((s) => s.change);
  const all = useFlowVariables();
  const [editing, setEditing] = useState<{ variable: Variable; isNew: boolean } | null>(null);
  const declared = flow.variables ?? [];
  const produced = all.filter((v) => !declared.some((d) => d.name === v.name));
  const settings = flow.settings ?? {};

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Automation</h2>
        <Field label="Description" htmlFor="flow-description">
          <Textarea
            id="flow-description"
            rows={3}
            value={flow.description ?? ''}
            placeholder="What does this automation do, and for whom?"
            onChange={(e) =>
              change((f) => ({ ...f, description: e.target.value }), 'flow:description')
            }
          />
        </Field>
      </section>

      <section>
        <SectionTitle
          action={
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon name="plus" size={14} />}
              onClick={() =>
                setEditing({ variable: { name: '', type: 'text', is_input: true }, isNew: true })
              }
            >
              Add
            </Button>
          }
        >
          Start values & variables
        </SectionTitle>
        <p className="mb-2 px-1 text-xs text-subtle">
          Start values are filled in when the automation is run — e.g. which Excel file to process.
        </p>
        {declared.length === 0 ? (
          <p className="rounded-md border border-dashed border-border-strong p-3 text-center text-[13px] text-subtle">
            No start values
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {declared.map((v) => (
              <li key={v.name}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
                  onClick={() => setEditing({ variable: v, isNew: false })}
                >
                  <Icon name={TYPE_ICONS[v.type ?? 'any']} size={14} className="text-subtle" />
                  <span className="font-medium">{v.name}</span>
                  <span className="ml-auto flex gap-1">
                    {v.is_input && <Badge tone="primary">start value</Badge>}
                    {v.is_output && <Badge tone="success">result</Badge>}
                    {v.sensitive && <Badge>hidden</Badge>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {produced.length > 0 && (
          <>
            <p className="mt-4 mb-1.5 px-1 text-xs font-medium text-muted">Set by steps</p>
            <ul className="flex flex-wrap gap-1 px-1">
              {produced.map((v) => (
                <li key={v.name} title={v.source}>
                  <Badge>
                    <Icon name={TYPE_ICONS[v.type]} size={11} /> {v.name}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="space-y-3">
        <SectionTitle>Behaviour</SectionTitle>
        <Field
          label="Wait for screens up to"
          inline
          help="How long steps wait for an element before failing."
        >
          <div className="flex w-32 items-center gap-1">
            <Input
              type="number"
              min={1}
              value={settings.default_timeout ?? 30}
              aria-label="Seconds to wait for elements"
              onChange={(e) =>
                change(
                  (f) => ({
                    ...f,
                    settings: { ...f.settings, default_timeout: Number(e.target.value) || 30 },
                  }),
                  'flow:timeout',
                )
              }
            />
            <span className="text-xs text-subtle">sec</span>
          </div>
        </Field>
        <Field
          label="Pause after every step"
          inline
          help="Slows the automation down: to watch a test run, or for programs that need a moment after each action."
        >
          <div className="flex w-32 items-center gap-1">
            <Input
              type="number"
              min={0}
              max={60}
              step={0.5}
              value={settings.step_delay ?? 0}
              aria-label="Seconds to pause after every step"
              onChange={(e) =>
                change(
                  (f) => ({
                    ...f,
                    settings: {
                      ...f.settings,
                      step_delay: Math.min(60, Math.max(0, Number(e.target.value) || 0)),
                    },
                  }),
                  'flow:step_delay',
                )
              }
            />
            <span className="text-xs text-subtle">sec</span>
          </div>
        </Field>
        <Field label="Screenshot when a step fails" inline>
          <Switch
            checked={settings.screenshot_on_error ?? true}
            onChange={(v) =>
              change((f) => ({ ...f, settings: { ...f.settings, screenshot_on_error: v } }))
            }
          />
        </Field>
        <Field
          label="Screenshot after every step"
          inline
          help="Useful for audits; uses more disk space."
        >
          <Switch
            checked={settings.screenshot_each_step ?? false}
            onChange={(v) =>
              change((f) => ({ ...f, settings: { ...f.settings, screenshot_each_step: v } }))
            }
          />
        </Field>
      </section>

      {(flow.elements ?? []).length > 0 && (
        <section>
          <SectionTitle>Screen elements</SectionTitle>
          <ul className="space-y-1.5">
            {flow.elements!.map((e) => (
              <li
                key={e.id}
                className="flex items-center gap-2 rounded-md border border-border p-1.5"
              >
                <Thumbnail element={e} size={28} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{e.name}</span>
                <Badge>{e.kind}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      <VariableDialog
        value={editing}
        existing={declared.map((v) => v.name)}
        onClose={() => setEditing(null)}
        onSave={(variable, previousName) => {
          change((f) => {
            const list = (f.variables ?? []).filter((v) => v.name !== previousName);
            return {
              ...f,
              variables: [...list, variable].sort((a, b) => a.name.localeCompare(b.name)),
            };
          });
          setEditing(null);
        }}
        onDelete={(name) => {
          change((f) => ({ ...f, variables: (f.variables ?? []).filter((v) => v.name !== name) }));
          setEditing(null);
        }}
      />
    </div>
  );
}

const TYPES: VariableType[] = ['text', 'number', 'date', 'boolean', 'file', 'list', 'table', 'any'];

function VariableDialog({
  value,
  existing,
  onClose,
  onSave,
  onDelete,
}: {
  value: { variable: Variable; isNew: boolean } | null;
  existing: string[];
  onClose: () => void;
  onSave: (v: Variable, previousName: string | null) => void;
  onDelete: (name: string) => void;
}) {
  const [draft, setDraft] = useState<Variable | null>(null);
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value ? { ...value.variable } : null);
  }
  if (!value || !draft) return null;
  const name = toVariableName(draft.name);
  const duplicate = name !== value.variable.name && existing.includes(name);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={value.isNew ? 'Add start value' : `Variable “${value.variable.name}”`}
      footer={
        <>
          {!value.isNew && (
            <Button
              variant="ghost"
              className="mr-auto text-danger"
              onClick={() => onDelete(value.variable.name)}
            >
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name || duplicate}
            onClick={() => onSave({ ...draft, name }, value.isNew ? null : value.variable.name)}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Name"
          htmlFor="var-name"
          required
          error={duplicate ? 'A variable with this name already exists.' : undefined}
          help={
            draft.name && name !== draft.name
              ? `Will be saved as “${name}”.`
              : 'Letters, numbers and _ only.'
          }
        >
          <Input
            id="var-name"
            autoFocus
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Type">
          <Select
            value={draft.type ?? 'any'}
            onChange={(type) => setDraft({ ...draft, type: type as VariableType })}
            options={TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
          />
        </Field>
        <Field
          label="Default value"
          htmlFor="var-default"
          help="Used when no value is given at start."
        >
          <Input
            id="var-default"
            value={
              draft.default === undefined || draft.default === null ? '' : String(draft.default)
            }
            onChange={(e) =>
              setDraft({ ...draft, default: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </Field>
        <Field label="Description" htmlFor="var-desc">
          <Input
            id="var-desc"
            value={draft.description ?? ''}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Field>
        <div className="space-y-2 rounded-md bg-surface-2 p-3">
          <Field label="Ask for it when the automation starts" inline>
            <Switch
              checked={!!draft.is_input}
              onChange={(is_input) => setDraft({ ...draft, is_input })}
            />
          </Field>
          <Field label="Return it as a result" inline>
            <Switch
              checked={!!draft.is_output}
              onChange={(is_output) => setDraft({ ...draft, is_output })}
            />
          </Field>
          <Field label="Hide its value in logs" inline>
            <Switch
              checked={!!draft.sensitive}
              onChange={(sensitive) => setDraft({ ...draft, sensitive })}
            />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
