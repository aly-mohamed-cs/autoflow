import { findStep, type Flow } from '@autoflow/flow-types';
import { Button, Dialog, Icon } from '@autoflow/ui';
import { useMemo, useState } from 'react';
import { useMe } from '../App';
import { Card, ErrorBox, Loading, PageHeader, StatusBadge } from '../components/common';
import { StepTree, type StepRun } from '../components/StepTree';
import { api, can, useApi, type Job } from '../lib/api';
import { dateTime, duration, TRIGGER_LABELS } from '../lib/format';
import { useLive } from '../lib/live';
import { href } from '../lib/router';

interface RunEvent {
  event: string;
  ts: number;
  step_id?: string;
  status?: string;
  duration_ms?: number;
  continued?: boolean;
  error?: { message: string; hint?: string | null };
  level?: string;
  message?: string;
  artifact_id?: string;
  reason?: string;
}

interface Detail {
  job: Job;
  events: RunEvent[];
  artifacts: { id: string; stepId: string | null; kind: string; name: string }[];
  definition: Flow;
}

export function RunPage({ id }: { id: string }) {
  const me = useMe();
  const { data, error, reload, setData } = useApi<Detail>(`/api/jobs/${encodeURIComponent(id)}`, [id]);
  const [shot, setShot] = useState<string | null>(null);

  useLive((e) => {
    if (e.type === 'job.event' && e.jobId === id) {
      setData((d) => (d ? { ...d, events: [...d.events, e.event as unknown as RunEvent] } : d));
    } else if (e.type === 'job.updated' && e.job.id === id) {
      reload(); // status, outputs and screenshots
    }
  });

  const steps = useMemo(() => summarize(data?.events ?? []), [data?.events]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const { job } = data;
  const active = job.status === 'queued' || job.status === 'running';
  const shotsByStep = new Map<string, string[]>();
  for (const a of data.artifacts) if (a.kind === 'screenshot' && a.stepId) shotsByStep.set(a.stepId, [...(shotsByStep.get(a.stepId) ?? []), a.id]);

  return (
    <>
      <PageHeader
        back={{ label: job.flowName ?? 'Automation', to: href('automations', job.flowId) }}
        title={
          <span className="flex items-center gap-3">
            Run of {job.flowName} <StatusBadge status={job.status} />
          </span>
        }
        actions={
          active && can(me.role, 'operator') && !job.cancelRequested ? (
            <Button variant="danger" icon={<Icon name="square" size={13} />} onClick={async () => { await api(`/api/jobs/${id}/cancel`, { method: 'POST' }); reload(); }}>
              Stop run
            </Button>
          ) : job.cancelRequested && active ? (
            <span className="text-[13px] text-warning">Stopping…</span>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {job.error && (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft p-4">
              <p className="flex items-center gap-2 font-semibold text-danger">
                <Icon name="circle-x" size={18} /> {job.error.message}
              </p>
              {job.error.hint && <p className="mt-1 text-[13px] text-muted">{job.error.hint}</p>}
              {can(me.role, 'operator') && <ExplainError flow={data.definition} error={job.error} />}
            </div>
          )}
          {job.status === 'queued' && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface p-4 text-[13px] text-muted">
              <Icon name="clock" size={16} /> Waiting for a free robot{job.robotName ? '' : ' in this pool'}. It starts automatically.
            </div>
          )}
          <Card title="Steps">
            <StepTree
              flow={data.definition}
              runs={steps.status}
              details={(stepId) => (
                <>
                  {(steps.logs[stepId] ?? []).map((l, i) => (
                    <p key={i} className={l.level === 'warning' ? 'text-xs text-warning' : l.level === 'error' ? 'text-xs text-danger' : 'text-xs text-muted'}>
                      {l.message}
                    </p>
                  ))}
                  {(shotsByStep.get(stepId) ?? []).map((a) => (
                    <button key={a} type="button" onClick={() => setShot(a)} className="mt-1 mr-1 inline-block">
                      <img src={`/api/artifacts/${a}`} alt="Screenshot of this step" className="h-16 rounded border border-border" />
                    </button>
                  ))}
                </>
              )}
            />
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Details">
            <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-[13px]">
              <dt className="text-muted">Started by</dt>
              <dd>{job.triggeredBy ?? TRIGGER_LABELS[job.trigger]}</dd>
              <dt className="text-muted">Version</dt>
              <dd>v{job.version}</dd>
              <dt className="text-muted">Robot</dt>
              <dd>{job.robotName ?? '—'}</dd>
              <dt className="text-muted">Queued</dt>
              <dd>{dateTime(job.queuedAt)}</dd>
              <dt className="text-muted">Started</dt>
              <dd>{dateTime(job.startedAt)}</dd>
              <dt className="text-muted">Finished</dt>
              <dd>{dateTime(job.finishedAt)}</dd>
              <dt className="text-muted">Took</dt>
              <dd>{duration(job.durationMs)}</dd>
            </dl>
          </Card>
          <Values title="Start values" values={job.inputs} />
          {job.outputs && Object.keys(job.outputs).length > 0 && <Values title="Results" values={job.outputs} />}
        </div>
      </div>
      <Dialog open={!!shot} onOpenChange={(o) => !o && setShot(null)} title="Screenshot" width="xl">
        {shot && <img src={`/api/artifacts/${shot}`} alt="Screenshot taken during the run" className="w-full rounded border border-border" />}
      </Dialog>
    </>
  );
}

/** Ask the company's local AI model what went wrong (only shown when an admin turned it on). */
function ExplainError({ flow, error }: { flow: Flow; error: NonNullable<Job['error']> }) {
  const { data: ai } = useApi<{ enabled: boolean }>('/api/ai/status');
  const [state, setState] = useState<{ busy: boolean; text?: string; failed?: boolean }>({ busy: false });
  if (!ai?.enabled) return null;
  const step = error.step_id ? findStep(flow, error.step_id) : undefined;
  if (state.text) {
    return (
      <div className={`mt-3 flex gap-2 rounded-md border p-3 text-[13px] ${state.failed ? 'border-border text-muted' : 'border-primary/30 bg-surface'}`}>
        <Icon name="sparkles" size={16} className="mt-0.5 shrink-0 text-primary" />
        <p className="whitespace-pre-line">{state.text}</p>
      </div>
    );
  }
  return (
    <Button
      size="sm"
      className="mt-3"
      disabled={state.busy}
      icon={<Icon name="sparkles" size={14} />}
      onClick={async () => {
        setState({ busy: true });
        try {
          const r = await api<{ explanation: string }>('/api/ai/explain-error', {
            body: { activity: step?.activity ?? 'unknown', message: error.message, hint: error.hint ?? null, params: step?.params ?? {} },
          });
          setState({ busy: false, text: r.explanation });
        } catch (e) {
          setState({ busy: false, text: (e as Error).message, failed: true });
        }
      }}
    >
      {state.busy ? 'Asking the AI assistant…' : 'Explain this error'}
    </Button>
  );
}

function Values({ title, values }: { title: string; values: Record<string, unknown> }) {
  const entries = Object.entries(values);
  return (
    <Card title={title}>
      {entries.length === 0 ? (
        <p className="text-[13px] text-subtle">None</p>
      ) : (
        <dl className="space-y-2 text-[13px]">
          {entries.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="font-mono text-xs break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

/** Collapse the event stream into per-step status and logs. */
function summarize(events: RunEvent[]) {
  const status: Record<string, StepRun> = {};
  const logs: Record<string, { level: string; message: string }[]> = {};
  for (const e of events) {
    if (!e.step_id) continue;
    if (e.event === 'step_started') status[e.step_id] = { status: 'running' };
    else if (e.event === 'step_finished') {
      status[e.step_id] = {
        status: e.continued ? 'continued' : ((e.status as StepRun['status']) ?? 'ok'),
        durationMs: e.duration_ms,
        error: e.error,
      };
    } else if (e.event === 'log' && e.message) {
      (logs[e.step_id] ??= []).push({ level: e.level ?? 'info', message: e.message });
    }
  }
  return { status, logs };
}
