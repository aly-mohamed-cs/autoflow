import { Button, cn, Icon, Select } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import type { PublishedFlow, QuickLaunchEntry } from '../../../shared/api';
import { errorMessage, useApp } from '../store/app';

/** Keyboard shortcuts that start published automations on a robot from anywhere in Windows. */
export function QuickLaunchSettings() {
  const toast = useApp((s) => s.toast);
  const [flows, setFlows] = useState<PublishedFlow[] | null>(null);
  const [entries, setEntries] = useState<QuickLaunchEntry[]>([]);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    window.autoflow.orchestrator.flows().then(setFlows).catch((e) => setError(errorMessage(e)));
    void window.autoflow.quickLaunch.list().then((r) => {
      setEntries(r.entries);
      setUnavailable(r.unavailable);
    });
  }, []);

  const save = async (next: QuickLaunchEntry[]) => {
    setEntries(next);
    const r = await window.autoflow.quickLaunch.save(next.filter((e) => e.flowId && e.accelerator));
    setUnavailable(r.unavailable);
    if (r.unavailable.length) toast(`These shortcuts are already used by another program: ${r.unavailable.join(', ')}`, 'error');
  };

  if (error) return <p className="text-[13px] text-danger">{error}</p>;
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Press a shortcut anywhere in Windows to start an automation on a robot. Studio stays in the tray (next to the clock)
        so shortcuts keep working when its window is closed.
      </p>
      {entries.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <Select
            className="flex-1"
            value={entry.flowId}
            placeholder="Choose an automation"
            options={(flows ?? []).map((f) => ({ value: f.id, label: f.name }))}
            onChange={(flowId) => {
              const flow = flows?.find((f) => f.id === flowId);
              void save(entries.map((e, j) => (j === i ? { ...e, flowId, flowName: flow?.name ?? flowId } : e)));
            }}
          />
          <HotkeyInput
            value={entry.accelerator}
            invalid={unavailable.includes(entry.accelerator)}
            onChange={(accelerator) => void save(entries.map((e, j) => (j === i ? { ...e, accelerator } : e)))}
          />
          <Button variant="ghost" size="icon" aria-label="Run now" title="Run now" disabled={!entry.flowId}
            onClick={() => void window.autoflow.quickLaunch.run(entry)}>
            <Icon name="play" size={15} />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => void save(entries.filter((_, j) => j !== i))}>
            <Icon name="x" size={15} />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        icon={<Icon name="plus" size={14} />}
        disabled={!flows?.length}
        onClick={() => setEntries([...entries, { flowId: '', flowName: '', accelerator: `Ctrl+Alt+${entries.length + 1}` }])}
      >
        Add shortcut
      </Button>
      {flows && flows.length === 0 && <p className="text-xs text-subtle">Publish an automation first.</p>}
    </div>
  );
}

const MODIFIERS: Record<string, string> = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };

/** Click, then press the shortcut (e.g. Ctrl+Alt+1). Requires Ctrl or Alt so it can't clash with typing. */
function HotkeyInput({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const [recording, setRecording] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        if (e.key === 'Escape') return setRecording(false);
        if (MODIFIERS[e.key]) return; // wait for the main key
        const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : /^F\d+$/.test(e.key) ? e.key : null;
        if (!key || !(e.ctrlKey || e.altKey)) return;
        const parts = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean);
        onChange(parts.join('+'));
        setRecording(false);
      }}
      className={cn(
        'h-8 w-40 rounded-md border px-2 text-left font-mono text-xs',
        recording ? 'border-primary ring-2 ring-primary/20' : invalid ? 'border-danger text-danger' : 'border-border',
      )}
      aria-label="Shortcut"
    >
      {recording ? 'Press the keys…' : value || 'Set shortcut'}
    </button>
  );
}
