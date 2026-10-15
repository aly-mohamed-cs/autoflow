// The Flow view: a process's steps as a flowchart (n8n / Brity style), left to right or top
// to bottom. Positions come from lib/flowLayout.ts; React Flow does the canvas work (pan,
// zoom, minimap, dragging).
// Steps are added with the + on any connector or by dropping a step from the library onto a
// connector. Dragging a card moves it on the chart; letting go of it on a + moves it to that
// place in the run order instead.
import { walkSteps, type ActivityDef, type Flow, type Flowchart, type Link, type Step } from '@autoflow/flow-types';
import {
  Badge,
  Button,
  categoryColor,
  cn,
  Icon,
  IconTile,
  Menu,
  Segmented,
  Switch,
  Tooltip,
} from '@autoflow/ui';
import { useDroppable } from '@dnd-kit/core';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
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
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createStep } from '../lib/catalog';
import {
  blockSizes,
  CHART_GAP,
  chartOf,
  connect,
  DECISION,
  disconnect,
  insertOnLink,
  reachable,
  setChart,
  setPosition,
  START,
  tidyPositions,
  toFlowchart,
  toSequence,
  type Port,
} from '../lib/flowchart';
import {
  layoutBlock,
  layoutFlow,
  nodesMovingWith,
  SIZES,
  type Direction,
  type LayoutEdge,
  type LayoutNode,
  type Slot,
} from '../lib/flowLayout';
import {
  findStep,
  flatIds,
  insertStep,
  moveOnChart,
  moveStep,
  parseListKey,
  processOfStep,
  processSteps,
  rootRef,
  tidyChart,
  toggleCollapsed,
  topLevelSteps,
} from '../lib/flowOps';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { useRun } from '../store/run';
import { AddStepMenu } from './AddStepMenu';
import { useDnd } from './dnd';
import { useFlowVariables, useStepIssues } from './hooks';
import {
  RunStatusIcon,
  STATUS_STYLES,
  useAddStep,
  useSentenceText,
  useStepActions,
} from './stepParts';

type CanvasNode = Node<{ layout: LayoutNode }>;
type CanvasEdge = Edge<{ layout: LayoutEdge }>;

/** Moves snap to this grid (relative to the tidy place), so steps line up easily. */
const SNAP = 12;
const READABLE_ZOOM = 0.75;

const DirectionContext = createContext<Direction>('horizontal');

/** Where connectors enter and leave a node for the chart's direction. */
function useSides() {
  const vertical = useContext(DirectionContext) === 'vertical';
  return {
    vertical,
    in: vertical ? Position.Top : Position.Left,
    out: vertical ? Position.Bottom : Position.Right,
  };
}

/** Offsets keys of a process's start and end (each sub-process has its own). */
function terminalPrefix(processId: string | null): string {
  return processId ? `@${processId}:` : '';
}

export function FlowCanvas() {
  // A process with free connections is drawn as placed and connected by hand; otherwise tidily.
  const free = useEditor((s) => !!s.flow && !!chartOf(s.flow, s.processId));
  return <ReactFlowProvider>{free ? <FreeChart /> : <FlowChart />}</ReactFlowProvider>;
}

/** Shift + drag on an empty spot draws a box: the steps it touches get selected. */
function useBoxSelect(wrapper: React.RefObject<HTMLDivElement | null>, layoutNodes: LayoutNode[]) {
  const { screenToFlowPosition } = useReactFlow();
  const [shiftHeld, setShiftHeld] = useState(false);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const justDrawn = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setShiftHeld(e.shiftKey);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);
  const handlers = {
    onPointerDownCapture: (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const onPane = target.closest('.react-flow__pane') && !target.closest('.react-flow__node');
      if (!e.shiftKey || e.button !== 0 || !onPane) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setBox({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (box) setBox({ ...box, x1: e.clientX, y1: e.clientY });
    },
    onPointerUp: () => {
      if (!box) return;
      const a = screenToFlowPosition({ x: Math.min(box.x0, box.x1), y: Math.min(box.y0, box.y1) });
      const b = screenToFlowPosition({ x: Math.max(box.x0, box.x1), y: Math.max(box.y0, box.y1) });
      const ids = layoutNodes
        .filter((n) => n.stepId && n.x < b.x && n.x + n.w > a.x && n.y < b.y && n.y + n.h > a.y)
        .map((n) => n.stepId!);
      justDrawn.current = true;
      setBox(null);
      useEditor.getState().selectMany([...new Set(ids)]);
    },
  };
  const rect = wrapper.current?.getBoundingClientRect();
  const overlay =
    box && rect ? (
      <div
        aria-hidden
        className="pointer-events-none absolute z-50 rounded border border-primary bg-primary/10"
        style={{
          left: Math.min(box.x0, box.x1) - rect.left,
          top: Math.min(box.y0, box.y1) - rect.top,
          width: Math.abs(box.x1 - box.x0),
          height: Math.abs(box.y1 - box.y0),
        }}
      />
    ) : null;
  return {
    handlers,
    overlay,
    shiftHeld,
    /** A box was just drawn (the click that ends it must not clear the selection). */
    justDrawn: () => {
      const was = justDrawn.current;
      justDrawn.current = false;
      return was;
    },
  };
}

interface Drag {
  /** Offsets keys of everything being moved (the grabbed step, or all selected ones). */
  keys: string[];
  nodeId: string;
  /** Set when one step is dragged: letting go of it on a + changes the order. */
  stepId?: string;
  moving: Set<string>;
  /** The + under the pointer during the last move, if any. */
  slot?: Slot | null;
  origin: { x: number; y: number };
  dx: number;
  dy: number;
}

function FlowChart() {
  const processId = useEditor((s) => s.processId);
  const steps = useEditor((s) => (s.flow ? processSteps(s.flow, s.processId) : undefined));
  const offsets = useEditor((s) => s.flow?.layout?.offsets);
  const direction: Direction = useEditor((s) => s.flow?.layout?.direction ?? 'horizontal');
  const flowId = useEditor((s) => s.flow?.id);
  const select = useEditor((s) => s.select);
  const change = useEditor((s) => s.change);
  const index = useApp((s) => s.index);
  const theme = useApp((s) => s.theme);
  const { fitView, setViewport } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  // The drag lives in a ref for the handlers (React Flow may call ones from an earlier render)
  // and in state for drawing.
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDragState(next);
  };

  const collapsed = useEditor((s) => s.flow?.layout?.collapsed);
  const layout = useMemo(
    () =>
      layoutFlow(steps ?? [], (activity) => index.get(activity), {
        direction,
        root: rootRef(processId),
        offsets,
        terminalPrefix: terminalPrefix(processId),
        collapsed,
      }),
    [steps, index, direction, processId, offsets, collapsed],
  );

  const { nodes, edges } = useMemo(
    () => ({
      nodes: layout.nodes.map((n): CanvasNode => {
        const moved = drag?.moving.has(n.id);
        return {
          id: n.id,
          type: n.type,
          position: { x: n.x + (moved ? drag!.dx : 0), y: n.y + (moved ? drag!.dy : 0) },
          width: n.w,
          height: n.h,
          data: { layout: n },
          draggable: !!n.moveKey,
          selectable: false,
          connectable: false,
          zIndex: (n.type === 'container' ? n.depth * 2 : n.depth * 2 + 1) + (moved ? 1000 : 0),
        };
      }),
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
    }),
    [layout, drag],
  );

  // When a flow or process is opened (not on every edit: keep where the person is looking),
  // show all of it if it fits at a readable size, otherwise its beginning.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    const t = setTimeout(() => {
      const rect = wrapper.current?.getBoundingClientRect();
      const { bounds, nodes: all, direction: dir } = layoutRef.current;
      const start = all.find((n) => n.type === 'start')!;
      if (!rect || !start) return;
      const fit = Math.min((rect.width - 80) / bounds.w, (rect.height - 80) / bounds.h, 1);
      if (fit >= READABLE_ZOOM) {
        void fitView({ padding: 0.12, maxZoom: 1 });
      } else if (dir === 'vertical') {
        const zoom = Math.max(READABLE_ZOOM, Math.min(1, (rect.width - 80) / bounds.w));
        void setViewport({
          x: rect.width / 2 - (start.x + start.w / 2) * zoom,
          y: 40 - start.y * zoom,
          zoom,
        });
      } else {
        const zoom = Math.max(READABLE_ZOOM, Math.min(1, (rect.height - 80) / bounds.h));
        void setViewport({
          x: 40 - start.x * zoom,
          y: rect.height / 2 - (start.y + start.h / 2) * zoom,
          zoom,
        });
      }
    }, 50);
    return () => clearTimeout(t);
  }, [flowId, processId, direction, fitView, setViewport]);

  useFollowRun(nodes);
  useReveal(layout);
  const box = useBoxSelect(wrapper, layout.nodes);

  /** The + (or empty lane) under the pointer, if any. */
  const slotAt = (e: MouseEvent | TouchEvent): Slot | null => {
    const point = 'touches' in e ? (e.changedTouches[0] ?? e.touches[0]) : e;
    if (!point) return null;
    for (const el of document.elementsFromPoint(point.clientX, point.clientY)) {
      const key = (el as HTMLElement).closest?.('[data-slot]')?.getAttribute('data-slot');
      if (!key) continue;
      const i = key.lastIndexOf(':');
      return { listKey: key.slice(0, i), index: Number(key.slice(i + 1)) };
    }
    return null;
  };

  return (
    <DirectionContext.Provider value={direction}>
      <div
        ref={wrapper}
        className="relative min-h-0 flex-1 bg-bg"
        data-testid="flow-canvas"
        data-direction={direction}
        {...box.handlers}
      >
        {box.overlay}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={theme === 'system' ? 'system' : theme}
          nodesConnectable={false}
          elementsSelectable={false}
          nodeDragThreshold={4}
          panOnScroll
          zoomOnScroll={false}
          zoomActivationKeyCode={['Control', 'Meta']}
          minZoom={0.15}
          maxZoom={1.6}
          onNodeDragStart={(_, node) => {
            const l = (node as CanvasNode).data.layout;
            if (!l.moveKey) return;
            // Grabbing one of several selected steps moves them all (only the outermost ones get
            // an offset: what is inside a box moves with it).
            const { flow, selectedIds } = useEditor.getState();
            const keys =
              l.stepId && selectedIds.length > 1 && selectedIds.includes(l.stepId) && flow
                ? topLevelSteps(flow, selectedIds).map((s) => s.id)
                : [l.moveKey];
            const moving = new Set<string>();
            for (const key of keys) {
              for (const id of nodesMovingWith(layoutRef.current, steps ?? [], key)) moving.add(id);
            }
            setDrag({
              keys,
              nodeId: node.id,
              stepId: keys.length === 1 ? l.stepId : undefined,
              moving,
              origin: { x: l.x, y: l.y },
              dx: 0,
              dy: 0,
            });
            if (l.stepId) useDnd.getState().setDragging({ kind: 'step', stepId: l.stepId });
          }}
          onNodeDrag={(e, node) => {
            const d = dragRef.current;
            if (!d) return;
            // The + under the pointer is highlighted, and is where the step goes when let go.
            const slot = d.stepId ? slotAt(e) : null;
            setDrag({
              ...d,
              dx: Math.round((node.position.x - d.origin.x) / SNAP) * SNAP,
              dy: Math.round((node.position.y - d.origin.y) / SNAP) * SNAP,
              slot,
            });
            if (d.stepId) {
              useDnd
                .getState()
                .setTarget(slot ? { listKey: slot.listKey, index: slot.index } : null);
            }
          }}
          onNodeDragStop={(e, node) => {
            const d = dragRef.current;
            setDrag(null);
            useDnd.getState().setDragging(null);
            useDnd.getState().setTarget(null);
            if (!d) return;
            const slot = d.stepId ? (slotAt(e) ?? d.slot ?? null) : null;
            if (slot && d.stepId) {
              // Let go on a +: the step moves to that place in the run order, tidily.
              const stepId = d.stepId;
              change((f) =>
                moveStep(tidyChart(f, [stepId]), stepId, parseListKey(slot.listKey), slot.index),
              );
              return;
            }
            const dx = Math.round((node.position.x - d.origin.x) / SNAP) * SNAP;
            const dy = Math.round((node.position.y - d.origin.y) / SNAP) * SNAP;
            if (dx || dy)
              change((f) => d.keys.reduce((acc, key) => moveOnChart(acc, key, dx, dy), f));
          }}
          // Also what makes React Flow pass clicks to nodes (they are not selectable).
          onNodeClick={(e, node) => {
            const stepId = (node as CanvasNode).data.layout.stepId;
            if (!stepId) return;
            if (e.ctrlKey || e.metaKey) useEditor.getState().toggleSelect(stepId);
            else select(stepId);
          }}
          onPaneClick={() => {
            if (!box.justDrawn()) select(null);
          }}
          panOnDrag={!box.shiftHeld}
          selectionKeyCode={null}
          deleteKeyCode={null}
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
    </DirectionContext.Provider>
  );
}

/** Left to right / top to bottom, and "Tidy up" (forget the moves made in this process). */
export function LayoutControls() {
  const flow = useEditor((s) => s.flow);
  const processId = useEditor((s) => s.processId);
  const change = useEditor((s) => s.change);
  const direction = flow?.layout?.direction ?? 'horizontal';
  const keys = useMemo(
    () =>
      flow
        ? [
            ...flatIds(flow, processId),
            `${terminalPrefix(processId)}start`,
            `${terminalPrefix(processId)}end`,
          ]
        : [],
    [flow, processId],
  );
  const offsets = flow?.layout?.offsets;
  const moved = !!offsets && keys.some((k) => k in offsets);
  const index = useApp((s) => s.index);
  const toast = useApp((s) => s.toast);
  const free = !!flow && !!chartOf(flow, processId);

  /** Free connections: steps in the order they run, in a line (sizes as they are drawn). */
  const arrange = (f: Flow, vertical: boolean): Flow => {
    const chart = chartOf(f, processId);
    if (!chart) return f;
    const steps = processSteps(f, processId);
    const sizes = new Map(
      steps.map((s) => {
        const b = layoutBlock(s, (a) => index.get(a), { direction: vertical ? 'vertical' : 'horizontal', collapsed: f.layout?.collapsed });
        return [s.id, { w: b.w, h: b.h }] as const;
      }),
    );
    return setChart(f, processId, { ...chart, positions: tidyPositions(steps, chart, vertical, (id) => sizes.get(id)) });
  };

  const toggleFree = (on: boolean) => {
    if (on) {
      change((f) => arrange(toFlowchart(f, processId, {}), direction === 'vertical'));
      toast('Free connections: drag from a step’s dot to the step that runs next.', 'info');
      return;
    }
    const result = flow ? toSequence(flow, processId) : null;
    if (result && 'error' in result) toast(result.error, 'error');
    else if (result) change(() => result.flow);
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip content="Connect steps by hand: drag from a step's dot to the step that runs next. Steps that are not connected don't run.">
        <label className="mr-1 flex cursor-pointer items-center gap-1.5 text-xs text-muted">
          <Switch checked={free} onChange={toggleFree} label="Free connections" />
          Free connections
        </label>
      </Tooltip>
      <Tooltip content={free ? 'Line the steps up in the order they run' : 'Put the steps back in tidy rows (the order does not change)'}>
        <Button
          size="sm"
          variant="ghost"
          disabled={!free && !moved}
          icon={<Icon name="wand-sparkles" size={14} />}
          onClick={() => change((f) => (free ? arrange(f, direction === 'vertical') : tidyChart(f, keys)))}
        >
          Tidy up
        </Button>
      </Tooltip>
      <Segmented
        size="sm"
        value={direction}
        onChange={(v) =>
          change((f) => {
            const next = { ...f, layout: { ...f.layout, direction: v as Direction, offsets: {} } };
            return free ? arrange(next, v === 'vertical') : next;
          })
        }
        options={[
          {
            value: 'horizontal',
            label: (
              <span className="flex items-center" title="Left to right">
                <Icon name="arrow-right" size={14} />
                <span className="sr-only">Left to right</span>
              </span>
            ),
          },
          {
            value: 'vertical',
            label: (
              <span className="flex items-center" title="Top to bottom">
                <Icon name="arrow-down" size={14} />
                <span className="sr-only">Top to bottom</span>
              </span>
            ),
          },
        ]}
        aria-label="Direction of the flowchart"
      />
    </div>
  );
}

/** Find (and the problems list) ask for a step to be shown: centre it if it is out of view. */
function useReveal(layout: { nodes: LayoutNode[] }) {
  const reveal = useEditor((s) => s.reveal);
  const { getViewport, setCenter } = useReactFlow();
  const nodesRef = useRef(layout.nodes);
  nodesRef.current = layout.nodes;
  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(() => {
      const node = nodesRef.current.find((n) => n.stepId === reveal.id);
      if (!node) return;
      const { zoom } = getViewport();
      void setCenter(
        node.x + Math.min(node.w, SIZES.node.w) / 2,
        node.y + Math.min(node.h, SIZES.header) / 2,
        { zoom: Math.max(zoom, READABLE_ZOOM), duration: 300 },
      );
    }, 80); // after a switch to another process has been drawn
    return () => clearTimeout(t);
  }, [reveal, getViewport, setCenter]);
}

/** Free connections: a step just added or chosen elsewhere that is out of view is brought into view. */
function useKeepSelectedInView(wrapper: React.RefObject<HTMLDivElement | null>, nodes: LayoutNode[]) {
  const selectedId = useEditor((s) => s.selectedId);
  const { getViewport, setCenter } = useReactFlow();
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    if (!selectedId) return;
    const t = setTimeout(() => {
      const node = nodesRef.current.find((n) => n.stepId === selectedId);
      const rect = wrapper.current?.getBoundingClientRect();
      if (!node || !rect) return;
      const { x, y, zoom } = getViewport();
      const left = node.x * zoom + x;
      const top = node.y * zoom + y;
      const visible = left >= 0 && top >= 0 && left + Math.min(node.w, SIZES.node.w) * zoom <= rect.width && top + Math.min(node.h, SIZES.header) * zoom <= rect.height;
      if (!visible) {
        void setCenter(node.x + Math.min(node.w, SIZES.node.w) / 2, node.y + Math.min(node.h, SIZES.header) / 2, {
          zoom: Math.max(zoom, READABLE_ZOOM),
          duration: 250,
        });
      }
    }, 60);
    return () => clearTimeout(t);
  }, [selectedId, getViewport, setCenter, wrapper]);
}

/** During a test run, keep the running step in view (switching to its process if needed). */
function useFollowRun(nodes: CanvasNode[]) {
  const current = useRun((s) => s.currentStepId);
  const { getViewport, setCenter } = useReactFlow();
  const box = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!current) return;
    const node = nodes.find((n) => n.data.layout.stepId === current);
    if (!node) {
      const { flow, processId, showProcess } = useEditor.getState();
      const home = flow ? processOfStep(flow, current) : undefined;
      if (home !== undefined && home !== processId) showProcess(home);
      return;
    }
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
/** Free connections: a dot connectors are drawn from / to. */
const dot = '!h-3.5 !w-3.5 !min-h-0 !min-w-0 !rounded-full !border-2 !bg-surface transition-transform hover:!scale-125';
const DOT_TONES: Record<string, string> = {
  in: '!border-border-strong',
  out: '!border-primary',
  yes: '!border-success',
  no: '!border-danger',
};
const PORT_TITLES: Record<string, string> = {
  in: 'Connect a step to this one',
  out: 'Drag to the step to run next',
  yes: 'Yes: drag to the step to run',
  no: 'No: drag to the step to run',
};

/** A connector end: hidden in the tidy chart, a dot to drag from / to with free connections. */
function Port({
  type,
  id,
  position,
  style,
  active,
}: {
  type: 'source' | 'target';
  id: string;
  position: Position;
  style?: React.CSSProperties;
  active?: boolean;
}) {
  return (
    <Handle
      type={type}
      position={position}
      id={id}
      style={style}
      className={active ? cn(dot, DOT_TONES[id] ?? DOT_TONES.out) : hidden}
      isConnectable={!!active}
      title={active ? PORT_TITLES[id] : undefined}
    />
  );
}

const StepNode = memo(function StepNode({ data }: NodeProps<CanvasNode>) {
  const l = data.layout;
  const step = useStep(l.stepId);
  if (!step) return null;
  return (
    <StepCard
      step={step}
      width={l.w}
      height={l.h}
      handles={l.handles}
      connectIn={l.connectIn}
      ports={l.ports}
      loose={l.loose}
    />
  );
});

function StepCard({
  step,
  width,
  height,
  handles,
  connectIn,
  ports,
  loose,
}: {
  step: Step;
  width: number;
  height: number;
  /** Decisions: one outgoing connector per lane (otherwise a single "out"). */
  handles?: string[];
  /** Free connections: connectors can be drawn to it / from these ways out. */
  connectIn?: boolean;
  ports?: string[];
  /** Free connections: nothing leads to it, so it doesn't run. */
  loose?: boolean;
}) {
  const def = useApp((s) => s.index.get(step.activity));
  const select = useEditor((s) => s.select);
  const runStatus = useRun((s) => s.stepStatus[step.id]);
  const paused = useRun((s) => s.pausedStepId === step.id);
  const issues = useStepIssues(step.id);
  const text = useSentenceText(step, def);
  const { items, breakpoint, toggleBreak, selected } = useStepActions(step);
  const sides = useSides();
  const errors = issues.filter((i) => i.severity === 'error').length;
  const title = step.label || def?.title || step.activity;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={def?.title ?? step.activity}
      data-step-id={step.id}
      title={text}
      onClick={(e) => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) useEditor.getState().toggleSelect(step.id);
        else select(step.id);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select(step.id);
        }
      }}
      style={{ width, height }}
      className={cn(
        'group relative flex cursor-grab items-center gap-2.5 rounded-xl border bg-surface pr-2 pl-2.5 text-left shadow-card transition-[box-shadow,border-color,opacity] outline-none active:cursor-grabbing',
        step.activity === 'control.comment' && 'border-dashed bg-warning-soft/40',
        selected
          ? 'border-primary ring-2 ring-primary/25'
          : 'border-border hover:border-border-strong hover:shadow-pop',
        runStatus && STATUS_STYLES[runStatus],
        paused && 'border-warning ring-2 ring-warning/30',
        step.disabled && 'opacity-55',
        loose && !selected && 'border-dashed opacity-80',
      )}
    >
      <Port type="target" position={sides.in} id="in" active={connectIn} />
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
      {(errors > 0 || step.disabled || loose) && (
        <span className="absolute -bottom-2.5 left-3 flex gap-1">
          {errors > 0 && (
            <Badge tone="danger">{errors === 1 ? '1 to fix' : `${errors} to fix`}</Badge>
          )}
          {step.disabled && <Badge>skipped</Badge>}
          {loose && <Badge>not connected</Badge>}
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
          className={cn(
            'nodrag nopan absolute hidden h-3 w-3 rounded-full border-2 border-border-strong bg-surface group-hover:block',
            sides.vertical
              ? 'top-1/2 -right-1.5 -translate-y-1/2'
              : '-bottom-1.5 left-1/2 -translate-x-1/2',
          )}
        />
      </Tooltip>
      {handles?.length ? (
        handles.map((id, i) => {
          // Spread the lanes' connectors along the side (If: at 30% and 70%).
          const at = `${handles.length === 2 ? (i === 0 ? 30 : 70) : Math.round(((i + 1) * 100) / (handles.length + 1))}%`;
          const free = ports?.includes(id);
          return (
            <span key={id}>
              <Port
                type="source"
                position={sides.out}
                id={id}
                style={sides.vertical ? { left: at } : { top: at }}
                active={free}
              />
              {free && (id === 'yes' || id === 'no') && (
                <span
                  className={cn(
                    'pointer-events-none absolute text-[10px] font-semibold',
                    id === 'yes' ? 'text-success' : 'text-danger',
                  )}
                  style={
                    sides.vertical
                      ? { left: at, bottom: -20, transform: 'translateX(4px)' }
                      : { top: at, right: -28, transform: 'translateY(-125%)' }
                  }
                >
                  {id === 'yes' ? 'Yes' : 'No'}
                </span>
              )}
            </span>
          );
        })
      ) : (
        <Port type="source" position={sides.out} id="out" active={ports?.includes('out')} />
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
  const sides = useSides();
  const change = useEditor((s) => s.change);
  if (!step) return null;
  const color = categoryColor(def?.category);
  const inside = [...walkSteps(Object.values(step.blocks ?? {}).flat())].length;
  // Connectors meet the box at its title (left to right) or at the middle of its top / bottom.
  const handleStyle = sides.vertical ? undefined : { top: SIZES.header / 2 };

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
        l.loose && !actions.selected && 'border-dashed opacity-80',
      )}
    >
      <Port type="target" position={sides.in} id="in" style={handleStyle} active={l.connectIn} />
      {l.loose && (
        <span className="absolute -bottom-2.5 left-3">
          <Badge>not connected</Badge>
        </span>
      )}
      <div
        role="button"
        tabIndex={0}
        aria-pressed={actions.selected}
        aria-label={def?.title ?? step.activity}
        data-step-id={step.id}
        title={text}
        onClick={(e) => {
          e.stopPropagation();
          if (e.ctrlKey || e.metaKey) useEditor.getState().toggleSelect(step.id);
          else select(step.id);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select(step.id);
          }
        }}
        style={{ height: SIZES.header }}
        className="group flex cursor-grab items-center gap-2.5 rounded-t-2xl px-3 outline-none active:cursor-grabbing"
      >
        <button
          type="button"
          className="nodrag nopan -mr-1 rounded p-0.5 text-subtle hover:bg-surface hover:text-fg"
          aria-label={l.collapsed ? 'Unfold' : 'Fold'}
          title={l.collapsed ? 'Show the steps inside' : 'Fold away the steps inside'}
          onClick={(e) => {
            e.stopPropagation();
            change((f) => toggleCollapsed(f, step.id));
          }}
        >
          <Icon name={l.collapsed ? 'chevron-right' : 'chevron-down'} size={15} />
        </button>
        <IconTile name={def?.icon ?? 'repeat'} category={def?.category} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold">
            {l.loop && <Icon name="repeat" size={12} className="mr-1 inline text-muted" />}
            {step.label || def?.title}
          </p>
          <p className="truncate text-[11.5px] text-muted">
            {l.collapsed ? `${inside} step${inside === 1 ? '' : 's'} inside · ${text}` : text}
          </p>
        </div>
        <RunStatusIcon status={runStatus} paused={paused} />
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
          className="absolute truncate text-[11px] font-semibold tracking-wide text-subtle uppercase"
          style={{ left: lane.x, top: lane.y + 4, maxWidth: Math.max(lane.w, 120) }}
        >
          {lane.title}
        </p>
      ))}
      <Port
        type="source"
        position={sides.out}
        id="out"
        style={handleStyle}
        active={l.ports?.includes('out')}
      />
    </div>
  );
});

function TerminalNode({ data }: NodeProps<CanvasNode>) {
  const start = data.layout.type === 'start';
  const sides = useSides();
  const handleStyle = sides.vertical ? undefined : { top: SIZES.terminal / 2 };
  return (
    <div
      className="flex cursor-grab flex-col items-center active:cursor-grabbing"
      style={{ width: SIZES.terminal }}
    >
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
      <span
        className={cn(
          'text-[11px] font-semibold tracking-wide text-subtle uppercase',
          sides.vertical ? 'absolute top-1/2 left-full ml-2 -translate-y-1/2' : 'mt-1',
        )}
      >
        {start ? 'Start' : 'End'}
      </span>
      {start ? (
        <Port
          type="source"
          position={sides.out}
          id="out"
          style={sides.vertical ? { top: SIZES.terminal } : handleStyle}
          active={data.layout.ports?.includes('out')}
        />
      ) : (
        <Handle
          type="target"
          position={sides.in}
          id="in"
          style={handleStyle}
          className={hidden}
          isConnectable={false}
        />
      )}
    </div>
  );
}

function MergeNode({ data }: NodeProps<CanvasNode>) {
  const sides = useSides();
  return (
    <div className="h-full w-full rounded-full border-2 border-border-strong bg-surface">
      <Handle type="target" position={sides.in} id="in" className={hidden} isConnectable={false} />
      <Port type="source" position={sides.out} id="out" active={data.layout.ports?.includes('out')} />
    </div>
  );
}

function AnchorNode() {
  const sides = useSides();
  return (
    <div className="h-px w-px">
      <Handle type="target" position={sides.in} id="in" className={hidden} isConnectable={false} />
      <Handle
        type="source"
        position={sides.out}
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
  const sides = useSides();
  const [open, setOpen] = useState(false);
  const empty = parseListKey(slot.listKey).block === 'steps';
  return (
    <div
      ref={setNodeRef}
      data-slot={`${slot.listKey}:${slot.index}`}
      style={{ width: data.layout.w, height: data.layout.h }}
      className="nodrag nopan"
    >
      <Handle type="target" position={sides.in} id="in" className={hidden} isConnectable={false} />
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
        position={sides.out}
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
  const vertical = useContext(DirectionContext) === 'vertical';
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
  const yes = layout.tone === 'yes';
  // If: Yes / No next to the decision. Switch: each case at the start of its lane.
  const labelAt =
    layout.tone === 'case'
      ? vertical
        ? { x: targetX, y: targetY - 16 }
        : { x: targetX - 46, y: targetY - 12 }
      : vertical
        ? { x: sourceX + (yes ? -16 : 16), y: sourceY + 18 }
        : { x: sourceX + 26, y: sourceY + (yes ? -11 : 11) };
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
              'pointer-events-none absolute max-w-32 truncate rounded-full px-1.5 text-[10.5px] leading-4 font-semibold',
              layout.tone === 'case'
                ? 'border border-border bg-surface text-muted'
                : yes
                  ? 'bg-success-soft text-success'
                  : 'bg-danger-soft text-danger',
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelAt.x}px, ${labelAt.y}px)` }}
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

/** Loops: an arrow running beside the lane (under it, or right of it), back to its start. */
function LoopEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<CanvasEdge>) {
  const vertical = useContext(DirectionContext) === 'vertical';
  const drop = data?.layout.drop ?? 40;
  const r = 14;
  let path: string;
  let label: { x: number; y: number };
  if (vertical) {
    const side = Math.max(sourceX, targetX) + drop;
    path = [
      `M ${sourceX} ${sourceY}`,
      `C ${sourceX} ${sourceY + r * 1.6}, ${side} ${sourceY + r * 1.6}, ${side} ${sourceY - r}`,
      `L ${side} ${targetY + r}`,
      `C ${side} ${targetY - r * 1.6}, ${targetX} ${targetY - r * 1.6}, ${targetX} ${targetY}`,
    ].join(' ');
    label = { x: side, y: (sourceY + targetY) / 2 };
  } else {
    const bottom = Math.max(sourceY, targetY) + drop;
    path = [
      `M ${sourceX} ${sourceY}`,
      `C ${sourceX + r * 1.6} ${sourceY}, ${sourceX + r * 1.6} ${bottom}, ${sourceX - r} ${bottom}`,
      `L ${targetX + r} ${bottom}`,
      `C ${targetX - r * 1.6} ${bottom}, ${targetX - r * 1.6} ${targetY}, ${targetX} ${targetY}`,
    ].join(' ');
    label = { x: (sourceX + targetX) / 2, y: bottom };
  }
  return (
    <>
      <BaseEdge
        path={path}
        style={{ stroke: 'var(--af-border-strong)', strokeWidth: 1.5, strokeDasharray: '5 4' }}
      />
      <EdgeLabelRenderer>
        <span
          className="pointer-events-none absolute flex items-center gap-1 rounded-full bg-surface px-1.5 text-[10.5px] text-subtle"
          style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
        >
          <Icon name="repeat" size={11} /> next
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

// -- free connections ------------------------------------------------------------------------
// A process with a flowchart: each top-level step (a box with what is inside it, an If with its
// lanes) is drawn where it was put; connectors between them are drawn by hand, from a step's
// dot to another step. Steps nothing leads to don't run ("not connected").

interface FreeLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** Top-left of each block (and Start), by step id. */
  origins: Map<string, { x: number; y: number }>;
  /** The node a block is dragged by -> its step id ("start" for Start). */
  grips: Map<string, string>;
  /** Ways in (node -> step id) and ways out (node -> step id, or "start"). */
  entries: Map<string, string>;
  exits: Map<string, string>;
}

function layoutFree(
  steps: Step[],
  chart: Flowchart,
  defOf: (activity: string) => ActivityDef | undefined,
  direction: Direction,
  collapsed: Iterable<string> | undefined,
): FreeLayout {
  const positions = chart.positions ?? {};
  const reached = reachable(chart);
  const vertical = direction === 'vertical';
  const blocks = steps.map((step) => ({ step, b: layoutBlock(step, defOf, { direction, collapsed }) }));
  for (const { step, b } of blocks) blockSizes.set(step.id, { w: b.w, h: b.h });
  const start = { x: positions[START]?.x ?? 0, y: positions[START]?.y ?? 0 };
  // Steps not placed yet (e.g. pasted): a row after everything else.
  let far = vertical ? start.x + SIZES.terminal : start.y + SIZES.terminal;
  for (const { step, b } of blocks) {
    const p = positions[step.id];
    if (p) far = Math.max(far, vertical ? (p.x ?? 0) + b.w : (p.y ?? 0) + b.h);
  }
  let parked = vertical ? start.y : start.x;
  const out: FreeLayout = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        x: start.x,
        y: start.y,
        w: SIZES.terminal,
        h: SIZES.terminal,
        depth: 0,
        block: START,
        ports: ['out'],
      },
    ],
    edges: [],
    origins: new Map([[START, start]]),
    grips: new Map([['start', START]]),
    entries: new Map(),
    exits: new Map([['start', START]]),
  };
  const ends = new Map<string, { entry: { node: string; handle: string }; exit: { node: string; handle: string } }>();
  for (const { step, b } of blocks) {
    let p = positions[step.id];
    if (!p) {
      p = vertical ? { x: far + CHART_GAP, y: parked } : { x: parked, y: far + CHART_GAP };
      parked += (vertical ? b.h : b.w) + CHART_GAP / 2;
    }
    const origin = { x: p.x ?? 0, y: p.y ?? 0 };
    out.origins.set(step.id, origin);
    const decision = step.activity === DECISION;
    for (const n of b.nodes) {
      const node: LayoutNode = { ...n, x: n.x + origin.x, y: n.y + origin.y };
      if (n.id === b.entry.node) {
        node.connectIn = true;
        node.loose = !reached.has(step.id);
      }
      if (n.id === b.exit.node) {
        node.ports = decision ? ['yes', 'no'] : ['out'];
        if (decision) node.handles = ['yes', 'no'];
      }
      out.nodes.push(node);
    }
    out.grips.set(b.entry.node, step.id);
    out.entries.set(b.entry.node, step.id);
    out.exits.set(b.exit.node, step.id);
    out.edges.push(...b.edges);
    ends.set(step.id, { entry: b.entry, exit: b.exit });
  }
  for (const link of chart.links ?? []) {
    const port = link.port ?? 'next';
    const from = link.source === START ? { node: 'start', handle: 'out' } : ends.get(link.source)?.exit;
    const to = ends.get(link.target)?.entry;
    if (!from || !to) continue;
    out.edges.push({
      id: `link:${link.source}:${port}`,
      source: from.node,
      sourceHandle: port === 'next' ? from.handle : port,
      target: to.node,
      targetHandle: to.handle,
      depth: 0,
      kind: 'link',
      link,
      ...(port === 'next' ? {} : { label: port === 'yes' ? 'Yes' : 'No', tone: port }),
    });
  }
  return out;
}

interface FreeDrag {
  block: string;
  origin: { x: number; y: number };
  dx: number;
  dy: number;
}

/** A connector dragged out of a dot and let go on an empty spot: add a step there, connected. */
interface PendingAdd {
  source: string;
  port: Port;
  at: { x: number; y: number };
  screen: { x: number; y: number };
}

function useNewStep() {
  const index = useApp((s) => s.index);
  const variables = useFlowVariables();
  return (def: ActivityDef) => createStep(def, index, new Set(variables.map((v) => v.name)));
}

function FreeChart() {
  const processId = useEditor((s) => s.processId);
  const steps = useEditor((s) => (s.flow ? processSteps(s.flow, s.processId) : undefined));
  const chart = useEditor((s) => (s.flow ? chartOf(s.flow, s.processId) : null));
  const direction: Direction = useEditor((s) => s.flow?.layout?.direction ?? 'horizontal');
  const collapsed = useEditor((s) => s.flow?.layout?.collapsed);
  const flowId = useEditor((s) => s.flow?.id);
  const select = useEditor((s) => s.select);
  const change = useEditor((s) => s.change);
  const index = useApp((s) => s.index);
  const theme = useApp((s) => s.theme);
  const newStep = useNewStep();
  const { fitView, screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement | null>(null);
  const pane = useDroppable({ id: 'free-chart', data: { kind: 'canvas' } });
  const [drag, setDragState] = useState<FreeDrag | null>(null);
  const dragRef = useRef<FreeDrag | null>(null);
  const setDrag = (next: FreeDrag | null) => {
    dragRef.current = next;
    setDragState(next);
  };
  const [pending, setPending] = useState<PendingAdd | null>(null);

  const layout = useMemo(
    () => layoutFree(steps ?? [], chart ?? {}, (activity) => index.get(activity), direction, collapsed),
    [steps, chart, index, direction, collapsed],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const nodes = useMemo(
    () =>
      layout.nodes.map((n): CanvasNode => {
        const moved = !!drag && n.block === drag.block;
        return {
          id: n.id,
          type: n.type,
          position: { x: n.x + (moved ? drag!.dx : 0), y: n.y + (moved ? drag!.dy : 0) },
          width: n.w,
          height: n.h,
          data: { layout: n },
          draggable: layout.grips.has(n.id),
          selectable: false,
          connectable: !!(n.connectIn || n.ports?.length),
          zIndex: (n.type === 'container' ? n.depth * 2 : n.depth * 2 + 1) + (moved ? 1000 : 0),
        };
      }),
    [layout, drag],
  );
  const edges = useMemo(
    () =>
      layout.edges.map((e): CanvasEdge => ({
        id: e.id,
        type: e.kind,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: e.targetHandle,
        data: { layout: e },
        selectable: false,
        zIndex: e.kind === 'link' ? 0 : e.depth * 2 + 1,
        ...(e.kind === 'link'
          ? {
              markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 18,
                height: 18,
                color:
                  e.tone === 'yes' ? 'var(--af-success)' : e.tone === 'no' ? 'var(--af-danger)' : 'var(--af-border-strong)',
              },
            }
          : {}),
      })),
    [layout],
  );

  // Show everything when a flow or process is opened.
  useEffect(() => {
    const t = setTimeout(() => void fitView({ padding: 0.15, maxZoom: 1 }), 50);
    return () => clearTimeout(t);
  }, [flowId, processId, fitView]);

  // Steps dropped from the library land where they are let go.
  useEffect(() => {
    useDnd.setState({ chartPoint: (p) => screenToFlowPosition(p) });
    return () => useDnd.setState({ chartPoint: null });
  }, [screenToFlowPosition]);

  useFollowRun(nodes);
  useReveal(layout);
  useKeepSelectedInView(wrapper, layout.nodes);
  const box = useBoxSelect(wrapper, layout.nodes);

  const sourceOf = (nodeId: string | null | undefined, handle: string | null | undefined) => {
    const step = nodeId ? layoutRef.current.exits.get(nodeId) : undefined;
    if (!step) return null;
    const node = layoutRef.current.nodes.find((n) => n.id === nodeId);
    if (!handle || !node?.ports?.includes(handle)) return null;
    return { step, port: (handle === 'yes' || handle === 'no' ? handle : 'next') as Port };
  };

  const addConnected = (def: ActivityDef, at: PendingAdd) => {
    const step = newStep(def);
    change((f) => {
      let next = insertStep(f, rootRef(processId), processSteps(f, processId).length, step);
      next = connect(next, processId, at.source, step.id, at.port);
      return setPosition(next, processId, step.id, { x: at.at.x, y: at.at.y - SIZES.node.h / 2 });
    });
    select(step.id);
  };

  const rect = wrapper.current?.getBoundingClientRect();
  return (
    <DirectionContext.Provider value={direction}>
      <div
        ref={(el) => {
          wrapper.current = el;
          pane.setNodeRef(el);
        }}
        className="relative min-h-0 flex-1 bg-bg"
        data-testid="flow-canvas"
        data-direction={direction}
        data-free="1"
        {...box.handlers}
      >
        {box.overlay}
        {pending && rect && (
          <div className="absolute z-50" style={{ left: pending.screen.x - rect.left, top: pending.screen.y - rect.top }}>
            <AddStepMenu
              open
              onOpenChange={(o) => !o && setPending(null)}
              onPick={(def) => {
                addConnected(def, pending);
                setPending(null);
              }}
              trigger={<span className="block h-px w-px" aria-hidden />}
            />
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={theme === 'system' ? 'system' : theme}
          nodesConnectable
          elementsSelectable={false}
          nodeDragThreshold={4}
          connectionRadius={28}
          connectionLineStyle={{ stroke: 'var(--af-primary)', strokeWidth: 2 }}
          panOnScroll
          zoomOnScroll={false}
          zoomActivationKeyCode={['Control', 'Meta']}
          minZoom={0.15}
          maxZoom={1.6}
          isValidConnection={(c) =>
            !!sourceOf(c.source, c.sourceHandle) && layoutRef.current.entries.has(c.target) && c.targetHandle === 'in'
          }
          onConnect={(c) => {
            const from = sourceOf(c.source, c.sourceHandle);
            const target = layoutRef.current.entries.get(c.target);
            if (from && target) change((f) => connect(f, processId, from.step, target, from.port));
          }}
          onConnectEnd={(event, state) => {
            if (state.isValid || !state.fromNode || state.fromHandle?.type !== 'source') return;
            const from = sourceOf(state.fromNode.id, state.fromHandle.id);
            const point = 'changedTouches' in event ? event.changedTouches[0] : event;
            if (!from || !point) return;
            // Let go on a step (not on its way in): nothing to add.
            if ((event.target as HTMLElement | null)?.closest?.('.react-flow__node')) return;
            setPending({
              source: from.step,
              port: from.port,
              at: screenToFlowPosition({ x: point.clientX, y: point.clientY }),
              screen: { x: point.clientX, y: point.clientY },
            });
          }}
          onNodeDragStart={(_, node) => {
            const block = layoutRef.current.grips.get(node.id);
            if (!block) return;
            const l = (node as CanvasNode).data.layout;
            setDrag({ block, origin: { x: l.x, y: l.y }, dx: 0, dy: 0 });
          }}
          onNodeDrag={(_, node) => {
            const d = dragRef.current;
            if (!d) return;
            setDrag({
              ...d,
              dx: Math.round((node.position.x - d.origin.x) / SNAP) * SNAP,
              dy: Math.round((node.position.y - d.origin.y) / SNAP) * SNAP,
            });
          }}
          onNodeDragStop={(_, node) => {
            const d = dragRef.current;
            setDrag(null);
            if (!d) return;
            const dx = Math.round((node.position.x - d.origin.x) / SNAP) * SNAP;
            const dy = Math.round((node.position.y - d.origin.y) / SNAP) * SNAP;
            const origin = layoutRef.current.origins.get(d.block);
            if ((dx || dy) && origin) {
              change((f) => setPosition(f, processId, d.block, { x: origin.x + dx, y: origin.y + dy }));
            }
          }}
          onNodeClick={(e, node) => {
            const stepId = (node as CanvasNode).data.layout.stepId;
            if (!stepId) return;
            if (e.ctrlKey || e.metaKey) useEditor.getState().toggleSelect(stepId);
            else select(stepId);
          }}
          onPaneClick={() => {
            if (!box.justDrawn()) select(null);
          }}
          panOnDrag={!box.shiftHeld}
          selectionKeyCode={null}
          deleteKeyCode={null}
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
        {(steps?.length ?? 0) > 0 && !(chart?.links ?? []).length && (
          <p className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-surface px-3 py-1 text-xs text-muted shadow-card">
            Drag from the dot of Start to a step to connect it. Steps that are not connected don't run.
          </p>
        )}
      </div>
    </DirectionContext.Provider>
  );
}

/** A connector drawn by hand: an arrow, Yes / No out of a Decision, and + / × in the middle. */
function LinkEdge(props: EdgeProps<CanvasEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.3,
  });
  const layout = data!.layout;
  const stroke =
    layout.tone === 'yes' ? 'var(--af-success)' : layout.tone === 'no' ? 'var(--af-danger)' : 'var(--af-border-strong)';
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke, strokeWidth: 2 }} interactionWidth={18} />
      <EdgeLabelRenderer>
        {/* Yes / No are written next to the Decision's dots; the line just takes their colour. */}
        <LinkButtons link={layout.link!} x={labelX} y={labelY} />
      </EdgeLabelRenderer>
    </>
  );
}

function LinkButtons({ link, x, y }: { link: Link; x: number; y: number }) {
  const processId = useEditor((s) => s.processId);
  const change = useEditor((s) => s.change);
  const select = useEditor((s) => s.select);
  const newStep = useNewStep();
  const port = (link.port ?? 'next') as Port;
  const drop = useDroppable({ id: `link:${link.source}:${port}`, data: { kind: 'link', link } });
  const dragging = useDnd((s) => !!s.dragging);
  const over = useDnd((s) => s.target?.link?.source === link.source && (s.target.link.port ?? 'next') === port);
  const [open, setOpen] = useState(false);
  return (
    <div
      className="nodrag nopan group absolute flex items-center gap-1"
      data-link={`${link.source}:${port}`}
      style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, pointerEvents: 'all' }}
    >
      <div ref={drop.setNodeRef} style={{ width: dragging ? 30 : 22, height: dragging ? 30 : 22 }}>
        <AddStepMenu
          open={open}
          onOpenChange={setOpen}
          onPick={(def) => {
            setOpen(false);
            const step = newStep(def);
            change((f) =>
              insertOnLink(insertStep(f, rootRef(processId), processSteps(f, processId).length, step), processId, link, step),
            );
            select(step.id);
          }}
          trigger={
            <button
              type="button"
              aria-label="Add a step on this connector"
              className={cn(
                'flex h-full w-full items-center justify-center rounded-full border shadow-sm transition-all',
                over
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
      {!dragging && (
        <button
          type="button"
          aria-label="Remove this connector"
          title="Remove this connector"
          onClick={() => change((f) => disconnect(f, processId, link.source, port))}
          className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-border-strong bg-surface text-muted opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:border-danger hover:text-danger focus-visible:opacity-100"
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
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
const edgeTypes = { flow: FlowEdge, loop: LoopEdge, link: LinkEdge };
