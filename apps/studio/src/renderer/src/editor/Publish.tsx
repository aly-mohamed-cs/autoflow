import { Button, Dialog, Field, Icon, Textarea, Tooltip } from '@autoflow/ui';
import { useState } from 'react';
import { errorMessage, useApp } from '../store/app';
import { useEditor } from '../store/editor';

/** Publish the automation to the Orchestrator so robots can run it. */
export function PublishButton() {
  const orchestrator = useApp((s) => s.orchestrator);
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const issues = useEditor((s) => s.issues);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ version: number; url: string } | null>(null);
  const errors = issues.filter((i) => i.severity === 'error').length;

  if (!orchestrator) {
    return (
      <Tooltip content="Connect Studio to your Orchestrator in Settings to publish">
        <Button onClick={() => navigate({ page: 'settings' })} icon={<Icon name="cloud-upload" size={15} />}>Publish</Button>
      </Tooltip>
    );
  }

  const publish = async () => {
    const flow = useEditor.getState().flow;
    if (!flow) return;
    setBusy(true);
    try {
      setDone(await window.autoflow.orchestrator.publish(flow, notes.trim()));
      setNotes('');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button onClick={() => { setDone(null); setOpen(true); }} icon={<Icon name="cloud-upload" size={15} />}>Publish</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={done ? `Published version ${done.version}` : 'Publish to the Orchestrator'}
        description={done ? 'Robots use this version for every new run.' : `As ${orchestrator.displayName} to ${orchestrator.url}`}
        footer={
          done ? (
            <>
              <Button onClick={() => window.open(done.url, '_blank')} icon={<Icon name="external-link" size={14} />}>Open in dashboard</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={busy} disabled={errors > 0} onClick={publish} icon={<Icon name="cloud-upload" size={15} />}>Publish</Button>
            </>
          )
        }
      >
        {done ? (
          <p className="flex items-center gap-2 text-[13px] text-success"><Icon name="circle-check" size={18} /> Done. Run it, schedule it or connect it to other systems from the dashboard.</p>
        ) : (
          <div className="space-y-3">
            {errors > 0 && (
              <p className="rounded-md bg-danger-soft p-3 text-[13px] text-danger">
                {errors === 1 ? '1 setting still needs' : `${errors} settings still need`} fixing (see Problems). Fix them before publishing.
              </p>
            )}
            <Field label="What changed?" htmlFor="pub-notes" help="Optional. Shown in the version history.">
              <Textarea id="pub-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Also fills in the due date" />
            </Field>
            <p className="text-xs text-subtle">Test it here first with Test run — robots run exactly what you publish.</p>
          </div>
        )}
      </Dialog>
    </>
  );
}
