// Live updates from the Orchestrator (Server-Sent Events), shared by all pages.
import { useEffect, useRef } from 'react';

export type LiveEvent =
  | { type: 'job.updated'; job: Record<string, unknown> & { id: string; flowId: string; status: string } }
  | { type: 'job.event'; jobId: string; event: Record<string, unknown> }
  | { type: 'robot.updated'; robot: { id: string; online: boolean; jobId: string | null } }
  | { type: 'queue.updated'; queueId: string }
  | { type: 'repair.updated'; flowId: string };

type Listener = (event: LiveEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function ensureSource() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/live', { withCredentials: true });
  source.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as LiveEvent;
      listeners.forEach((l) => l(event));
    } catch {
      /* ignore malformed */
    }
  };
}

export function closeLive() {
  source?.close();
  source = null;
}

/** Call `listener` for every live event while the component is mounted. */
export function useLive(listener: Listener) {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    ensureSource();
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Reload data (debounced) whenever something relevant changes. */
export function useLiveReload(reload: () => void, filter: (e: LiveEvent) => boolean = () => true) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLive((e) => {
    if (!filter(e)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reload, 400);
  });
}
