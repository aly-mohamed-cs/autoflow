import type { Flow, ValidationIssue } from '@autoflow/flow-types';
import { create } from 'zustand';
import { processOfStep } from '../lib/flowOps';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 800;

interface EditorState {
  flow: Flow | null;
  /** The process shown in the editor: a sub-process id, or null for the main one. */
  processId: string | null;
  selectedId: string | null;
  dirty: boolean;
  saving: boolean;
  savedAt: number | null;
  issues: ValidationIssue[];
  past: Flow[];
  future: Flow[];
  lastKey: string | null;
  lastAt: number;

  open(flow: Flow): void;
  close(): void;
  /**
   * Apply an edit. Edits with the same coalesceKey within a short time (typing in one
   * field) become a single undo step.
   */
  change(fn: (flow: Flow) => Flow, coalesceKey?: string): void;
  undo(): void;
  redo(): void;
  /** Select a step (switching to its process if needed), or nothing. */
  select(id: string | null): void;
  /** Show a process (null: the main one). */
  showProcess(id: string | null): void;
  setIssues(issues: ValidationIssue[]): void;
  markSaving(saving: boolean): void;
  markSaved(flow: Flow): void;
}

/** The shown process, or the main one if it was removed (e.g. by undo). */
function existing(flow: Flow, processId: string | null): string | null {
  return processId && flow.processes?.some((p) => p.id === processId) ? processId : null;
}

export const useEditor = create<EditorState>((set, get) => ({
  flow: null,
  processId: null,
  selectedId: null,
  dirty: false,
  saving: false,
  savedAt: null,
  issues: [],
  past: [],
  future: [],
  lastKey: null,
  lastAt: 0,

  open: (flow) =>
    set({
      flow,
      processId: null,
      selectedId: null,
      dirty: false,
      past: [],
      future: [],
      issues: [],
      savedAt: Date.now(),
      lastKey: null,
    }),
  close: () => set({ flow: null, processId: null, selectedId: null, past: [], future: [], issues: [] }),

  change: (fn, coalesceKey) => {
    const { flow, past, lastKey, lastAt } = get();
    if (!flow) return;
    const next = fn(flow);
    if (next === flow) return;
    const now = Date.now();
    const coalesce = !!coalesceKey && coalesceKey === lastKey && now - lastAt < COALESCE_MS;
    set({
      flow: next,
      processId: existing(next, get().processId),
      dirty: true,
      past: coalesce ? past : [...past.slice(-HISTORY_LIMIT + 1), flow],
      future: [],
      lastKey: coalesceKey ?? null,
      lastAt: now,
    });
  },

  undo: () => {
    const { flow, past, future } = get();
    if (!flow || !past.length) return;
    const previous = past[past.length - 1]!;
    set({
      flow: previous,
      processId: existing(previous, get().processId),
      past: past.slice(0, -1),
      future: [flow, ...future],
      dirty: true,
      lastKey: null,
    });
  },

  redo: () => {
    const { flow, past, future } = get();
    if (!flow || !future.length) return;
    const next = future[0]!;
    set({
      flow: next,
      processId: existing(next, get().processId),
      past: [...past, flow],
      future: future.slice(1),
      dirty: true,
      lastKey: null,
    });
  },

  select: (selectedId) => {
    const { flow, processId } = get();
    const home = selectedId && flow ? processOfStep(flow, selectedId) : undefined;
    set({ selectedId, processId: home === undefined ? processId : home });
  },
  showProcess: (processId) => {
    const { flow, selectedId } = get();
    const keep = selectedId && flow && processOfStep(flow, selectedId) === processId;
    set({ processId, selectedId: keep ? selectedId : null });
  },
  setIssues: (issues) => set({ issues }),
  markSaving: (saving) => set({ saving }),
  // Only clear "dirty" if nothing changed while the save was in flight.
  markSaved: (saved) => set({ saving: false, savedAt: Date.now(), dirty: get().flow !== saved }),
}));
