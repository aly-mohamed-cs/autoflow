// "My work plan" (attended automations, Brity's work plans): published automations a person runs on
// their own PC - now, from the tray, or on their own schedule while Studio is open. The newest
// published version runs in Studio's engine with the credentials saved on this PC (the Orchestrator
// never hands passwords to people's PCs).
import { Notification, type MenuItemConstructorOptions } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Flow } from '@autoflow/flow-types';
import type { WorkPlanEntry, WorkPlanRun, WorkPlanState } from '../shared/api';
import type { Orchestrator } from './orchestrator';
import { nextRun } from './schedule';

const HISTORY = 50;
const TICK_MS = 20_000;

export interface WorkPlanHost {
  /** Start a run in the engine; rejects when a run is already going (e.g. a test run). */
  start(flow: Flow, inputs: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
  changed(state: WorkPlanState): void;
}

export class WorkPlan {
  private readonly file: string;
  private entries: WorkPlanEntry[] = [];
  private history: WorkPlanRun[] = [];
  private current: WorkPlanRun | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    userData: string,
    private readonly orchestrator: Orchestrator,
    private readonly host: WorkPlanHost,
  ) {
    this.file = join(userData, 'workplan.json');
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8')) as { entries?: WorkPlanEntry[]; history?: WorkPlanRun[] };
      this.entries = saved.entries ?? [];
      this.history = saved.history ?? [];
    } catch {
      /* first start */
    }
    // Times missed while Studio was closed are not made up for: plan from now on.
    const now = new Date();
    for (const e of this.entries) e.nextRunAt = e.enabled ? (nextRun(e.schedule, now)?.toISOString() ?? null) : null;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  state(): WorkPlanState {
    return { entries: this.entries, history: this.history, running: this.current?.entryId ?? null };
  }

  /** "Run on this PC" items for the tray menu. */
  trayItems(): MenuItemConstructorOptions[] {
    if (!this.entries.length) return [];
    return [
      {
        label: 'Run on this PC',
        submenu: this.entries.map((e) => ({
          label: e.flowName,
          enabled: !this.current,
          click: () => void this.run(e.id, 'tray'),
        })),
      },
      ...(this.current ? [{ label: `Stop “${this.current.flowName}”`, click: () => void this.stop() }] : []),
    ];
  }

  /** Anything scheduled: Studio then stays in the tray when its window is closed. */
  get scheduled(): boolean {
    return this.entries.some((e) => e.enabled && e.schedule.kind !== 'manual');
  }

  async save(entries: WorkPlanEntry[]): Promise<WorkPlanState> {
    const now = new Date();
    this.entries = entries.map((e) => ({ ...e, nextRunAt: e.enabled ? (nextRun(e.schedule, now)?.toISOString() ?? null) : null }));
    await this.persist();
    return this.state();
  }

  async run(entryId: string, trigger: WorkPlanRun['trigger'] = 'manual'): Promise<WorkPlanState> {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error('That automation is no longer in your work plan.');
    const record: WorkPlanRun = { id: `${Date.now()}`, entryId, flowName: entry.flowName, trigger, startedAt: new Date().toISOString(), finishedAt: null, status: 'running' };
    if (this.current) return this.skip(record, `“${this.current.flowName}” was still running.`);
    let flow: Flow | null = null;
    try {
      const detail = await this.orchestrator.request<{ definition: Flow | null }>('GET', `/api/flows/${encodeURIComponent(entry.flowId)}`);
      flow = detail.definition;
    } catch (err) {
      return this.skip(record, `Could not get the automation from the Orchestrator: ${(err as Error).message}`);
    }
    if (!flow) return this.skip(record, 'The automation has no published version.');
    this.current = record;
    this.addHistory(record);
    try {
      await this.host.start(flow, entry.inputs ?? {});
    } catch (err) {
      this.current = null;
      const busy = /already running/i.test((err as Error).message);
      Object.assign(record, { status: 'skipped', finishedAt: new Date().toISOString(), error: busy ? 'Studio was already running something (e.g. a test run).' : (err as Error).message });
    }
    await this.persist();
    return this.state();
  }

  async stop(): Promise<void> {
    if (this.current) await this.host.stop();
  }

  /** Engine events while a work plan run is going; false when the run belongs to the editor. */
  onEngineEvent(event: { event?: string; status?: string; error?: { message?: string } | null }): boolean {
    if (!this.current) return false;
    if (event.event === 'run_finished') {
      const record = this.current;
      this.current = null;
      record.finishedAt = new Date().toISOString();
      record.status = (event.status as WorkPlanRun['status']) ?? 'failed';
      if (event.error?.message) record.error = event.error.message;
      const entry = this.entries.find((e) => e.id === record.entryId);
      if (entry) Object.assign(entry, { lastRunAt: record.finishedAt, lastStatus: record.status });
      void this.persist();
      notify(
        record.status === 'succeeded' ? `“${record.flowName}” finished` : `“${record.flowName}” ${record.status === 'cancelled' ? 'was stopped' : 'failed'}`,
        record.error ?? (record.status === 'succeeded' ? 'It ran on this PC.' : ''),
      );
    }
    return true;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    for (const entry of this.entries) {
      if (!entry.enabled || !entry.nextRunAt || Date.parse(entry.nextRunAt) > now.getTime()) continue;
      entry.nextRunAt = nextRun(entry.schedule, now)?.toISOString() ?? null;
      await this.run(entry.id, 'schedule');
    }
  }

  private async skip(record: WorkPlanRun, reason: string): Promise<WorkPlanState> {
    Object.assign(record, { status: 'skipped', finishedAt: new Date().toISOString(), error: reason });
    this.addHistory(record);
    if (record.trigger !== 'manual') notify(`“${record.flowName}” did not run`, reason);
    await this.persist();
    return this.state();
  }

  private addHistory(record: WorkPlanRun): void {
    this.history = [record, ...this.history].slice(0, HISTORY);
  }

  private async persist(): Promise<void> {
    await fs.writeFile(this.file, JSON.stringify({ entries: this.entries, history: this.history }, null, 2), 'utf8');
    this.host.changed(this.state());
  }
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}
