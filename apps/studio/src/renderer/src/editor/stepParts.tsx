// Pieces shared by the Flow view (FlowCanvas) and the List view (Canvas) of a flow's steps.
import type { ActivityDef, Step } from '@autoflow/flow-types';
import { cn, Icon, Spinner, Tooltip } from '@autoflow/ui';
import { createStep, exprLabel, sentence, type SentencePart } from '../lib/catalog';
import {
  duplicateStep,
  insertStep,
  locate,
  moveStep,
  removeStep,
  updateStep,
  type ListRef,
} from '../lib/flowOps';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { useRun, type StepRunStatus } from '../store/run';
import { Thumbnail } from './fields/ElementInput';
import { useElements, useFlowVariables } from './hooks';

/** Insert a new step from the catalog and select it. */
export function useAddStep() {
  const index = useApp((s) => s.index);
  const change = useEditor((s) => s.change);
  const select = useEditor((s) => s.select);
  const variables = useFlowVariables();
  return (def: ActivityDef, ref: ListRef, position: number) => {
    const step = createStep(def, index, new Set(variables.map((v) => v.name)));
    change((f) => insertStep(f, ref, position, step));
    select(step.id);
  };
}

export const STATUS_STYLES: Record<StepRunStatus, string> = {
  running: 'border-primary ring-2 ring-primary/25',
  ok: '',
  failed: 'border-danger ring-2 ring-danger/20',
  continued: 'border-warning',
  cancelled: '',
};

/** The step's ⋯ menu (duplicate, move, skip, pause point, delete) and its pause point. */
export function useStepActions(step: Step) {
  const selected = useEditor((s) => s.selectedId === step.id);
  const select = useEditor((s) => s.select);
  const change = useEditor((s) => s.change);
  const flowId = useEditor((s) => s.flow?.id ?? '');
  const breakpoint = useRun((s) => (s.breakpoints[flowId] ?? []).includes(step.id));
  const toggleBreakpoint = useRun((s) => s.toggleBreakpoint);

  const toggleBreak = () =>
    void window.autoflow.run.setBreakpoints(toggleBreakpoint(flowId, step.id));
  const duplicate = () => {
    let newId: string | null = null;
    change((f) => {
      const r = duplicateStep(f, step.id);
      newId = r.newId;
      return r.flow;
    });
    if (newId) select(newId);
  };
  const nudge = (delta: number) =>
    change((f) => {
      const where = locate(f, step.id);
      if (!where) return f;
      return moveStep(f, step.id, where.ref, where.index + (delta > 0 ? 2 : -1));
    });
  const remove = () => {
    change((f) => removeStep(f, step.id));
    if (selected) select(null);
  };

  const items = [
    {
      label: 'Duplicate',
      icon: <Icon name="copy" size={14} />,
      shortcut: 'Ctrl+D',
      onSelect: duplicate,
    },
    {
      label: 'Move earlier',
      icon: <Icon name="arrow-up" size={14} />,
      shortcut: 'Alt+↑',
      onSelect: () => nudge(-1),
    },
    {
      label: 'Move later',
      icon: <Icon name="arrow-down" size={14} />,
      shortcut: 'Alt+↓',
      onSelect: () => nudge(1),
    },
    {
      label: step.disabled ? 'Turn on' : 'Skip this step',
      icon: <Icon name={step.disabled ? 'eye' : 'eye-off'} size={14} />,
      onSelect: () =>
        change((f) => updateStep(f, step.id, (s) => ({ ...s, disabled: !step.disabled }))),
    },
    {
      label: breakpoint ? 'Remove pause point' : 'Pause here when testing',
      icon: <Icon name="circle-pause" size={14} />,
      shortcut: 'F9',
      onSelect: toggleBreak,
    },
    'separator' as const,
    {
      label: 'Delete',
      icon: <Icon name="trash" size={14} />,
      shortcut: 'Del',
      danger: true,
      onSelect: remove,
    },
  ];
  return { items, breakpoint, toggleBreak, selected };
}

export function RunStatusIcon({ status, paused }: { status?: StepRunStatus; paused: boolean }) {
  if (paused)
    return (
      <Tooltip content="Paused at this step">
        <Icon name="circle-pause" size={16} className="text-warning" />
      </Tooltip>
    );
  switch (status) {
    case 'running':
      return <Spinner className="text-primary" />;
    case 'ok':
      return <Icon name="circle-check" size={16} className="text-success" aria-label="Done" />;
    case 'failed':
      return <Icon name="circle-x" size={16} className="text-danger" aria-label="Failed" />;
    case 'continued':
      return (
        <Tooltip content="Failed, but the automation continued">
          <Icon name="circle-alert" size={16} className="text-warning" />
        </Tooltip>
      );
    default:
      return null;
  }
}

/** The step as a sentence: "Type [row › Name] into [Name box]". */
export function StepSentence({ step, def }: { step: Step; def: ActivityDef }) {
  const index = useApp((s) => s.index);
  const elements = useElements();
  if (step.label) {
    return (
      <p className="leading-6">
        <span className="font-medium">{step.label}</span>
        <span className="ml-2 text-xs text-subtle">{def.title}</span>
      </p>
    );
  }
  const parts = sentence(step, def, { index, elements });
  return (
    <p className="leading-6 text-fg">
      {parts.map((p, i) =>
        p.kind === 'text' ? <span key={i}>{p.text}</span> : <ValueChip key={i} part={p} />,
      )}
    </p>
  );
}

/** The same sentence as plain text (for compact cards and tooltips). */
export function useSentenceText(step: Step, def: ActivityDef | undefined): string {
  const index = useApp((s) => s.index);
  const elements = useElements();
  if (!def) return step.activity;
  return sentence(step, def, { index, elements })
    .map((p) => {
      if (p.kind === 'text') return p.text;
      if (p.empty) return p.fallback && !p.required ? p.fallback : `[${p.title.toLowerCase()}]`;
      if (p.element) return p.element.name;
      return p.segments
        .map((seg) => (seg.kind === 'text' ? seg.text : exprLabel(seg.expr).label))
        .join('');
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function ValueChip({ part }: { part: Extract<SentencePart, { kind: 'value' }> }) {
  if (part.empty && part.fallback && !part.required) {
    return <span className="mx-0.5 text-muted">{part.fallback}</span>;
  }
  if (part.empty) {
    return (
      <span
        className={cn(
          'mx-0.5 rounded border border-dashed px-1.5 text-[13px] italic',
          part.required ? 'border-danger/50 text-danger' : 'border-border-strong text-subtle',
        )}
      >
        {part.title.toLowerCase()}
      </span>
    );
  }
  if (part.element) {
    return (
      <span className="mx-0.5 inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 align-middle text-[13px] font-medium">
        {part.element.screenshot ? (
          <Thumbnail element={part.element} size={14} />
        ) : (
          <Icon name="mouse-pointer-2" size={12} className="text-subtle" />
        )}
        {part.element.name}
      </span>
    );
  }
  return (
    <span className="mx-0.5 font-medium">
      {part.segments.map((seg, i) =>
        seg.kind === 'text' ? <span key={i}>{seg.text}</span> : <VarChip key={i} expr={seg.expr} />,
      )}
    </span>
  );
}

function VarChip({ expr }: { expr: string }) {
  const { label, formula } = exprLabel(expr);
  return (
    <span
      title={formula ? `Formula: ${expr}` : undefined}
      className={cn(
        'mx-0.5 inline-block max-w-56 truncate rounded-full px-2 align-middle text-xs leading-5 font-medium',
        formula ? 'bg-warning-soft text-warning' : 'bg-primary-soft text-primary',
      )}
    >
      {formula ? `ƒ ${label}` : label}
    </span>
  );
}
