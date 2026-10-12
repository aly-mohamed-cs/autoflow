import { blocksOf, type ActivityDef, type Step } from '@autoflow/flow-types';
import { Button, Field, Icon, IconTile, Input, Segmented, Select, Switch } from '@autoflow/ui';
import { useMemo, useState } from 'react';
import { useAiEnabled } from '../lib/ai';
import { isShown, type FieldInfo } from '../lib/catalog';
import {
  changeActivity,
  findStep,
  setBlockList,
  setParam,
  topLevelSteps,
  updateStep,
} from '../lib/flowOps';
import { errorMessage, useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { useRun } from '../store/run';
import { AddStepMenu } from './AddStepMenu';
import { FlowPanel } from './FlowPanel';
import {
  canGroup,
  copySelection,
  cutSelection,
  deleteSelection,
  groupSelection,
} from './selectionActions';
import { ProcessPanel } from './ProcessTabs';
import { ParamField } from './fields/ParamField';
import { VariableNameInput } from './fields/inputs';
import { useColumns, useScopeVariables, useStepIssues } from './hooks';

export function Inspector() {
  const flow = useEditor((s) => s.flow);
  const selectedId = useEditor((s) => s.selectedId);
  const selectedCount = useEditor((s) => s.selectedIds.length);
  const processId = useEditor((s) => s.processId);
  const index = useApp((s) => s.index);
  const step = flow && selectedId ? findStep(flow, selectedId) : undefined;
  const def = step ? index.get(step.activity) : undefined;

  return (
    <aside
      className="flex h-full w-[400px] shrink-0 flex-col border-l border-border bg-surface"
      aria-label="Properties"
    >
      {selectedCount > 1 ? (
        <SelectionPanel count={selectedCount} />
      ) : step && def ? (
        <StepInspector key={step.id} step={step} def={def} />
      ) : processId ? (
        <ProcessPanel key={processId} processId={processId} />
      ) : (
        <FlowPanel />
      )}
    </aside>
  );
}

function StepInspector({ step, def }: { step: Step; def: ActivityDef }) {
  const index = useApp((s) => s.index);
  const change = useEditor((s) => s.change);
  const variables = useScopeVariables(step.id);
  const columnsFor = useColumns();
  const issues = useStepIssues(step.id);
  const runError = useRun((s) => s.stepErrors[step.id]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const params = step.params ?? {};
  const all = index.fields(def);
  const fields = all.filter((f) => isShown(f, params, all));
  const basic = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);
  const elementKind = def.category === 'Desktop' ? 'desktop' : 'web';
  const issueFor = useMemo(() => {
    const map = new Map<string, { error?: string; warning?: string }>();
    for (const i of issues) {
      if (!i.field) continue;
      const entry = map.get(i.field) ?? {};
      if (i.severity === 'error') entry.error ??= i.message;
      else entry.warning ??= i.message;
      map.set(i.field, entry);
    }
    return map;
  }, [issues]);
  const stepIssues = issues.filter((i) => !i.field);

  const renderField = (field: FieldInfo) => (
    <ParamField
      key={field.name}
      field={field}
      value={params[field.name]}
      params={params}
      onChange={(v) =>
        change(
          (f) =>
            def.block_list?.param === field.name
              ? setBlockList(f, step.id, def, Array.isArray(v) ? v.map(String) : [])
              : setParam(f, step.id, field.name, v),
          `${step.id}:${field.name}`,
        )
      }
      onParams={(patch) =>
        change((f) =>
          Object.entries(patch).reduce((acc, [name, v]) => setParam(acc, step.id, name, v), f),
        )
      }
      variables={variables}
      columnsFor={columnsFor}
      elementKind={elementKind}
      error={issueFor.get(field.name)?.error}
      warning={issueFor.get(field.name)?.warning}
    />
  );

  const update = (fn: (s: Step) => Step, key?: string) =>
    change((f) => updateStep(f, step.id, fn), key);

  return (
    <>
      <header className="flex items-start gap-3 border-b border-border p-4">
        <IconTile name={def.icon} category={def.category} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold tracking-wide text-subtle uppercase">
            {def.category}
          </p>
          <h2 className="text-base leading-tight font-semibold">{def.title}</h2>
          {def.description && (
            <p className="mt-1 text-[13px] leading-snug text-muted">{def.description}</p>
          )}
        </div>
        <ChangeStepType stepId={step.id} />
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {runError && (
          <div
            className="rounded-md border border-danger/30 bg-danger-soft p-3 text-[13px]"
            role="alert"
          >
            <p className="font-medium text-danger">This step failed in the last test run</p>
            <p className="mt-0.5 text-fg">{runError.message}</p>
            {runError.hint && <p className="mt-1 text-muted">{runError.hint}</p>}
            <ExplainError activity={step.activity} params={params} error={runError} />
          </div>
        )}
        {stepIssues.map((i, n) => (
          <p
            key={n}
            className={
              i.severity === 'error' ? 'text-[13px] text-danger' : 'text-[13px] text-warning'
            }
          >
            {i.message}
          </p>
        ))}

        {basic.length > 0 && <div className="space-y-4">{basic.map(renderField)}</div>}
        {basic.length === 0 && blocksOf(def, params).length === 0 && (
          <p className="text-[13px] text-muted">This step has no settings.</p>
        )}

        {advanced.length > 0 && (
          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-[13px] font-medium text-muted hover:text-fg"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={14} /> More options
            </button>
            {showAdvanced && <div className="mt-3 space-y-4">{advanced.map(renderField)}</div>}
          </div>
        )}

        {def.outputs.length > 0 && (
          <section className="space-y-3 rounded-md border border-border bg-surface-2 p-3">
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
              <Icon name="corner-down-right" size={14} className="text-primary" /> Results
            </h3>
            {def.outputs.map((out) => (
              <Field
                key={out.name}
                label={`Save ${out.title.toLowerCase()} as`}
                help={out.description || undefined}
              >
                <VariableNameInput
                  value={step.outputs?.[out.name] ?? ''}
                  variables={variables}
                  placeholder="Don't save"
                  onChange={(name) =>
                    update((s) => {
                      const outputs = { ...s.outputs };
                      if (name) outputs[out.name] = name;
                      else delete outputs[out.name];
                      return { ...s, outputs };
                    })
                  }
                />
              </Field>
            ))}
          </section>
        )}

        <ErrorHandling step={step} onChange={update} />

        <section className="space-y-3 border-t border-border pt-4">
          <Field
            label="Step name"
            htmlFor="step-label"
            help="Optional. Shown instead of the generated sentence."
          >
            <Input
              id="step-label"
              value={step.label ?? ''}
              placeholder={def.title}
              onChange={(e) =>
                update((s) => ({ ...s, label: e.target.value || null }), `${step.id}:label`)
              }
            />
          </Field>
          <Field label="Skip this step" inline help="Keep it in the automation but don't run it.">
            <Switch
              checked={!!step.disabled}
              onChange={(disabled) => update((s) => ({ ...s, disabled }))}
              label="Skip this step"
            />
          </Field>
        </section>
      </div>
    </>
  );
}

function ErrorHandling({
  step,
  onChange,
}: {
  step: Step;
  onChange: (fn: (s: Step) => Step, key?: string) => void;
}) {
  const onError = step.on_error ?? {};
  const [open, setOpen] = useState(!!(onError.retries || onError.action === 'continue'));
  const set = (patch: Partial<NonNullable<Step['on_error']>>) =>
    onChange((s) => ({ ...s, on_error: { ...s.on_error, ...patch } }), `${step.id}:on_error`);
  return (
    <section className="rounded-md border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 p-3 text-[13px] font-semibold"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="shield-alert" size={14} className="text-warning" />
        If this step fails
        <span className="ml-auto font-normal text-subtle">
          {onError.retries ? `retry ${onError.retries}×, then ` : ''}
          {onError.action === 'continue' ? 'continue' : 'stop'}
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} className="text-subtle" />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border p-3">
          <Field label="Try again" inline>
            <Select
              value={String(onError.retries ?? 0)}
              onChange={(v) => set({ retries: Number(v) })}
              options={[0, 1, 2, 3, 5, 10].map((n) => ({
                value: String(n),
                label: n === 0 ? 'No' : `${n} time${n > 1 ? 's' : ''}`,
              }))}
              className="w-36"
            />
          </Field>
          {!!onError.retries && (
            <Field label="Wait between tries" inline>
              <div className="flex w-36 items-center gap-1">
                <Input
                  type="number"
                  min={0}
                  value={onError.retry_delay ?? 1}
                  onChange={(e) => set({ retry_delay: Number(e.target.value) })}
                  aria-label="Seconds between tries"
                />
                <span className="text-xs text-subtle">sec</span>
              </div>
            </Field>
          )}
          <Field label="Then">
            <Segmented
              value={onError.action ?? 'stop'}
              onChange={(action) => set({ action })}
              options={[
                { value: 'stop', label: 'Stop the automation' },
                { value: 'continue', label: 'Continue with the next step' },
              ]}
            />
          </Field>
          <p className="text-xs text-subtle">
            To run other steps when something fails, put the steps inside a “Try / If it fails”
            step.
          </p>
        </div>
      )}
    </section>
  );
}

/** Ask the company's local AI model what went wrong (hidden unless an admin turned it on). */
function ExplainError({
  activity,
  params,
  error,
}: {
  activity: string;
  params: Record<string, unknown>;
  error: { message: string; hint?: string | null };
}) {
  const enabled = useAiEnabled();
  const [state, setState] = useState<{ busy: boolean; text?: string; failed?: boolean }>({
    busy: false,
  });
  if (!enabled) return null;
  if (state.text) {
    return (
      <p
        className={`mt-2 flex gap-2 rounded border border-border bg-surface p-2 ${state.failed ? 'text-muted' : 'text-fg'}`}
      >
        <Icon name="sparkles" size={15} className="mt-0.5 shrink-0 text-primary" />
        <span className="whitespace-pre-line">{state.text}</span>
      </p>
    );
  }
  return (
    <Button
      size="sm"
      className="mt-2"
      disabled={state.busy}
      icon={<Icon name="sparkles" size={14} />}
      onClick={async () => {
        setState({ busy: true });
        try {
          const text = await window.autoflow.ai.explainError({
            activity,
            message: error.message,
            hint: error.hint ?? null,
            params,
          });
          setState({ busy: false, text });
        } catch (e) {
          setState({ busy: false, text: errorMessage(e), failed: true });
        }
      }}
    >
      {state.busy ? 'Asking the AI assistant…' : 'Explain this error'}
    </Button>
  );
}

/** Turn the step into another kind (Brity "Change activity"), keeping what still applies. */
function ChangeStepType({ stepId }: { stepId: string }) {
  const [open, setOpen] = useState(false);
  const change = useEditor((s) => s.change);
  return (
    <AddStepMenu
      open={open}
      onOpenChange={setOpen}
      onPick={(def) => {
        setOpen(false);
        change((f) => changeActivity(f, stepId, def));
      }}
      trigger={
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Change step type"
          title="Change to another kind of step, keeping its settings"
        >
          <Icon name="replace" size={15} />
        </Button>
      }
    />
  );
}

/** Several steps selected: what can be done with all of them. */
function SelectionPanel({ count }: { count: number }) {
  const groupable = useEditor(() => canGroup());
  const change = useEditor((s) => s.change);
  const allSkipped = useEditor((s) =>
    s.flow ? topLevelSteps(s.flow, s.selectedIds).every((step) => step.disabled) : false,
  );
  const toggleSkip = () =>
    change((f) =>
      topLevelSteps(f, useEditor.getState().selectedIds).reduce(
        (acc, step) => updateStep(acc, step.id, (s) => ({ ...s, disabled: !allSkipped })),
        f,
      ),
    );
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <h2 className="text-base font-semibold">{count} steps selected</h2>
      <p className="text-[13px] text-muted">
        Drag one of them on the chart to move them together. Ctrl+click adds or removes a step;
        Shift+drag on an empty spot draws a box around steps.
      </p>
      <div className="grid gap-2">
        <Button
          icon={<Icon name="square-dashed" size={15} />}
          disabled={!groupable}
          title={groupable ? undefined : 'Only steps in the same list can be grouped'}
          onClick={() => groupSelection()}
        >
          Group into a box <span className="ml-auto text-[11px] text-subtle">Ctrl+G</span>
        </Button>
        <Button icon={<Icon name="copy" size={15} />} onClick={() => void copySelection()}>
          Copy <span className="ml-auto text-[11px] text-subtle">Ctrl+C</span>
        </Button>
        <Button icon={<Icon name="scissors" size={15} />} onClick={() => void cutSelection()}>
          Cut <span className="ml-auto text-[11px] text-subtle">Ctrl+X</span>
        </Button>
        <Button
          icon={<Icon name={allSkipped ? 'eye' : 'eye-off'} size={15} />}
          onClick={toggleSkip}
        >
          {allSkipped ? 'Turn them on' : 'Skip them'}
        </Button>
        <Button
          variant="danger"
          icon={<Icon name="trash" size={15} />}
          onClick={() => deleteSelection()}
        >
          Delete <span className="ml-auto text-[11px] opacity-80">Del</span>
        </Button>
      </div>
    </div>
  );
}
