import { Badge, Button, cn, EmptyState, Icon, Input, Select, Switch } from '@autoflow/ui';
import { useEffect, useState } from 'react';
import type { PublishedFlow, WorkPlanEntry, WorkPlanRun, WorkPlanSchedule, WorkPlanState } from '../../../shared/api';
import { errorMessage, useApp } from '../store/app';

const KINDS: { value: WorkPlanSchedule['kind']; label: string }[] = [
  { value: 'manual', label: 'Only when I start it' },
  { value: 'daily', label: 'Every day at' },
  { value: 'weekdays', label: 'Monday to Friday at' },
  { value: 'every', label: 'Every … minutes' },
];

const STATUS: Record<WorkPlanRun['status'], { tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger'; label: string }> = {
  running: { tone: 'primary', label: 'Running' },
  succeeded: { tone: 'success', label: 'Finished' },
  failed: { tone: 'danger', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Stopped' },
  skipped: { tone: 'warning', label: 'Did not run' },
};

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** Published automations run on this PC (attended), now or on a schedule. */
export function WorkPlanPage() {
  const connected = useApp((s) => s.orchestrator);
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const [state, setState] = useState<WorkPlanState | null>(null);
  const [flows, setFlows] = useState<PublishedFlow[]>([]);
  const [adding, setAdding] = useState('');

  useEffect(() => {
    void window.autoflow.workPlan.state().then(setState);
    const off = window.autoflow.workPlan.onChange(setState);
    if (connected) window.autoflow.orchestrator.flows().then(setFlows).catch((e) => toast(errorMessage(e), 'error'));
    return off;
  }, [connected, toast]);

  const save = async (entries: WorkPlanEntry[]) => {
    try {
      setState(await window.autoflow.workPlan.save(entries));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const update = (id: string, patch: Partial<WorkPlanEntry>) => void save(state!.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">My work plan</h1>
        <p className="mt-0.5 text-muted">
          Run published automations on this PC — when you start them, from the tray, or on your own schedule while Studio is open. They use
          the credentials saved on this PC.
        </p>

        {!connected ? (
          <div className="mt-6 rounded-lg border border-border bg-surface p-6 text-center">
            <p className="text-[13px] text-muted">Connect Studio to the Orchestrator to add published automations.</p>
            <Button className="mt-3" onClick={() => navigate({ page: 'settings' })}>Open settings</Button>
          </div>
        ) : (
          <div className="mt-6 flex gap-2">
            <Select
              aria-label="Published automation"
              className="flex-1"
              value={adding}
              onChange={setAdding}
              placeholder="Choose a published automation"
              options={flows.filter((f) => !state?.entries.some((e) => e.flowId === f.id)).map((f) => ({ value: f.id, label: f.name }))}
            />
            <Button
              variant="primary"
              icon={<Icon name="plus" size={15} />}
              disabled={!adding || !state}
              onClick={() => {
                const flow = flows.find((f) => f.id === adding)!;
                void save([
                  ...state!.entries,
                  { id: `wp_${Date.now()}`, flowId: flow.id, flowName: flow.name, enabled: true, schedule: { kind: 'manual', time: '09:00', minutes: 60 } },
                ]);
                setAdding('');
              }}
            >
              Add to my work plan
            </Button>
          </div>
        )}

        <ul className="mt-6 space-y-3" aria-label="My work plan">
          {state?.entries.map((entry) => {
            const running = state.running === entry.id;
            const s = entry.schedule;
            return (
              <li key={entry.id} className="rounded-lg border border-border bg-surface p-4 shadow-card">
                <div className="flex flex-wrap items-center gap-3">
                  <Icon name="monitor-play" size={18} className="text-primary" />
                  <span className="flex-1 font-semibold">{entry.flowName}</span>
                  {entry.lastStatus && <Badge tone={STATUS[entry.lastStatus].tone}>{STATUS[entry.lastStatus].label} {when(entry.lastRunAt)}</Badge>}
                  {running ? (
                    <Button variant="danger" size="sm" icon={<Icon name="square" size={13} />} onClick={() => void window.autoflow.workPlan.stop()}>
                      Stop
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Icon name="play" size={13} />}
                      disabled={!!state.running}
                      onClick={async () => {
                        try {
                          setState(await window.autoflow.workPlan.run(entry.id));
                        } catch (e) {
                          toast(errorMessage(e), 'error');
                        }
                      }}
                    >
                      Run on this PC
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" aria-label={`Remove ${entry.flowName}`} onClick={() => void save(state.entries.filter((e) => e.id !== entry.id))}>
                    <Icon name="trash" size={14} />
                  </Button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
                  <Select aria-label="When it runs" className="w-56" value={s.kind} options={KINDS} onChange={(kind) => update(entry.id, { schedule: { ...s, kind: kind as WorkPlanSchedule['kind'] } })} />
                  {(s.kind === 'daily' || s.kind === 'weekdays') && (
                    <Input aria-label="Time" type="time" className="w-32" value={s.time} onChange={(e) => e.target.value && update(entry.id, { schedule: { ...s, time: e.target.value } })} />
                  )}
                  {s.kind === 'every' && (
                    <Input
                      aria-label="Minutes"
                      type="number"
                      min={5}
                      className="w-24"
                      value={s.minutes}
                      onChange={(e) => update(entry.id, { schedule: { ...s, minutes: Math.max(5, Number(e.target.value) || 5) } })}
                    />
                  )}
                  {s.kind !== 'manual' && (
                    <label className="ml-auto flex items-center gap-2 text-muted">
                      <Switch checked={entry.enabled} onChange={(enabled) => update(entry.id, { enabled })} label={`Schedule of ${entry.flowName} on`} />
                      {entry.enabled && entry.nextRunAt ? `Next: ${when(entry.nextRunAt)}` : 'Paused'}
                    </label>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {state && state.entries.length === 0 && (
          <EmptyState className="mt-6" icon={<Icon name="calendar-clock" size={28} />} title="Nothing in your work plan yet">
            Add the automations you start yourself, e.g. a report you run every morning.
          </EmptyState>
        )}

        {!!state?.history.length && (
          <section className="mt-10">
            <h2 className="mb-2 text-[13px] font-semibold text-muted">Recent runs on this PC</h2>
            <ul className="divide-y divide-border rounded-lg border border-border bg-surface" aria-label="Recent runs on this PC">
              {state.history.slice(0, 20).map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-[13px]">
                  <Badge tone={STATUS[run.status].tone}>{STATUS[run.status].label}</Badge>
                  <span className="font-medium">{run.flowName}</span>
                  <span className="text-subtle">{when(run.startedAt)}{run.trigger !== 'manual' ? ` · ${run.trigger === 'schedule' ? 'scheduled' : 'from the tray'}` : ''}</span>
                  {run.error && <span className={cn('w-full text-xs', run.status === 'skipped' ? 'text-warning' : 'text-danger')}>{run.error}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
