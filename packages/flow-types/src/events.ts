// Events streamed by the engine while a flow runs (runtime/interpreter.py).
import type { Element } from './flow';

export type RunStatus = 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = 'ok' | 'failed' | 'cancelled';

export interface RunError {
  message: string;
  hint?: string | null;
  step_id?: string;
  activity?: string;
  details?: string;
}

/** What an AI fix changed in a step (runtime/repair.py); kept only when a person approves. */
export interface RepairPatch {
  step_id: string;
  /** Only the settings that changed. */
  params: Record<string, unknown>;
  /** The element with its new ways to find it (first), or a new element the AI found. */
  element: Element | null;
  new_element: boolean;
}

interface Base {
  ts: number;
  step_id?: string;
}

export type RunEvent =
  | (Base & { event: 'run_started'; run_id: string; flow_id: string; flow_name: string })
  | (Base & { event: 'step_started'; step_id: string; activity: string; label?: string | null })
  | (Base & { event: 'step_finished'; step_id: string; status: StepStatus; duration_ms: number;
      continued?: boolean; repaired?: boolean; error?: { message: string; hint?: string | null } })
  | (Base & { event: 'log'; level: 'info' | 'warning' | 'error'; message: string })
  | (Base & { event: 'variable'; name: string; value: unknown })
  | (Base & { event: 'screenshot'; path: string; reason: 'error' | 'step' })
  | (Base & { event: 'paused'; step_id: string; reason: 'breakpoint' | 'paused' })
  | (Base & { event: 'resumed'; step_id: string })
  | (Base & { event: 'repair_started'; step_id: string; attempt: number; of: number })
  | (Base & { event: 'repair_trying'; step_id: string; attempt: number; explanation: string; patch: RepairPatch })
  | (Base & { event: 'repair_failed'; step_id: string; attempt: number; reason: string })
  | (Base & { event: 'step_repaired'; step_id: string; attempt: number; explanation: string; patch: RepairPatch })
  | (Base & { event: 'run_finished'; run_id: string; status: RunStatus; duration_ms: number;
      outputs: Record<string, unknown>; error: RunError | null });

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  step_id?: string;
  field?: string;
}
