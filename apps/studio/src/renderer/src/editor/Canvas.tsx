import type { ActivityDef, Step } from '@autoflow/flow-types';
import { Badge, Button, categoryColor, cn, EmptyState, Icon, IconTile, Menu, Segmented, Tooltip } from '@autoflow/ui';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { memo, useState } from 'react';
import { listKey, ROOT, type ListRef } from '../lib/flowOps';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { useRun } from '../store/run';
import { AddStepMenu } from './AddStepMenu';
import { useDnd } from './dnd';
import { FlowCanvas } from './FlowCanvas';
import { useStepIssues } from './hooks';
import { RunStatusIcon, STATUS_STYLES, StepSentence, useAddStep, useStepActions } from './stepParts';

export { useAddStep } from './stepParts';

type View = 'flow' | 'list';
const VIEW_KEY = 'autoflow.editorView';

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'flow';
  } catch {
    return 'flow';
  }
}

/** The steps of the open flow: a flowchart (default) or a compact list. */
export function Canvas() {
  const [view, setView] = useState<View>(savedView);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="absolute top-3 right-3 z-20">
        <Segmented
          size="sm"
          value={view}
          onChange={(v) => {
            setView(v as View);
            try {
              localStorage.setItem(VIEW_KEY, v);
            } catch {
              /* private window: the choice just isn't remembered */
            }
          }}
          options={[
            { value: 'flow', label: 'Flow' },
            { value: 'list', label: 'List' },
          ]}
          aria-label="How to show the steps"
        />
      </div>
      {view === 'flow' ? <FlowCanvas /> : <ListCanvas />}
    </div>
  );
}

function ListCanvas() {
  const steps = useEditor((s) => s.flow?.steps ?? []);
  const select = useEditor((s) => s.select);
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto bg-bg"
      onClick={(e) => {
        if (e.target === e.currentTarget) select(null);
      }}
    >
      <div className="mx-auto max-w-3xl px-6 pt-14 pb-40" onClick={(e) => e.target === e.currentTarget && select(null)}>
        {steps.length === 0 ? <EmptyCanvas /> : <StepList steps={steps} listRef={ROOT} />}
      </div>
    </div>
  );
}

function EmptyCanvas() {
  const [open, setOpen] = useState(false);
  const add = useAddStep();
  return (
    <EndZone listRef={ROOT} big>
      <EmptyState
        icon={<Icon name="mouse-pointer-click" size={32} />}
        title="Add the first step"
        action={
          <AddStepMenu
            open={open}
            onOpenChange={setOpen}
            onPick={(def) => {
              setOpen(false);
              add(def, ROOT, 0);
            }}
            trigger={
              <Button variant="primary" icon={<Icon name="plus" size={16} />}>
                Add a step
              </Button>
            }
          />
        }
      >
        Drag a step from the left panel, or search for what should happen first — like “Open browser” or “Read Excel
        sheet”.
      </EmptyState>
    </EndZone>
  );
}

function StepList({ steps, listRef }: { steps: Step[]; listRef: ListRef }) {
  return (
    <ol className="af-step-list space-y-2" aria-label="Steps">
      {steps.map((step, i) => (
        <StepItem key={step.id} step={step} listRef={listRef} index={i} />
      ))}
    </ol>
  );
}

const StepItem = memo(function StepItem({ step, listRef, index }: { step: Step; listRef: ListRef; index: number }) {
  const def = useApp((s) => s.index.get(step.activity));
  const [collapsed, setCollapsed] = useState(false);
  const blocks = def?.blocks ?? [];

  return (
    <li className="relative">
      <StepRow step={step} def={def} listRef={listRef} index={index} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      {!collapsed && blocks.length > 0 && (
        <div
          className="mt-1.5 ml-[27px] space-y-2 border-l-2 pl-5"
          style={{ borderColor: `color-mix(in srgb, ${categoryColor(def?.category)} 35%, transparent)` }}
        >
          {blocks.map((block) => {
            const ref = { parentId: step.id, block: block.name };
            const children = step.blocks?.[block.name] ?? [];
            return (
              <section key={block.name} aria-label={block.title}>
                <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">{block.title}</p>
                {children.length > 0 && <StepList steps={children} listRef={ref} />}
                <EndZone listRef={ref} />
              </section>
            );
          })}
        </div>
      )}
    </li>
  );
});

function StepRow({
  step,
  def,
  listRef,
  index,
  collapsed,
  onToggle,
}: {
  step: Step;
  def: ActivityDef | undefined;
  listRef: ListRef;
  index: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const select = useEditor((s) => s.select);
  const runStatus = useRun((s) => s.stepStatus[step.id]);
  const paused = useRun((s) => s.pausedStepId === step.id);
  const issues = useStepIssues(step.id);
  const target = useDnd((s) => s.target);
  const add = useAddStep();
  const { items, breakpoint, toggleBreak, selected } = useStepActions(step);
  const [insertOpen, setInsertOpen] = useState(false);

  const drag = useDraggable({ id: `step:${step.id}`, data: { kind: 'step', stepId: step.id } });
  const drop = useDroppable({ id: `drop:${step.id}`, data: { kind: 'step', stepId: step.id } });

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  const isComment = step.activity === 'control.comment';
  const indicator = target?.stepId === step.id ? target.side : undefined;

  return (
    <div className="relative" ref={drop.setNodeRef}>
      {indicator === 'before' && <DropLine className="-top-[5px]" />}
      <div
        ref={drag.setNodeRef}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={def?.title ?? step.activity}
        data-step-id={step.id}
        onClick={(e) => {
          e.stopPropagation();
          select(step.id);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select(step.id);
          }
        }}
        className={cn(
          'group relative flex items-start gap-2 rounded-lg border bg-surface py-2 pr-2 pl-1 shadow-card transition-[box-shadow,border-color,opacity] outline-none',
          isComment && 'border-dashed bg-warning-soft/40',
          selected ? 'border-primary ring-2 ring-primary/25' : 'border-border hover:border-border-strong',
          runStatus && STATUS_STYLES[runStatus],
          paused && 'border-warning ring-2 ring-warning/30',
          step.disabled && 'opacity-55',
          drag.isDragging && 'opacity-40',
        )}
      >
        {/* gutter: pause point + drag handle */}
        <div className="flex w-6 shrink-0 flex-col items-center gap-1 pt-1.5">
          <Tooltip content={breakpoint ? 'Testing pauses before this step' : 'Pause here when testing (F9)'} side="left">
            <button
              type="button"
              aria-label={breakpoint ? 'Remove pause point' : 'Add pause point'}
              onClick={(e) => {
                e.stopPropagation();
                toggleBreak();
              }}
              className={cn(
                'h-3 w-3 rounded-full border-2 transition-opacity',
                breakpoint ? 'border-danger bg-danger opacity-100' : 'border-border-strong opacity-0 group-hover:opacity-100',
              )}
            />
          </Tooltip>
          <button
            type="button"
            aria-label="Drag to move"
            className="cursor-grab text-subtle opacity-0 group-hover:opacity-100 active:cursor-grabbing"
            {...drag.listeners}
            {...drag.attributes}
            onClick={(e) => e.stopPropagation()}
          >
            <Icon name="grip-vertical" size={14} />
          </button>
        </div>

        <IconTile name={def?.icon ?? 'circle-help'} category={def?.category} />

        <div className="min-w-0 flex-1 pt-0.5">
          {def ? (
            <StepSentence step={step} def={def} />
          ) : (
            <p className="text-danger">Unknown step “{step.activity}”</p>
          )}
          {(errors > 0 || warnings > 0 || step.disabled) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {errors > 0 && <Badge tone="danger">{errors === 1 ? '1 setting to fix' : `${errors} settings to fix`}</Badge>}
              {warnings > 0 && <Badge tone="warning">{warnings === 1 ? '1 warning' : `${warnings} warnings`}</Badge>}
              {step.disabled && <Badge>skipped</Badge>}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
          <RunStatusIcon status={runStatus} paused={paused} />
          {def && def.blocks.length > 0 && (
            <Button variant="ghost" size="icon-sm" aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
              <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={15} />
            </Button>
          )}
          <span onClick={(e) => e.stopPropagation()}>
            <Menu
              trigger={
                <Button variant="ghost" size="icon-sm" aria-label="Step actions" className="opacity-60 group-hover:opacity-100">
                  <Icon name="ellipsis" size={15} />
                </Button>
              }
              items={items}
            />
          </span>
        </div>

        {/* insert-after button on the bottom edge */}
        <span className="absolute -bottom-3 left-1/2 z-10 -translate-x-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100" onClick={(e) => e.stopPropagation()}>
          <AddStepMenu
            open={insertOpen}
            onOpenChange={setInsertOpen}
            onPick={(d) => {
              setInsertOpen(false);
              add(d, listRef, index + 1);
            }}
            trigger={
              <button
                type="button"
                aria-label="Add a step after this one"
                className="flex h-5 w-5 items-center justify-center rounded-full border border-border-strong bg-surface text-muted shadow-sm hover:border-primary hover:text-primary"
              >
                <Icon name="plus" size={12} />
              </button>
            }
          />
        </span>
      </div>
      {indicator === 'after' && <DropLine className="-bottom-[5px]" />}
    </div>
  );
}

function DropLine({ className }: { className?: string }) {
  return (
    <div className={cn('pointer-events-none absolute right-0 left-0 z-20 h-[3px] rounded-full bg-primary', className)}>
      <span className="absolute -top-[3px] -left-1 h-[9px] w-[9px] rounded-full border-2 border-primary bg-surface" />
    </div>
  );
}

/** Drop area and "Add step" button at the end of a list. */
function EndZone({ listRef, big, children }: { listRef: ListRef; big?: boolean; children?: React.ReactNode }) {
  const key = listKey(listRef);
  const drop = useDroppable({ id: `end:${key}`, data: { kind: 'end', listKey: key } });
  const target = useDnd((s) => s.target);
  const dragging = useDnd((s) => s.dragging);
  const active = target && !target.stepId && target.listKey === key;
  const add = useAddStep();
  const count = useEditor((s) => (s.flow ? (listRef.parentId === null ? s.flow.steps?.length ?? 0 : countIn(s.flow.steps ?? [], listRef)) : 0));
  const [open, setOpen] = useState(false);

  return (
    <div
      ref={drop.setNodeRef}
      className={cn(
        'mt-2 rounded-lg border-2 border-dashed transition-colors',
        big ? 'border-border-strong bg-surface' : 'border-transparent',
        dragging && !big && 'border-border-strong',
        active && 'border-primary bg-primary-soft',
      )}
    >
      {children ?? (
        <AddStepMenu
          open={open}
          onOpenChange={setOpen}
          onPick={(def) => {
            setOpen(false);
            add(def, listRef, count);
          }}
          trigger={
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-subtle hover:bg-surface hover:text-primary"
            >
              <Icon name="plus" size={14} /> {active ? 'Drop here' : 'Add step'}
            </button>
          }
        />
      )}
    </div>
  );
}

function countIn(steps: Step[], ref: ListRef): number {
  for (const s of steps) {
    if (s.id === ref.parentId) return s.blocks?.[ref.block]?.length ?? 0;
    for (const children of Object.values(s.blocks ?? {})) {
      const n = countIn(children, ref);
      if (n >= 0) return n;
    }
  }
  return -1;
}
