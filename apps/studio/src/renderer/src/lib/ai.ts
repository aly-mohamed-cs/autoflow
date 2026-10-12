// The optional AI assistant runs on the company's own model server, reached through
// the Orchestrator. Every AI control stays hidden unless an administrator turned it on.
import { useEffect, useState } from 'react';

let cached: { at: number; enabled: Promise<boolean> } | null = null;

/** Whether the AI assistant is available (asked at most once a minute). */
export function aiEnabled(): Promise<boolean> {
  if (!cached || Date.now() - cached.at > 60_000) {
    cached = {
      at: Date.now(),
      enabled: window.autoflow.ai.status().then(
        (s) => s.enabled,
        () => false,
      ),
    };
  }
  return cached.enabled;
}

const listeners = new Set<() => void>();

export function useAiEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () => void aiEnabled().then((v) => alive && setEnabled(v));
    check();
    listeners.add(check);
    return () => {
      alive = false;
      listeners.delete(check);
    };
  }, []);
  return enabled;
}

/** Ask again now (after connecting to or disconnecting from an Orchestrator). */
export function forgetAiStatus(): void {
  cached = null;
  for (const check of listeners) check();
}

const REPAIR_KEY = 'autoflow.aiRepairInTestRuns';

/** Builder's choice: let the AI fix failed steps during test runs (on unless turned off). */
export function aiRepairWanted(): boolean {
  try {
    return localStorage.getItem(REPAIR_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setAiRepairWanted(on: boolean): void {
  try {
    localStorage.setItem(REPAIR_KEY, on ? 'on' : 'off');
  } catch {
    // private window: the default (on) applies
  }
}
