import type { Catalog } from '@autoflow/flow-types';
import { Icon } from '@autoflow/ui';
import { useEffect, useRef, useState } from 'react';

type Phase = 'running' | 'paused' | 'stopping';

/**
 * The floating bar shown during a test run while another program is in front (main/runguard.ts).
 * It never takes the keyboard focus, so clicking it doesn't disturb the program being automated.
 */
export function RunBar() {
  const [phase, setPhase] = useState<Phase>('running');
  const [step, setStep] = useState('');
  const titles = useRef(new Map<string, string>());

  useEffect(() => {
    document.body.style.background = '#1f2430';
    window.autoflow.engine
      .call<Catalog>('catalog.get')
      .then((catalog) => {
        titles.current = new Map(catalog.activities.map((a) => [a.id, a.title]));
      })
      .catch(() => undefined);
    return window.autoflow.run.onEvent((e) => {
      if (e.event === 'step_started') {
        setStep(e.label || titles.current.get(e.activity) || e.activity);
        setPhase((p) => (p === 'stopping' ? p : 'running'));
      } else if (e.event === 'paused') {
        setPhase((p) => (p === 'stopping' ? p : 'paused'));
      } else if (e.event === 'resumed') {
        setPhase((p) => (p === 'stopping' ? p : 'running'));
      }
    });
  }, []);

  const act = (action: 'pause' | 'resume' | 'stop') => {
    if (action === 'stop') setPhase('stopping');
    void window.autoflow.run.control(action);
  };

  const status = phase === 'paused' ? 'Paused' : phase === 'stopping' ? 'Stopping…' : 'Test run in progress';
  return (
    <div className="flex h-screen items-center gap-3 px-3 text-white select-none" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${phase === 'paused' ? 'bg-amber-400' : 'animate-pulse bg-red-500'}`} aria-hidden />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="text-[13px] font-semibold">{status}</p>
        <p className="truncate text-[11px] text-white/70">{step || 'Ctrl+Shift+F11 pause · Ctrl+Shift+F12 stop'}</p>
      </div>
      <div className="flex gap-1.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {phase === 'paused' ? (
          <BarButton onClick={() => act('resume')} icon="play" label="Continue" title="Continue (Ctrl+Shift+F11)" />
        ) : (
          <BarButton onClick={() => act('pause')} icon="pause" label="Pause" title="Pause (Ctrl+Shift+F11)" disabled={phase === 'stopping'} />
        )}
        <BarButton onClick={() => act('stop')} icon="square" label="Stop" title="Stop (Ctrl+Shift+F12)" danger disabled={phase === 'stopping'} />
      </div>
    </div>
  );
}

function BarButton({ onClick, icon, label, title, danger, disabled }: { onClick: () => void; icon: string; label: string; title: string; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-50 ${
        danger ? 'bg-red-500 hover:bg-red-600' : 'bg-white/10 hover:bg-white/20'
      }`}
    >
      <Icon name={icon} size={13} /> {label}
    </button>
  );
}
