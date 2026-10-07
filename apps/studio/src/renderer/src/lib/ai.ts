// The optional AI assistant runs on the company's own model server, reached through
// the Orchestrator. Every AI control stays hidden unless an administrator turned it on.
import { useEffect, useState } from 'react';

let cached: { at: number; enabled: Promise<boolean> } | null = null;

/** Whether the AI assistant is available (asked at most once a minute). */
export function useAiEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!cached || Date.now() - cached.at > 60_000) {
      cached = { at: Date.now(), enabled: window.autoflow.ai.status().then((s) => s.enabled, () => false) };
    }
    void cached.enabled.then((v) => alive && setEnabled(v));
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}

/** Ask again next time (after connecting to or disconnecting from an Orchestrator). */
export function forgetAiStatus(): void {
  cached = null;
}
