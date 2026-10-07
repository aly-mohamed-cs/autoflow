// Thin client for the Orchestrator API (same origin; session cookie).
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Autoflow': '1', // tells the server this request comes from our own page
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized?.();
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

/** Load data and reload on demand; keeps showing old data while reloading. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const reload = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (mine === seq.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => mine === seq.current && setError(e.message))
      .finally(() => mine === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

// -- API shapes ------------------------------------------------------------------------

export type Role = 'viewer' | 'operator' | 'builder' | 'admin';
export const ROLE_ORDER: Role[] = ['viewer', 'operator', 'builder', 'admin'];
export const can = (role: Role | undefined, needed: Role) => !!role && ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(needed);

export interface Me {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  roleLabel: string;
  source: 'local' | 'ldap';
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  flowId: string;
  flowName?: string;
  version: number;
  status: JobStatus;
  trigger: string;
  triggeredBy: string | null;
  inputs: Record<string, unknown>;
  robotId: string | null;
  robotName?: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  outputs: Record<string, unknown> | null;
  error: { message: string; hint?: string | null; step_id?: string } | null;
  cancelRequested: boolean;
}

export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  latestVersion: number;
  minutesSaved: number;
  createdBy: string | null;
  updatedAt: string;
  archived: boolean;
  lastJob?: { id: string; status: JobStatus; queuedAt: string; finishedAt: string | null } | null;
  activeSchedules?: number;
}

export interface InputVar {
  name: string;
  type: string;
  description: string;
  default: unknown;
  sensitive: boolean;
}

export interface Robot {
  id: string;
  name: string;
  machine: string;
  pool: string;
  version: string;
  enabled: boolean;
  online: boolean;
  jobId: string | null;
  jobFlowName: string | null;
  lastSeenAt: string | null;
  enrolledAt: string;
}

export interface Schedule {
  id: string;
  flowId: string;
  flowName: string;
  name: string;
  cron: string;
  timezone: string;
  inputs: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}
