import { Button, Dialog, Icon } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import { api, type Robot } from '../lib/api';
import { href } from '../lib/router';

interface ScreenView {
  online: boolean;
  frame: { image: string | null; width: number; height: number; at: number; error: string | null } | null;
  jobId: string | null;
}

/** The robot's screen, refreshed every 1.5 seconds while the dialog is open. */
export function RobotScreen({ robot, onClose }: { robot: Robot | null; onClose: () => void }) {
  const [view, setView] = useState<ScreenView | null>(null);
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!robot) return;
    setView(null);
    setError('');
    let alive = true;
    const load = async () => {
      try {
        const next = await api<ScreenView>(`/api/robots/${robot.id}/screen`);
        if (alive) setView(next);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [robot]);

  const frame = view?.frame;
  return (
    <Dialog
      open={!!robot}
      onOpenChange={(o) => !o && onClose()}
      title={robot ? `Screen of ${robot.name}` : ''}
      description="Live view, about every second and a half. Watching is recorded in the audit log."
      width="xl"
      footer={
        <>
          {view?.jobId && (
            <>
              <a href={href('runs', view.jobId)} className="mr-auto text-[13px] text-primary hover:underline" onClick={onClose}>
                Open the current run
              </a>
              <Button
                variant="danger"
                icon={<Icon name="square" size={14} />}
                disabled={stopping}
                onClick={async () => {
                  setStopping(true);
                  try {
                    await api(`/api/jobs/${view.jobId}/cancel`, { method: 'POST', body: {} });
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setStopping(false);
                  }
                }}
              >
                Stop the run
              </Button>
            </>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2">
        {error ? (
          <p className="p-6 text-[13px] text-danger" role="alert">{error}</p>
        ) : view && !view.online ? (
          <p className="p-6 text-[13px] text-muted">The robot is offline.</p>
        ) : frame?.error ? (
          <p className="p-6 text-[13px] text-muted">{frame.error}</p>
        ) : frame?.image ? (
          <img src={frame.image} alt={`Screen of ${robot?.name}`} className="h-auto max-h-[70vh] w-full object-contain" />
        ) : (
          <p className="flex items-center gap-2 p-6 text-[13px] text-muted">
            <Icon name="loader" size={14} className="animate-spin" /> Waiting for the first picture…
          </p>
        )}
      </div>
    </Dialog>
  );
}
