import { Button, Icon } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../shared/api';

/** Shown when a newer Studio has been downloaded from the Orchestrator. */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });
  useEffect(() => {
    void window.autoflow.updates.status().then(setStatus);
    return window.autoflow.updates.onChange(setStatus);
  }, []);
  if (status.state !== 'ready') return null;
  return (
    <div role="status" className="flex items-center gap-3 border-b border-primary/30 bg-primary-soft px-4 py-2 text-[13px]">
      <Icon name="sparkles" size={16} className="text-primary" />
      <span className="flex-1">
        Autoflow Studio <strong>{status.version}</strong> is ready. Your work is saved — restart to start using it.
      </span>
      <Button size="sm" variant="primary" onClick={() => void window.autoflow.updates.install()}>
        Restart to update
      </Button>
    </div>
  );
}
