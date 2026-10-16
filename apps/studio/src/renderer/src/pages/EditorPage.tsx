import type { Flow, Variable, ValidationIssue } from '@autoflow/flow-types';
import { Badge, Button, Dialog, Field, Icon, IconTile, Input, Menu, Spinner, Tooltip, cn } from '@autoflow/ui';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragMoveEvent } from '@dnd-kit/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createStep } from '../lib/catalog';
import { duplicateStep, findStep, flatIds, getList, insertStep, listKey, locate, moveStep, parseListKey, processSteps, rootRef } from '../lib/flowOps';
import { insertOnLink, setPosition } from '../lib/flowchart';
import { SIZES } from '../lib/flowLayout';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Canvas } from '../editor/Canvas';
import { openFind } from '../editor/FindSteps';
import {
  copySelection,
  cutSelection,
  deleteSelection,
  groupSelection,
  pasteClipboard,
  selectAll,
} from '../editor/selectionActions';
import { innermostUnderPointer, useDnd, type DragItem, type DropData, type DropTarget } from '../editor/dnd';
import { FileAddon } from '../editor/fields/inputs';
import { useFlowVariables } from '../editor/hooks';
import { Inspector } from '../editor/Inspector';
import { PublishButton } from '../editor/Publish';
import { RecordButton, Recorder } from '../editor/Recorder';
import { flowCredentialNames, RunPanel } from '../editor/RunPanel';
import { StepLibrary } from '../editor/StepLibrary';
import { errorMessage, useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { formatDuration, isActive, useRun } from '../store/run';
import { aiEnabled, aiRepairWanted, useAiEnabled } from '../lib/ai';
import { AssistantPanel } from '../editor/AssistantPanel';
import { useAssistant } from '../store/assistant';

export function EditorPage({ flowId }: { flowId: string }) {
  const flow = useEditor((s) => s.flow);
  const open = useEditor((s) => s.open);
  const close = useEditor((s) => s.close);
  const toast = useApp((s) => s.toast);
  const navigate = useApp((s) => s.navigate);
  const [panelHeight, setPanelHeight] = useState(240);
  const selectedId = useEditor((s) => s.selectedId);
  const aiOn = useAiEnabled();
  const assistantOpen = useAssistant((s) => s.open) && aiOn;

  useEffect(() => {
    let cancelled = false;
    window.autoflow.flows
      .get(flowId)
      .then((f) => !cancelled && open(f))
      .catch((e) => {
        toast(errorMessage(e), 'error');
        navigate({ page: 'home' });
      });
    return () => {
      cancelled = true;
      close();
    };
  }, [flowId, open, close, toast, navigate]);

  useAutosave();
  useValidation();
  useShortcuts();

  if (!flow || flow.id !== flowId) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner className="mr-2" /> Opening…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <EditorDnd>
        <div className="flex min-h-0 flex-1">
          {assistantOpen ? (
            <ErrorBoundary area="the AI assistant">
              <AssistantPanel />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary area="the step library">
              <StepLibrary />
            </ErrorBoundary>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <ErrorBoundary area="the step list">
              <Canvas />
            </ErrorBoundary>
            <ErrorBoundary area="the run panel">
              <RunPanel height={panelHeight} onResize={setPanelHeight} />
            </ErrorBoundary>
          </div>
          <ErrorBoundary area="the settings panel" resetKey={selectedId}>
            <Inspector />
          </ErrorBoundary>
        </div>
      </EditorDnd>
    </div>
  );
}

// -- saving & validation ----------------------------------------------------------

function useAutosave() {
  const flow = useEditor((s) => s.flow);
  const dirty = useEditor((s) => s.dirty);
  const toast = useApp((s) => s.toast);
  useEffect(() => {
    if (!flow || !dirty) return;
    const timer = setTimeout(async () => {
      useEditor.getState().markSaving(true);
      try {
        await window.autoflow.flows.save(flow);
        useEditor.getState().markSaved(flow);
      } catch (e) {
        useEditor.getState().markSaving(false);
        toast(`Could not save: ${errorMessage(e)}`, 'error');
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [flow, dirty, toast]);
}

function useValidation() {
  const flow = useEditor((s) => s.flow);
  const engineReady = useApp((s) => s.engine.state === 'ready');
  useEffect(() => {
    if (!flow || !engineReady) return;
    const timer = setTimeout(() => {
      window.autoflow.engine
        .call<{ issues: ValidationIssue[] }>('flow.validate', { flow })
        .then((r) => useEditor.getState().setIssues(r.issues))
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(timer);
  }, [flow, engineReady]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      const { undo, redo, selectedId, select, change, flow } = useEditor.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'y' && !typing) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'F5') {
        e.preventDefault();
        void startRun(false);
        return;
      }
      if (typing || !flow) return;
      const key = e.key.toLowerCase();
      // Brity-style shortcuts that work on the selection (or need none).
      if (ctrl && key === 'v') {
        e.preventDefault();
        void pasteClipboard();
        return;
      }
      if (ctrl && key === 'a') {
        e.preventDefault();
        selectAll();
        return;
      }
      if (ctrl && key === 'f') {
        e.preventDefault();
        openFind();
        return;
      }
      if (!selectedId) return;
      if (ctrl && key === 'c') {
        e.preventDefault();
        void copySelection();
      } else if (ctrl && key === 'x') {
        e.preventDefault();
        void cutSelection();
      } else if (ctrl && key === 'g') {
        e.preventDefault();
        groupSelection();
      } else if (e.key === 'Delete') {
        e.preventDefault();
        deleteSelection();
      } else if (useEditor.getState().selectedIds.length > 1) {
        if (e.key === 'Escape') select(null);
      } else if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        let newId: string | null = null;
        change((f) => {
          const r = duplicateStep(f, selectedId);
          newId = r.newId;
          return r.flow;
        });
        if (newId) select(newId);
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        change((f) => {
          const where = locate(f, selectedId);
          return where ? moveStep(f, selectedId, where.ref, where.index + (e.key === 'ArrowDown' ? 2 : -1)) : f;
        });
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const ids = flatIds(flow, useEditor.getState().processId);
        const i = ids.indexOf(selectedId);
        const next = ids[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          select(next);
          document.querySelector(`[data-step-id="${next}"]`)?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Escape') {
        select(null);
      } else if (e.key === 'F9') {
        e.preventDefault();
        void window.autoflow.run.setBreakpoints(useRun.getState().toggleBreakpoint(flow.id, selectedId));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// -- running ------------------------------------------------------------------------

let pendingInputs: ((values: Record<string, unknown> | null) => void) | null = null;
const inputRequests = { listeners: new Set<(vars: Variable[]) => void>() };

async function askForInputs(vars: Variable[]): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    pendingInputs = resolve;
    inputRequests.listeners.forEach((l) => l(vars));
  });
}

const lastInputs: Record<string, Record<string, unknown>> = {};

export async function startRun(stepMode: boolean): Promise<void> {
  const { flow } = useEditor.getState();
  const run = useRun.getState();
  const { toast, engine } = useApp.getState();
  if (!flow || isActive(run.phase)) return;
  if (engine.state !== 'ready') {
    toast('The automation engine is not ready yet. Check Settings.', 'error');
    return;
  }
  const inputVars = (flow.variables ?? []).filter((v) => v.is_input);
  let inputs: Record<string, unknown> = {};
  if (inputVars.length) {
    const values = await askForInputs(inputVars);
    if (!values) return;
    inputs = values;
    lastInputs[flow.id] = values;
  }
  run.begin(flow.id);
  try {
    const result = await window.autoflow.run.start(flow, {
      inputs,
      stepMode,
      breakpoints: run.breakpoints[flow.id] ?? [],
      credentials: flowCredentialNames(flow),
      repair: aiRepairWanted() && (await aiEnabled()),
    });
    useRun.getState().started(result.run_id);
  } catch (e) {
    useRun.getState().failedToStart(errorMessage(e));
  }
}

function useRecordRunResult() {
  const result = useRun((s) => s.result);
  const runFlowId = useRun((s) => s.flowId);
  useEffect(() => {
    if (result && runFlowId) void window.autoflow.flows.recordRun(runFlowId, result.status);
  }, [result, runFlowId]);
}

function Toolbar() {
  const flow = useEditor((s) => s.flow)!;
  const change = useEditor((s) => s.change);
  const dirty = useEditor((s) => s.dirty);
  const saving = useEditor((s) => s.saving);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const issues = useEditor((s) => s.issues);
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const engineReady = useApp((s) => s.engine.state === 'ready');
  const phase = useRun((s) => s.phase);
  const startedAt = useRun((s) => s.startedAt);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const aiOn = useAiEnabled();
  const assistantOpen = useAssistant((s) => s.open);
  useRecordRunResult();

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <Tooltip content="All automations">
        <Button variant="ghost" size="icon" aria-label="Back to all automations" onClick={() => navigate({ page: 'home' })}>
          <Icon name="arrow-left" size={18} />
        </Button>
      </Tooltip>
      <IconTile name="workflow" category="Control" size="sm" />
      <input
        value={flow.name}
        aria-label="Automation name"
        onChange={(e) => change((f) => ({ ...f, name: e.target.value }), 'flow:name')}
        onBlur={(e) => !e.target.value.trim() && change((f) => ({ ...f, name: 'Untitled automation' }))}
        className="min-w-0 max-w-sm flex-1 truncate rounded px-1.5 py-1 text-base font-semibold hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
      />
      <span className="flex items-center gap-1 text-xs text-subtle" aria-live="polite">
        {saving ? (
          <>
            <Spinner className="h-3 w-3" /> Saving…
          </>
        ) : dirty ? (
          'Unsaved changes'
        ) : (
          <>
            <Icon name="cloud-check" size={14} /> Saved
          </>
        )}
      </span>
      <div className="flex-1" />
      {aiOn && (
        <Button
          variant={assistantOpen ? 'secondary' : 'ghost'}
          aria-pressed={assistantOpen}
          icon={<Icon name="sparkles" size={15} />}
          onClick={() => useAssistant.getState().setOpen(!assistantOpen)}
        >
          AI assistant
        </Button>
      )}
      <Tooltip content="Undo (Ctrl+Z)">
        <Button variant="ghost" size="icon" aria-label="Undo" disabled={!canUndo} onClick={undo}>
          <Icon name="undo-2" size={17} />
        </Button>
      </Tooltip>
      <Tooltip content="Redo (Ctrl+Y)">
        <Button variant="ghost" size="icon" aria-label="Redo" disabled={!canRedo} onClick={redo}>
          <Icon name="redo-2" size={17} />
        </Button>
      </Tooltip>
      {issues.length > 0 && (
        <Badge tone={errors ? 'danger' : 'warning'}>
          <Icon name="triangle-alert" size={11} />
          {errors ? `${errors} to fix` : `${issues.length} warning${issues.length > 1 ? 's' : ''}`}
        </Badge>
      )}
      <Menu
        trigger={
          <Button variant="ghost" size="icon" aria-label="More">
            <Icon name="ellipsis-vertical" size={17} />
          </Button>
        }
        items={[
          {
            label: 'Export to file…',
            icon: <Icon name="download" size={14} />,
            onSelect: async () => {
              if (await window.autoflow.flows.exportFile(flow)) toast('Automation exported', 'success');
            },
          },
        ]}
      />
      <div className="mx-1 h-6 w-px bg-border" />
      <PublishButton />
      <RecordButton />
      <RunControls phase={phase} startedAt={startedAt} disabled={!engineReady} hasErrors={errors > 0} />
      <InputsDialog />
      <Recorder />
    </header>
  );
}

function RunControls({ phase, startedAt, disabled, hasErrors }: { phase: string; startedAt: number | null; disabled: boolean; hasErrors: boolean }) {
  const elapsed = useElapsed(startedAt, phase === 'running' || phase === 'paused' || phase === 'starting');
  // Feedback until the engine confirms (it reacts at once, also while a step is waiting).
  const [requested, setRequested] = useState<'pause' | 'stop' | null>(null);
  useEffect(() => setRequested(null), [phase]);
  const control = (action: 'pause' | 'resume' | 'step' | 'stop') => {
    if (action === 'pause' || action === 'stop') setRequested(action);
    window.autoflow.run.control(action).catch((e) => {
      setRequested(null);
      useApp.getState().toast(errorMessage(e), 'error');
    });
  };
  const stopButton = (
    <Tooltip content="Stop the test run (Ctrl+Shift+F12, works from any program)">
      <Button variant="danger" disabled={requested === 'stop'} onClick={() => control('stop')} icon={<Icon name="square" size={13} />}>
        {requested === 'stop' ? 'Stopping…' : 'Stop'}
      </Button>
    </Tooltip>
  );

  if (phase === 'running' || phase === 'starting') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="flex items-center gap-1.5 text-[13px] text-primary">
          <Spinner /> Running {elapsed}
        </span>
        <Tooltip content="Pause (Ctrl+Shift+F11, works from any program)">
          <Button disabled={requested !== null} onClick={() => control('pause')} icon={<Icon name="pause" size={15} />}>
            {requested === 'pause' ? 'Pausing…' : 'Pause'}
          </Button>
        </Tooltip>
        {stopButton}
      </div>
    );
  }
  if (phase === 'paused') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[13px] text-warning">Paused {elapsed}</span>
        <Tooltip content="Run only the next step">
          <Button onClick={() => control('step')} icon={<Icon name="step-forward" size={15} />}>Next step</Button>
        </Tooltip>
        <Tooltip content="Continue (Ctrl+Shift+F11)">
          <Button variant="primary" onClick={() => control('resume')} icon={<Icon name="play" size={15} />}>Continue</Button>
        </Tooltip>
        {stopButton}
      </div>
    );
  }
  return (
    <div className="flex items-center">
      <Tooltip content={disabled ? 'The automation engine is not ready' : hasErrors ? 'Some settings still need fixing — the run will stop at them' : 'Run on this computer (F5)'}>
        <Button variant="primary" className="rounded-r-none" disabled={disabled} onClick={() => void startRun(false)} icon={<Icon name="play" size={15} />}>
          Test run
        </Button>
      </Tooltip>
      <Menu
        trigger={
          <Button variant="primary" className="rounded-l-none border-l border-white/25 px-1.5" disabled={disabled} aria-label="More ways to run">
            <Icon name="chevron-down" size={15} />
          </Button>
        }
        items={[
          { label: 'Run step by step', icon: <Icon name="step-forward" size={14} />, onSelect: () => void startRun(true) },
        ]}
      />
    </div>
  );
}

function useElapsed(startedAt: number | null, active: boolean): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return startedAt && active ? formatDuration(Math.max(0, now - startedAt)).replace(/\.\d s/, ' s') : '';
}

/** Asks for start values before a test run. */
function InputsDialog() {
  const [vars, setVars] = useState<Variable[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const flowId = useEditor((s) => s.flow?.id);
  useEffect(() => {
    const listener = (v: Variable[]) => {
      const remembered = (flowId && lastInputs[flowId]) || {};
      setValues(Object.fromEntries(v.map((x) => [x.name, String(remembered[x.name] ?? x.default ?? '')])));
      setVars(v);
    };
    inputRequests.listeners.add(listener);
    return () => {
      inputRequests.listeners.delete(listener);
    };
  }, [flowId]);
  const finish = (ok: boolean) => {
    pendingInputs?.(ok ? values : null);
    pendingInputs = null;
    setVars(null);
  };
  return (
    <Dialog
      open={!!vars}
      onOpenChange={(o) => !o && finish(false)}
      title="Start values"
      description="These values are given to the automation when it starts."
      footer={
        <>
          <Button onClick={() => finish(false)}>Cancel</Button>
          <Button variant="primary" icon={<Icon name="play" size={15} />} onClick={() => finish(true)}>
            Run
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        {vars?.map((v, i) => (
          <Field key={v.name} label={v.name} help={v.description} htmlFor={`in-${v.name}`}>
            <div className="flex items-center gap-1">
              <Input
                id={`in-${v.name}`}
                autoFocus={i === 0}
                type={v.sensitive ? 'password' : v.type === 'number' ? 'number' : 'text'}
                value={values[v.name] ?? ''}
                onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
                className="flex-1"
              />
              {v.type === 'file' && (
                <span className="flex gap-0.5">
                  <FileAddon kind="file" onPick={(p) => setValues({ ...values, [v.name]: p })} />
                  <FileAddon kind="folder" onPick={(p) => setValues({ ...values, [v.name]: p })} />
                </span>
              )}
            </div>
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// -- drag & drop -----------------------------------------------------------------------

function EditorDnd({ children }: { children: React.ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const dragging = useDnd((s) => s.dragging);
  const index = useApp((s) => s.index);
  const variables = useFlowVariables();
  const pointer = useRef({ y: 0 });

  const computeTarget = useCallback((e: DragMoveEvent): DropTarget | null => {
    const over = e.over;
    const flow = useEditor.getState().flow;
    if (!over || !flow) return null;
    const data = over.data.current as DropData | undefined;
    const item = e.active.data.current as DragItem;
    let target: DropTarget | null = null;
    if (data?.kind === 'step') {
      const where = locate(flow, data.stepId);
      if (!where) return null;
      const start = e.activatorEvent as PointerEvent;
      pointer.current.y = (start?.clientY ?? 0) + e.delta.y;
      const after = pointer.current.y > over.rect.top + over.rect.height / 2;
      target = {
        listKey: listKey(where.ref),
        index: where.index + (after ? 1 : 0),
        stepId: data.stepId,
        side: after ? 'after' : 'before',
      };
    } else if (data?.kind === 'end') {
      const ref = parseListKey(data.listKey);
      target = { listKey: data.listKey, index: getList(flow, ref)?.length ?? 0 };
    } else if (data?.kind === 'slot') {
      target = { listKey: data.listKey, index: data.index };
    } else if (data?.kind === 'canvas' || data?.kind === 'link') {
      // Free connections: to the process's top level, at the pointer or on the connector.
      const { processId } = useEditor.getState();
      const root = rootRef(processId);
      target = { listKey: listKey(root), index: processSteps(flow, processId).length };
      if (data.kind === 'link') target.link = data.link;
      else {
        const start = e.activatorEvent as PointerEvent;
        const point = { x: (start?.clientX ?? 0) + e.delta.x, y: (start?.clientY ?? 0) + e.delta.y };
        const at = useDnd.getState().chartPoint?.(point);
        if (at) target.at = at;
      }
    }
    if (target && item.kind === 'step') {
      // A step can't be dropped inside itself.
      const ref = parseListKey(target.listKey);
      let parent = ref.parentId;
      while (parent) {
        if (parent === item.stepId) return null;
        parent = locate(flow, parent)?.ref.parentId ?? null;
      }
    }
    return target;
  }, []);

  const onEnd = (e: DragEndEvent) => {
    const target = computeTarget(e);
    const item = e.active.data.current as DragItem;
    useDnd.getState().setDragging(null);
    useDnd.getState().setTarget(null);
    if (!target) return;
    const ref = parseListKey(target.listKey);
    const { change, select, processId } = useEditor.getState();
    // Free connections: where it was let go, or on the connector it was dropped on.
    const place = (f: Flow, id: string): Flow => {
      if (target.link) return insertOnLink(f, processId, target.link, findStep(f, id)!);
      if (target.at) {
        const { x = 0, y = 0 } = target.at;
        return setPosition(f, processId, id, { x: x - SIZES.node.w / 2, y: y - SIZES.node.h / 2 });
      }
      return f;
    };
    if (item.kind === 'new') {
      const def = index.get(item.activity);
      if (!def) return;
      const step = createStep(def, index, new Set(variables.map((v) => v.name)));
      change((f) => place(insertStep(f, ref, target.index, step), step.id));
      select(step.id);
    } else {
      change((f) => place(moveStep(f, item.stepId, ref, target.index), item.stepId));
      select(item.stepId);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={innermostUnderPointer}
      onDragStart={(e) => useDnd.getState().setDragging(e.active.data.current as DragItem)}
      onDragMove={(e) => useDnd.getState().setTarget(computeTarget(e))}
      onDragEnd={onEnd}
      onDragCancel={() => {
        useDnd.getState().setDragging(null);
        useDnd.getState().setTarget(null);
      }}
    >
      {children}
      <DragOverlay dropAnimation={null}>{dragging ? <DragGhost item={dragging} /> : null}</DragOverlay>
    </DndContext>
  );
}

function DragGhost({ item }: { item: DragItem }) {
  const index = useApp((s) => s.index);
  const flow = useEditor((s) => s.flow);
  const activity = item.kind === 'new' ? item.activity : flow ? findStep(flow, item.stepId)?.activity : undefined;
  const def = activity ? index.get(activity) : undefined;
  if (!def) return null;
  return (
    <div className={cn('flex w-72 items-center gap-2 rounded-lg border border-primary bg-surface p-2 shadow-pop')}>
      <IconTile name={def.icon} category={def.category} size="sm" />
      <span className="text-[13px] font-medium">{def.title}</span>
    </div>
  );
}

export type { Flow };
