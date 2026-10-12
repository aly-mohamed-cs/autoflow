import type { Element, Flow } from '@autoflow/flow-types';
import { Button, cn, Dialog, Field, Icon, Input, Spinner } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import { insertStep, locate, processSteps, rootRef } from '../lib/flowOps';
import {
  firstBrowserUrl,
  hasBrowserOpen,
  stepsFromRecording,
  type RecordedAction,
} from '../lib/recording';
import { errorMessage, useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { create } from 'zustand';

/** "pc": anything in any Windows program (desktop recorder); "web": the recording browser. */
type RecordMode = 'pc' | 'web';

interface RecorderState {
  phase: 'idle' | 'asking' | 'starting' | 'recording' | 'stopping';
  mode: RecordMode;
  startUrl: string;
  actions: RecordedAction[];
  set(patch: Partial<RecorderState>): void;
}

export const useRecorder = create<RecorderState>((set) => ({
  phase: 'idle',
  mode: 'pc',
  startUrl: '',
  actions: [],
  set: (patch) => set(patch),
}));

const ACTION_TEXT: Record<RecordedAction['action'], (a: RecordedAction) => string> = {
  click: (a) =>
    `${a.click === 'double' ? 'Double-click' : a.click === 'right' ? 'Right-click' : 'Click'} ${a.element?.name ?? ''}`,
  keys: (a) => `Press ${a.keys}`,
  activate: (a) => `Switch to “${a.window}”`,
  launch: (a) => `Open ${a.program?.split(/[\\/]/).pop() ?? 'the program'}`,
  type: (a) =>
    a.password
      ? `Type password into ${a.element?.name}`
      : `Type “${a.value ?? ''}” into ${a.element?.name}`,
  select: (a) => `Choose “${a.option}” in ${a.element?.name}`,
  check: (a) => `${a.checked ? 'Tick' : 'Untick'} ${a.element?.name}`,
  upload: (a) => `Upload a file using ${a.element?.name}`,
  goto: (a) => `Go to ${a.url}`,
  switch_tab: () => 'Switch to the new tab',
};

export function RecordButton() {
  const phase = useRecorder((s) => s.phase);
  const set = useRecorder((s) => s.set);
  const engineReady = useApp((s) => s.engine.state === 'ready');
  return (
    <Button
      disabled={!engineReady || phase !== 'idle'}
      onClick={() => {
        const flow = useEditor.getState().flow;
        set({ phase: 'asking', startUrl: (flow && firstBrowserUrl(flow)) || '' });
      }}
      icon={<span className="h-2.5 w-2.5 rounded-full bg-danger" aria-hidden />}
    >
      Record
    </Button>
  );
}

/** Start dialog + floating "Recording…" bar. Mounted once in the editor. */
export function Recorder() {
  const { phase, mode, startUrl, actions, set } = useRecorder();
  const toast = useApp((s) => s.toast);
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (phase === 'asking') setUrl(startUrl);
  }, [phase, startUrl]);

  useEffect(() => {
    const offAction = window.autoflow.engine.onNotification('recorder.action', (raw) => {
      const a = raw as RecordedAction;
      useRecorder.setState((s) => ({
        actions: a.replace_last ? [...s.actions.slice(0, -1), a] : [...s.actions, a],
      }));
    });
    const offStopped = window.autoflow.engine.onNotification('recorder.stopped', () => {
      if (useRecorder.getState().phase === 'recording') void finish(true);
    });
    return () => {
      offAction();
      offStopped();
    };
  }, []);

  const start = async () => {
    set({ phase: 'starting', actions: [], startUrl: url.trim() });
    try {
      if (mode === 'pc') {
        await window.autoflow.engine.call('recorder.desktop_start', {}, 60_000);
        set({ phase: 'recording' });
        await window.autoflow.app.minimize(); // out of the way; the red bar at the top stops the recording
      } else {
        await window.autoflow.engine.call(
          'recorder.start',
          { url: url.trim() || undefined },
          120_000,
        );
        set({ phase: 'recording' });
      }
    } catch (e) {
      set({ phase: 'idle' });
      toast(errorMessage(e), 'error');
    }
  };

  const finish = async (keep: boolean) => {
    set({ phase: 'stopping' });
    let recorded: RecordedAction[] = useRecorder.getState().actions;
    const pc = useRecorder.getState().mode === 'pc';
    try {
      const method = pc ? 'recorder.desktop_stop' : 'recorder.stop';
      const result = await window.autoflow.engine.call<{ actions: RecordedAction[] }>(
        method,
        {},
        60_000,
      );
      recorded = result.actions;
    } catch {
      /* keep what was streamed so far */
    }
    if (pc) void window.autoflow.app.restore();
    set({ phase: 'idle', actions: [] });
    if (!keep || recorded.length === 0) {
      if (keep) toast('Nothing was recorded.', 'info');
      return;
    }
    const { flow, selectedId, processId, change, select } = useEditor.getState();
    if (!flow) return;
    const { steps, elements } = stepsFromRecording(recorded, {
      startUrl: useRecorder.getState().startUrl,
      existingElements: flow.elements as Element[] | undefined,
      addOpenBrowser: !pc && !hasBrowserOpen(flow),
    });
    const where = selectedId ? locate(flow, selectedId) : null;
    change((f) => {
      let next: Flow = { ...f, elements: [...(f.elements ?? []), ...elements] };
      const ref = where?.ref ?? rootRef(processId);
      let at = where ? where.index + 1 : processSteps(f, processId).length;
      for (const s of steps) next = insertStep(next, ref, at++, s);
      return next;
    });
    select(steps[0]?.id ?? null);
    toast(
      `Added ${steps.length} recorded steps. Replace typed values with variables to make them reusable.`,
      'success',
    );
  };

  return (
    <>
      <Dialog
        open={phase === 'asking' || phase === 'starting'}
        onOpenChange={(o) => !o && phase === 'asking' && set({ phase: 'idle' })}
        title="Record a task"
        description="Do the task once, as you normally would — Autoflow turns each click and entry into a step."
        footer={
          <>
            <Button onClick={() => set({ phase: 'idle' })} disabled={phase === 'starting'}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={start}
              loading={phase === 'starting'}
              icon={<span className="h-2.5 w-2.5 rounded-full bg-white" aria-hidden />}
            >
              Start recording
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="What to record">
            {(
              [
                {
                  value: 'pc',
                  icon: 'monitor',
                  title: 'Anything on this PC',
                  text: 'Excel, your ERP, File Explorer, a browser… any program.',
                },
                {
                  value: 'web',
                  icon: 'globe',
                  title: 'A website',
                  text: 'Opens a recording browser. Best for web portals.',
                },
              ] as const
            ).map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={mode === o.value}
                onClick={() => set({ mode: o.value })}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-lg border p-3 text-left',
                  mode === o.value
                    ? 'border-primary bg-primary-soft'
                    : 'border-border hover:border-border-strong',
                )}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <Icon name={o.icon} size={16} className="text-primary" /> {o.title}
                </span>
                <span className="text-[13px] leading-snug text-muted">{o.text}</span>
              </button>
            ))}
          </div>
          {mode === 'web' ? (
            <Field
              label="Website to start on"
              htmlFor="rec-url"
              className="mt-4"
              help="For example portal.yourcompany.com. You can also type it in the browser later."
            >
              <Input
                id="rec-url"
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://"
              />
            </Field>
          ) : (
            <p className="mt-4 text-[13px] text-muted">
              Studio steps aside while you work. A small red bar at the top of the screen shows the
              recording — click <strong>Stop recording</strong> there when you're done.
            </p>
          )}
          <ul className="mt-4 space-y-1 text-[13px] text-muted">
            <li>• Passwords are never recorded — you'll choose a saved credential instead.</li>
            <li>
              • Typed values are kept as examples; afterwards you can swap them for Excel columns or
              variables.
            </li>
            {mode === 'pc' && <li>• Programs started “as administrator” can't be recorded.</li>}
          </ul>
        </form>
      </Dialog>

      {(phase === 'recording' || phase === 'stopping') && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 w-[520px] -translate-x-1/2 rounded-xl border border-danger/40 bg-surface shadow-pop animate-fade-in"
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-danger" />
            </span>
            <div className="flex-1">
              <p className="font-semibold">Recording…</p>
              <p className="text-xs text-muted">
                {mode === 'pc'
                  ? 'Do the task in your programs.'
                  : 'Do the task in the browser window.'}{' '}
                {actions.length} step
                {actions.length === 1 ? '' : 's'} so far.
              </p>
            </div>
            <Button
              variant="ghost"
              onClick={() => void finish(false)}
              disabled={phase === 'stopping'}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              onClick={() => void finish(true)}
              loading={phase === 'stopping'}
              icon={<Icon name="square" size={13} />}
            >
              Stop & add steps
            </Button>
          </div>
          <ol className="max-h-40 overflow-y-auto px-4 py-2 text-[13px]">
            {actions.length === 0 && (
              <li className="py-2 text-subtle">Waiting for your first click…</li>
            )}
            {actions.slice(-8).map((a, i) => (
              <li key={i} className="flex items-center gap-2 py-0.5">
                <Icon name="check" size={13} className="text-success" />
                <span className="truncate">{ACTION_TEXT[a.action](a)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

/** Full-window hint while the user picks an element (in a browser, or in a desktop application). */
export function PickingOverlay({
  onCancel,
  kind = 'web',
}: {
  onCancel: () => void;
  kind?: 'web' | 'desktop' | 'point';
}) {
  const [hover, setHover] = useState<{ name: string; window: string } | null>(null);
  useEffect(
    () =>
      window.autoflow.engine.onNotification('picker.hover', (h) =>
        setHover(h as { name: string; window: string }),
      ),
    [],
  );
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 animate-fade-in"
      role="dialog"
      aria-label="Picking an element"
    >
      <div className="flex max-w-md flex-col items-center gap-3 rounded-xl bg-surface p-6 text-center shadow-pop">
        <Spinner className="h-6 w-6 text-primary" />
        {kind === 'point' ? (
          <>
            <p className="text-base font-semibold">Point at the spot and press Ctrl</p>
            <p className="text-[13px] text-muted">
              Switch to the application and move the mouse to the exact point — a label next to the
              mouse shows its position on the screen, in the window and inside the element — then
              press <kbd className="rounded border border-border px-1">Ctrl</kbd>. Press Esc to
              cancel.
            </p>
          </>
        ) : kind === 'desktop' ? (
          <>
            <p className="text-base font-semibold">Point at the element and press Ctrl</p>
            <p className="text-[13px] text-muted">
              Switch to the application, move the mouse over the button, box or list you want — a
              red outline shows what will be picked — then press{' '}
              <kbd className="rounded border border-border px-1">Ctrl</kbd>. Press Esc to cancel.
            </p>
            <p className="min-h-5 text-[13px] font-medium text-primary" aria-live="polite">
              {hover ? `Pointing at: ${hover.name}${hover.window ? ` (${hover.window})` : ''}` : ''}
            </p>
          </>
        ) : (
          <>
            <p className="text-base font-semibold">Click the element in the browser window</p>
            <p className="text-[13px] text-muted">
              Move the mouse over the page — the element under it is highlighted. Click it to pick
              it. Need to sign in or open another page first? Hold{' '}
              <kbd className="rounded border border-border px-1">Ctrl</kbd> while clicking to use
              the page normally. Press Esc in the browser to cancel.
            </p>
          </>
        )}
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
