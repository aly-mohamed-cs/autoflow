import { cn, Icon } from '@autoflow/ui';
import { useApp } from '../store/app';

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-96 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-surface p-3 shadow-pop animate-fade-in',
            t.tone === 'error' ? 'border-danger/40' : 'border-border',
          )}
        >
          <Icon
            name={t.tone === 'error' ? 'circle-alert' : t.tone === 'success' ? 'circle-check' : 'info'}
            size={18}
            className={t.tone === 'error' ? 'text-danger' : t.tone === 'success' ? 'text-success' : 'text-primary'}
          />
          <p className="flex-1 text-[13px] whitespace-pre-line">{t.message}</p>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-subtle hover:text-fg">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
