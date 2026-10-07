// Events streamed by the engine while a flow runs (runtime/interpreter.py).

export type RunStatus = 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = 'ok' | 'failed' | 'cancelled';

export interface RunError {
  message: string;
  hint?: string | null;
  step_id?: string;
  activity?: string;
  details?: string;
}

interface Base {
  ts: number;
  step_id?: string;
}

export type RunEvent =
  | (Base & { event: 'run_started'; run_id: string; flow_id: string; flow_name: string })
  | (Base & { event: 'step_started'; step_id: string; activity: string; label?: string | null })
  | (Base & { event: 'step_finished'; step_id: string; status: StepStatus; duration_ms: number;
      continued?: boolean; error?: { message: string; hint?: string | null } })
  | (Base & { event: 'log'; level: 'info' | 'warning' | 'error'; message: string })
  | (Base & { event: 'variable'; name: string; value: unknown })
  | (Base & { event: 'screenshot'; path: string; reason: 'error' | 'step' })
  | (Base & { event: 'paused'; step_id: string; reason: 'breakpoint' | 'paused' })
  | (Base & { event: 'run_finished'; run_id: string; status: RunStatus; duration_ms: number;
      outputs: Record<string, unknown>; error: RunError | null });

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  step_id?: string;
  field?: string;
}
