import type { RunError, RunEvent, RunStatus } from '@autoflow/flow-types';
import { create } from 'zustand';

export type StepRunStatus = 'running' | 'ok' | 'failed' | 'continued' | 'cancelled';
export type RunPhase = 'idle' | 'starting' | 'running' | 'paused' | 'finished';

export interface LogEntry {
  id: number;
  ts: number;
  level: 'info' | 'warning' | 'error' | 'success' | 'step';
  message: string;
  stepId?: string;
  hint?: string | null;
  screenshot?: string;
}

interface RunState {
  phase: RunPhase;
  runId: string | null;
  flowId: string | null;
  startedAt: number | null;
  currentStepId: string | null;
  pausedStepId: string | null;
  stepStatus: Record<string, StepRunStatus>;
  stepErrors: Record<string, { message: string; hint?: string | null }>;
  log: LogEntry[];
  /** Latest value previews per variable (kept after the run for the variable picker). */
  values: Record<string, unknown>;
  screenshots: { stepId?: string; path: string; reason: string }[];
  result: { status: RunStatus; durationMs: number; error: RunError | null; outputs: Record<string, unknown> } | null;
  breakpoints: Record<string, string[]>; // per flow id

  begin(flowId: string): void;
  started(runId: string): void;
  failedToStart(message: string): void;
  handle(event: RunEvent): void;
  toggleBreakpoint(flowId: string, stepId: string): string[];
  reset(): void;
}

let logId = 0;
const MAX_LOG = 2000;

export const useRun = create<RunState>((set, get) => ({
  phase: 'idle',
  runId: null,
  flowId: null,
  startedAt: null,
  currentStepId: null,
  pausedStepId: null,
  stepStatus: {},
  stepErrors: {},
  log: [],
  values: {},
  screenshots: [],
  result: null,
  breakpoints: {},

  begin: (flowId) =>
    set({
      phase: 'starting',
      flowId,
      runId: null,
      startedAt: Date.now(),
      currentStepId: null,
      pausedStepId: null,
      stepStatus: {},
      stepErrors: {},
      log: [],
      screenshots: [],
      result: null,
      // keep `values` from the previous run until new ones arrive (columns stay known)
    }),

  started: (runId) => set({ runId, phase: get().phase === 'starting' ? 'running' : get().phase }),

  failedToStart: (message) =>
    set({
      phase: 'finished',
      log: [{ id: ++logId, ts: Date.now() / 1000, level: 'error', message }],
      result: { status: 'failed', durationMs: 0, error: { message }, outputs: {} },
    }),

  handle: (event) => {
    const state = get();
    if (state.phase === 'idle') return;
    const add = (entry: Omit<LogEntry, 'id' | 'ts'>) => [
      ...state.log.slice(-MAX_LOG + 1),
      { id: ++logId, ts: event.ts, ...entry },
    ];
    switch (event.event) {
      case 'run_started':
        set({ runId: event.run_id, phase: 'running' });
        break;
      case 'step_started':
        set({
          currentStepId: event.step_id,
          pausedStepId: null,
          phase: 'running',
          stepStatus: { ...state.stepStatus, [event.step_id]: 'running' },
        });
        break;
      case 'step_finished': {
        const status: StepRunStatus = event.continued ? 'continued' : event.status;
        const stepErrors = event.error ? { ...state.stepErrors, [event.step_id]: event.error } : state.stepErrors;
        set({
          stepStatus: { ...state.stepStatus, [event.step_id]: status },
          stepErrors,
          log: event.error
            ? add({
                level: event.continued ? 'warning' : 'error',
                message: event.error.message,
                hint: event.error.hint,
                stepId: event.step_id,
              })
            : state.log,
        });
        break;
      }
      case 'log':
        set({ log: add({ level: event.level, message: event.message, stepId: event.step_id }) });
        break;
      case 'variable':
        set({ values: { ...state.values, [event.name]: event.value } });
        break;
      case 'screenshot':
        set({
          screenshots: [...state.screenshots, { stepId: event.step_id, path: event.path, reason: event.reason }],
          log: add({
            level: 'info',
            message: event.reason === 'error' ? 'Screenshot at the moment of the error' : 'Screenshot',
            stepId: event.step_id,
            screenshot: event.path,
          }),
        });
        break;
      case 'paused':
        set({ phase: 'paused', pausedStepId: event.step_id, currentStepId: event.step_id });
        break;
      case 'run_finished':
        set({
          phase: 'finished',
          currentStepId: null,
          pausedStepId: null,
          result: { status: event.status, durationMs: event.duration_ms, error: event.error, outputs: event.outputs },
          log: add({
            level: event.status === 'succeeded' ? 'success' : event.status === 'failed' ? 'error' : 'warning',
            message:
              event.status === 'succeeded'
                ? `Finished successfully in ${formatDuration(event.duration_ms)}`
                : event.status === 'cancelled'
                  ? 'Run stopped'
                  : `Run failed: ${event.error?.message ?? 'unknown error'}`,
            hint: event.error?.hint,
            stepId: event.error?.step_id,
          }),
        });
        break;
    }
  },

  toggleBreakpoint: (flowId, stepId) => {
    const current = new Set(get().breakpoints[flowId] ?? []);
    if (current.has(stepId)) current.delete(stepId);
    else current.add(stepId);
    const list = [...current];
    set({ breakpoints: { ...get().breakpoints, [flowId]: list } });
    return list;
  },

  reset: () => set({ phase: 'idle', stepStatus: {}, stepErrors: {}, currentStepId: null, pausedStepId: null, result: null }),
}));

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

export const isActive = (phase: RunPhase) => phase === 'starting' || phase === 'running' || phase === 'paused';
