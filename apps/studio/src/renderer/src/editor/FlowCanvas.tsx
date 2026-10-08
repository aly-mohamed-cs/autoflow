// The Flow view: the flow's steps as a left-to-right flowchart (n8n / Brity style).
// Positions come from lib/flowLayout.ts; React Flow does the canvas work (pan, zoom, minimap).
// Steps are added with the + on any connector, by dropping a step from the library onto a
// connector, or moved by dragging a card's grip onto another connector.
import type { Step } from '@autoflow/flow-types';
import { Badge, Button, categoryColor, cn, Icon, IconTile, Menu, Tooltip } from '@autoflow/ui';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { layoutFlow, SIZES, type LayoutEdge, type LayoutNode, type Slot } from '../lib/flowLayout';
import { findStep, parseListKey } from '../lib/flowOps';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { useRun } from '../store/run';
import { AddStepMenu } from './AddStepMenu';
import { useDnd } from './dnd';
import { useStepIssues } from './hooks';
import {
  RunStatusIcon,
  STATUS_STYLES,
  useAddStep,
  useSentenceText,
  useStepActions,
} from './stepParts';

type CanvasNode = Node<{ layout: LayoutNode }>;
type CanvasEdge = Edge<{ layout: LayoutEdge }>;

export function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <FlowChart />
    </ReactFlowProvider>
  );
}

function FlowChart() {
  const steps = useEditor((s) => s.flow?.steps);
  const flowId = useEditor((s) => s.flow?.id);
  const select = useEditor((s) => s.select);
  const index = useApp((s) => s.index);
  const theme = useApp((s) => s.theme);
  const { fitView, setViewport } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  const { nodes, edges, size } = useMemo(() => {
    const layout = layoutFlow(steps ?? [], (activity) => index.get(activity));
    const start = layout.nodes.find((n) => n.type === 'start')!;
    return {
      size: { w: layout.width, h: layout.height, startMid: start.y + start.h / 2 },
      nodes: layout.nodes.map((n): CanvasNode => ({
        id: n.id,
        type: n.type,
        position: { x: n.x, y: n.y },
        width: n.w,
        height: n.h,
        data: { layout: n },
        draggable: false,
        selectable: false,
        connectable: false,
        zIndex: n.type === 'container' ? n.depth * 2 : n.depth * 2 + 1,
      })),
      edges: layout.edges.map((e): CanvasEdge => ({
        id: e.id,
        type: e.kind,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: e.targetHandle,
        data: { layout: e },
        selectable: false,
        zIndex: e.depth * 2 + 1,
      })),
    };
  }, [steps, index]);

  // When a flow is opened (not on every edit: keep where the person is looking), show all of it
  // if it fits at a readable size, otherwise its beginning, Start on the left.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useEffect(() => {
    const t = setTimeout(() => {
      const rect = wrapper.current?.getBoundingClientRect();
      const { w, h, startMid } = sizeRef.current;
      if (!rect) return;
      const fit = Math.min((rect.width - 80) / w, (rect.height - 80) / h, 1);
      if (fit >= READABLE_ZOOM) {
        void fitView({ padding: 0.12, maxZoom: 1 });
      } else {
        const zoom = Math.max(READABLE_ZOOM, Math.min(1, (rect.height - 80) / h));
        void setViewport({ x: 40, y: rect.height / 2 - startMid * zoom, zoom });
      }
    }, 50);
    return () => clearTimeout(t);
  }, [flowId, fitView, setViewport]);

  useFollowRun(nodes);

  return (
    <div ref={wrapper} className="min-h-0 flex-1 bg-bg" data-testid="flow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={theme === 'system' ? 'system' : theme}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll
        zoomOnScroll={false}
        zoomActivationKeyCode={['Control', 'Meta']}
        minZoom={0.15}
        maxZoom={1.6}
        // Also what makes React Flow pass clicks to nodes (they are neither draggable nor selectable).
        onNodeClick={(_, node) => {
          const stepId = (node as CanvasNode).data.layout.stepId;
          if (stepId) select(stepId);
        }}
        onPaneClick={() => select(null)}
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          ariaLabel="Overview of the whole flow"
          style={{ width: 168, height: 96, background: 'var(--af-surface)' }}
          nodeColor={(n) => minimapColor(n as CanvasNode, index)}
          nodeStrokeWidth={0}
          maskColor="color-mix(in srgb, var(--af-bg) 70%, transparent)"
        />
      </ReactFlow>
    </div>
  );
}

/** During a test run, keep the running step in view. */
const READABLE_ZOOM = 0.75;

function useFollowRun(nodes: CanvasNode[]) {
  const current = useRun((s) => s.currentStepId);
  const { getViewport, setCenter } = useReactFlow();
  const box = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!current) return;
    const node = nodes.find((n) => n.data.layout.stepId === current && n.type !== 'anchor');
    if (!node) return;
    box.current ??= document.querySelector('[data-testid="flow-canvas"]');
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const { x, y, zoom } = getViewport();
    const l = node.data.layout;
    const cx = l.x + Math.min(l.w, SIZES.node.w) / 2;
    const cy = l.y + Math.min(l.h, SIZES.header) / 2;
    const sx = cx * zoom + x;
    const sy = cy * zoom + y;
    if (sx < 40 || sy < 40 || sx > rect.width - 40 || sy > rect.height - 40) {
      void setCenter(cx, cy, { zoom, duration: 300 });
    }
  }, [current, nodes, getViewport, setCenter]);
}

function minimapColor(
  node: CanvasNode,
  index: ReturnType<typeof useApp.getState>['index'],
): string {
  const l = node.data.layout;
  if (l.type === 'anchor' || l.type === 'merge') return 'transparent';
  if (l.type === 'start' || l.type === 'end') return 'var(--af-primary)';
  if (l.type === 'placeholder') return 'var(--af-border-strong)';
  const step = l.stepId ? findStep(useEditor.getState().flow!, l.stepId) : undefined;
  const color = categoryColor(step ? index.get(step.activity)?.category : undefined);
  return l.type === 'container' ? `color-mix(in srgb, ${color} 25%, transparent)` : color;
}

// -- nodes -------------------------------------------------------------------------------

function useStep(stepId: string | undefined): Step | undefined {
  return useEditor((s) => (s.flow && stepId ? findStep(s.flow, stepId) : undefined));
}

const hidden = '!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent';

const StepNode = memo(function StepNode({ data }: NodeProps<CanvasNode>) {
  const l = data.layout;
  const step = useStep(l.stepId);
  if (!step) return null;
  return <StepCard step={step} width={l.w} height={l.h} branch={l.type === 'branch'} />;
});

function StepCard({
  step,
  width,
  height,
  branch,
}: {
  step: Step;
  width: number;
  height: number;
  branch: boolean;
}) {
  const def = useApp((s) => s.index.get(step.activity));
  const select = useEditor((s) => s.select);
  const runStatus = useRun((s) => s.stepStatus[step.id]);
  const paused = useRun((s) => s.pausedStepId === step.id);
  const issues = useStepIssues(step.id);
  const text = useSentenceText(step, def);
  const { items, breakpoint, toggleBreak, selected } = useStepActions(step);
  const drag = useDraggable({ id: `step:${step.id}`, data: { kind: 'step', stepId: step.id } });
  const errors = issues.filter((i) => i.severity === 'error').length;
  const title = step.label || def?.title || step.activity;

  return (
    <div
      ref={drag.setNodeRef}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={def?.title ?? step.activity}
      data-step-id={step.id}
      title={text}
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
      style={{ width, height }}
      className={cn(
        'group relative flex cursor-pointer items-center gap-2.5 rounded-xl border bg-surface pr-2 pl-2.5 text-left shadow-card transition-[box-shadow,border-color,opacity] outline-none',
        step.activity === 'control.comment' && 'border-dashed bg-warning-soft/40',
        selected
          ? 'border-primary ring-2 ring-primary/25'
          : 'border-border hover:border-border-strong hover:shadow-pop',
        runStatus && STATUS_STYLES[runStatus],
        paused && 'border-warning ring-2 ring-warning/30',
        step.disabled && 'opacity-55',
        drag.isDragging && 'opacity-40',
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className={hidden}
        isConnectable={false}
      />
      {breakpoint && (
        <span
          className="absolute -top-1.5 -left-1.5 h-3 w-3 rounded-full border-2 border-surface bg-danger"
          title="Testing pauses here"
        />
      )}
      <IconTile name={def?.icon ?? 'circle-help'} category={def?.category} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] leading-5 font-semibold">{title}</p>
        <p className="line-clamp-2 text-[11.5px] leading-[15px] text-muted">
          {def ? text : `Unknown step “${step.activity}”`}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 self-stretch py-1.5">
        <span className="nodrag nopan" onClick={(e) => e.stopPropagation()}>
          <Menu
            trigger={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Step actions"
                className="h-6 w-6 opacity-50 group-hover:opacity-100"
              >
                <Icon name="ellipsis" size={14} />
              </Button>
            }
            items={items}
          />
        </span>
        <span className="flex-1" />
        <RunStatusIcon status={runStatus} paused={paused} />
      </div>
      <button
        type="button"
        aria-label="Drag to move"
        className="nodrag nopan absolute -top-2.5 left-1/2 hidden -translate-x-1/2 cursor-grab rounded border border-border bg-surface px-1 text-subtle shadow-sm group-hover:block active:cursor-grabbing"
        {...drag.listeners}
        {...drag.attributes}
        onClick={(e) => e.stopPropagation()}
      >
        <Icon name="grip-horizontal" size={12} />
      </button>
      {(errors > 0 || step.disabled) && (
        <span className="absolute -bottom-2.5 left-3 flex gap-1">
          {errors > 0 && (
            <Badge tone="danger">{errors === 1 ? '1 to fix' : `${errors} to fix`}</Badge>
          )}
          {step.disabled && <Badge>skipped</Badge>}
        </span>
      )}
      <Tooltip content={breakpoint ? 'Remove pause point' : 'Pause here when testing (F9)'}>
        <button
          type="button"
          aria-label={breakpoint ? 'Remove pause point' : 'Add pause point'}
          onClick={(e) => {
            e.stopPropagation();
            toggleBreak();
          }}
          className="nodrag nopan absolute -bottom-1.5 left-1/2 hidden h-3 w-3 -translate-x-1/2 rounded-full border-2 border-border-strong bg-surface group-hover:block"
        />
      </Tooltip>
      {branch ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="yes"
            style={{ top: '30%' }}
            className={hidden}
            isConnectable={false}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="no"
            style={{ top: '70%' }}
            className={hidden}
            isConnectable={false}
          />
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          className={hidden}
          isConnectable={false}
        />
      )}
    </div>
  );
}

const ContainerNode = memo(function ContainerNode({ data }: NodeProps<CanvasNode>) {
  const l = data.layout;
  const step = useStep(l.stepId);
  const def = useApp((s) => (step ? s.index.get(step.activity) : undefined));
  const select = useEditor((s) => s.select);
  const runStatus = useRun((s) => (step ? s.stepStatus[step.id] : undefined));
  const paused = useRun((s) => !!step && s.pausedStepId === step.id);
  const text = useSentenceText(step ?? { id: '', activity: '', params: {} }, def);
  const actions = useStepActions(step ?? { id: '', activity: '', params: {} });
  const drag = useDraggable({
    id: `step:${step?.id ?? l.id}`,
    data: { kind: 'step', stepId: step?.id ?? '' },
  });
  if (!step) return null;
  const color = categoryColor(def?.category);

  return (
    <div
      style={{
        width: l.w,
        height: l.h,
        background: `color-mix(in srgb, ${color} 6%, var(--af-surface))`,
        borderColor: actions.selected
          ? undefined
          : `color-mix(in srgb, ${color} 40%, var(--af-border))`,
      }}
      className={cn(
        'relative rounded-2xl border-2',
        actions.selected && 'border-primary ring-2 ring-primary/25',
        runStatus && STATUS_STYLES[runStatus],
        paused && 'border-warning',
        step.disabled && 'opacity-55',
        drag.isDragging && 'opacity-40',
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        style={{ top: SIZES.header / 2 }}
        className={hidden}
        isConnectable={false}
      />
      <div
        ref={drag.setNodeRef}
        role="button"
        tabIndex={0}
        aria-pressed={actions.selected}
        aria-label={def?.title ?? step.activity}
        data-step-id={step.id}
        title={text}
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
        style={{ height: SIZES.header }}
        className="group flex cursor-pointer items-center gap-2.5 rounded-t-2xl px-3 outline-none"
      >
        <IconTile name={def?.icon ?? 'repeat'} category={def?.category} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold">
            {l.loop && <Icon name="repeat" size={12} className="mr-1 inline text-muted" />}
            {step.label || def?.title}
          </p>
          <p className="truncate text-[11.5px] text-muted">{text}</p>
        </div>
        <RunStatusIcon status={runStatus} paused={paused} />
        <button
          type="button"
          aria-label="Drag to move"
          className="nodrag nopan hidden cursor-grab text-subtle group-hover:block active:cursor-grabbing"
          {...drag.listeners}
          {...drag.attributes}
          onClick={(e) => e.stopPropagation()}
        >
          <Icon name="grip-vertical" size={14} />
        </button>
        <span className="nodrag nopan" onClick={(e) => e.stopPropagation()}>
          <Menu
            trigger={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Step actions"
                className="opacity-60 group-hover:opacity-100"
              >
                <Icon name="ellipsis" size={15} />
              </Button>
            }
            items={actions.items}
          />
        </span>
      </div>
      {l.lanes?.map((lane) => (
        <p
          key={lane.title}
          className="absolute left-5 text-[11px] font-semibold tracking-wide text-subtle uppercase"
          style={{ top: lane.y + 4 }}
        >
          {lane.title}
        </p>
      ))}
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        style={{ top: SIZES.header / 2 }}
        className={hidden}
        isConnectable={false}
      />
    </div>
  );
});

function TerminalNode({ data }: NodeProps<CanvasNode>) {
  const start = data.layout.type === 'start';
  return (
    <div className="flex flex-col items-center" style={{ width: SIZES.terminal }}>
      <div
        className={cn(
          'flex items-center justify-center rounded-full border-2 shadow-card',
          start
            ? 'border-primary bg-primary text-[var(--af-on-primary)]'
            : 'border-border-strong bg-surface text-muted',
        )}
        style={{ width: SIZES.terminal, height: SIZES.terminal }}
      >
        <Icon name={start ? 'play' : 'flag'} size={20} />
      </div>
      <span className="mt-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">
        {start ? 'Start' : 'End'}
      </span>
      {start ? (
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          style={{ top: SIZES.terminal / 2 }}
          className={hidden}
          isConnectable={false}
        />
      ) : (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          style={{ top: SIZES.terminal / 2 }}
          className={hidden}
          isConnectable={false}
        />
      )}
    </div>
  );
}

function MergeNode() {
  return (
    <div className="h-full w-full rounded-full border-2 border-border-strong bg-surface">
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className={hidden}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className={hidden}
        isConnectable={false}
      />
    </div>
  );
}

function AnchorNode() {
  return (
    <div className="h-px w-px">
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className={hidden}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className={hidden}
        isConnectable={false}
      />
    </div>
  );
}

function PlaceholderNode({ data }: NodeProps<CanvasNode>) {
  const slot = data.layout.slot!;
  const { active, setNodeRef, dragging } = useSlot(slot);
  const add = useAddStep();
  const [open, setOpen] = useState(false);
  const empty = slot.listKey === 'root:steps';
  return (
    <div
      ref={setNodeRef}
      style={{ width: data.layout.w, height: data.layout.h }}
      className="nodrag nopan"
    >
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className={hidden}
        isConnectable={false}
      />
      <AddStepMenu
        open={open}
        onOpenChange={setOpen}
        onPick={(def) => {
          setOpen(false);
          add(def, parseListKey(slot.listKey), 0);
        }}
        trigger={
          <button
            type="button"
            className={cn(
              'flex h-full w-full items-center justify-center gap-1.5 rounded-xl border-2 border-dashed text-[13px] font-medium transition-colors',
              active
                ? 'border-primary bg-primary-soft text-primary'
                : dragging
                  ? 'border-primary/60 text-primary'
                  : 'border-border-strong bg-surface text-muted hover:border-primary hover:text-primary',
            )}
          >
            <Icon name="plus" size={15} />{' '}
            {active ? 'Drop here' : empty ? 'Add first step' : 'Add step'}
          </button>
        }
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className={hidden}
        isConnectable={false}
      />
    </div>
  );
}

// -- connectors ---------------------------------------------------------------------------

function useSlot(slot: Slot) {
  const id = `slot:${slot.listKey}:${slot.index}`;
  const drop = useDroppable({
    id,
    data: { kind: 'slot', listKey: slot.listKey, index: slot.index },
  });
  const dragging = useDnd((s) => s.dragging);
  const target = useDnd((s) => s.target);
  const active =
    !!target && !target.stepId && target.listKey === slot.listKey && target.index === slot.index;
  return { setNodeRef: drop.setNodeRef, active, dragging: !!dragging };
}

function FlowEdge(props: EdgeProps<CanvasEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } =
    props;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.35,
  });
  const layout = data!.layout;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: 'var(--af-border-strong)', strokeWidth: 2 }}
      />
      <EdgeLabelRenderer>
        {layout.label && (
          <span
            className={cn(
              'pointer-events-none absolute rounded-full px-1.5 text-[10.5px] leading-4 font-semibold',
              layout.label === 'Yes'
                ? 'bg-success-soft text-success'
                : 'bg-danger-soft text-danger',
            )}
            style={{
              transform: `translate(-50%, -50%) translate(${sourceX + 26}px, ${sourceY + (layout.label === 'Yes' ? -11 : 11)}px)`,
            }}
          >
            {layout.label}
          </span>
        )}
        {layout.slot && <InsertButton slot={layout.slot} x={labelX} y={labelY} />}
      </EdgeLabelRenderer>
    </>
  );
}

function InsertButton({ slot, x, y }: { slot: Slot; x: number; y: number }) {
  const { active, setNodeRef, dragging } = useSlot(slot);
  const add = useAddStep();
  const [open, setOpen] = useState(false);
  const size = dragging ? 30 : 22;
  return (
    // Positioned by the outer box: dnd-kit measures drop targets without their own transform.
    <div
      className="nodrag nopan absolute"
      style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, pointerEvents: 'all' }}
    >
      <div
        ref={setNodeRef}
        data-slot={`${slot.listKey}:${slot.index}`}
        style={{ width: size, height: size }}
      >
        <AddStepMenu
          open={open}
          onOpenChange={setOpen}
          onPick={(def) => {
            setOpen(false);
            add(def, parseListKey(slot.listKey), slot.index);
          }}
          trigger={
            <button
              type="button"
              aria-label="Add a step here"
              className={cn(
                'flex h-full w-full items-center justify-center rounded-full border shadow-sm transition-all',
                active
                  ? 'scale-125 border-primary bg-primary text-[var(--af-on-primary)]'
                  : dragging
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border-strong bg-surface text-muted hover:border-primary hover:text-primary',
              )}
            >
              <Icon name="plus" size={dragging ? 15 : 12} />
            </button>
          }
        />
      </div>
    </div>
  );
}

/** Loops: an arrow running under the lane, back from its end to its start. */
function LoopEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<CanvasEdge>) {
  const drop = data?.layout.drop ?? 40;
  const bottom = Math.max(sourceY, targetY) + drop;
  const r = 14;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `C ${sourceX + r * 1.6} ${sourceY}, ${sourceX + r * 1.6} ${bottom}, ${sourceX - r} ${bottom}`,
    `L ${targetX + r} ${bottom}`,
    `C ${targetX - r * 1.6} ${bottom}, ${targetX - r * 1.6} ${targetY}, ${targetX} ${targetY}`,
  ].join(' ');
  return (
    <>
      <BaseEdge
        path={path}
        style={{ stroke: 'var(--af-border-strong)', strokeWidth: 1.5, strokeDasharray: '5 4' }}
      />
      <EdgeLabelRenderer>
        <span
          className="pointer-events-none absolute flex items-center gap-1 rounded-full bg-surface px-1.5 text-[10.5px] text-subtle"
          style={{
            transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${bottom}px)`,
          }}
        >
          <Icon name="repeat" size={11} /> next
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

// Defined last: they refer to the components above.
const nodeTypes = {
  start: TerminalNode,
  end: TerminalNode,
  step: StepNode,
  branch: StepNode,
  container: ContainerNode,
  merge: MergeNode,
  anchor: AnchorNode,
  placeholder: PlaceholderNode,
};
const edgeTypes = { flow: FlowEdge, loop: LoopEdge };
