import type { Flow, ValidationIssue } from '@autoflow/flow-types';
import { create } from 'zustand';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 800;

interface EditorState {
  flow: Flow | null;
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
  select(id: string | null): void;
  setIssues(issues: ValidationIssue[]): void;
  markSaving(saving: boolean): void;
  markSaved(flow: Flow): void;
}

export const useEditor = create<EditorState>((set, get) => ({
  flow: null,
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
    set({ flow, selectedId: null, dirty: false, past: [], future: [], issues: [], savedAt: Date.now(), lastKey: null }),
  close: () => set({ flow: null, selectedId: null, past: [], future: [], issues: [] }),

  change: (fn, coalesceKey) => {
    const { flow, past, lastKey, lastAt } = get();
    if (!flow) return;
    const next = fn(flow);
    if (next === flow) return;
    const now = Date.now();
    const coalesce = !!coalesceKey && coalesceKey === lastKey && now - lastAt < COALESCE_MS;
    set({
      flow: next,
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
    set({ flow: past[past.length - 1]!, past: past.slice(0, -1), future: [flow, ...future], dirty: true, lastKey: null });
  },

  redo: () => {
    const { flow, past, future } = get();
    if (!flow || !future.length) return;
    set({ flow: future[0]!, past: [...past, flow], future: future.slice(1), dirty: true, lastKey: null });
  },

  select: (selectedId) => set({ selectedId }),
  setIssues: (issues) => set({ issues }),
  markSaving: (saving) => set({ saving }),
  // Only clear "dirty" if nothing changed while the save was in flight.
  markSaved: (saved) => set({ saving: false, savedAt: Date.now(), dirty: get().flow !== saved }),
}));
