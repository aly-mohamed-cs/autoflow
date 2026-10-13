// Event triggers: "a new file appears in a folder", "a new email arrives". Like Brity's event
// triggers they are watched on a robot (which can see the shared folders and the mailbox): the
// Orchestrator gives each trigger to one online robot of its pool, the robot reports what it
// finds, and each new file or email starts one run.
import { z } from 'zod';
import type { Db } from '../db.js';
import { json, now } from '../db.js';
import { newId } from '../security.js';
import { badRequest, notFound } from './core.js';
import type { Gateway } from './gateway.js';
import type { Jobs } from './jobs.js';

export const FileConfig = z.object({
  folder: z.string().trim().min(1).max(500),
  pattern: z.string().trim().max(200).default('*'),
  subfolders: z.boolean().default(false),
  intervalS: z.number().int().min(10).max(3600).default(30),
});
export const EmailConfig = z.object({
  server: z.string().trim().min(1).max(200),
  credential: z.string().trim().min(1).max(100),
  mailbox: z.string().trim().max(200).default(''),
  folder: z.string().trim().max(200).default('Inbox'),
  subjectContains: z.string().trim().max(200).default(''),
  fromContains: z.string().trim().max(200).default(''),
  unreadOnly: z.boolean().default(true),
  intervalS: z.number().int().min(30).max(3600).default(60),
});
const Common = {
  flowId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  pool: z.string().trim().min(1).max(64).default('default'),
  enabled: z.boolean().default(true),
  /** Also start runs for files / emails that are already there when the trigger is created. */
  includeExisting: z.boolean().default(false),
};
export const TriggerBody = z.discriminatedUnion('kind', [
  z.object({ ...Common, kind: z.literal('file'), config: FileConfig }),
  z.object({ ...Common, kind: z.literal('email'), config: EmailConfig }),
]);
export type TriggerInput = z.infer<typeof TriggerBody>;

/** What a robot reports for a new file or email. */
const FiredFile = z.object({ path: z.string().max(1000), name: z.string().max(300) });
const FiredEmail = z.object({
  id: z.string().max(1000),
  from: z.string().max(500).default(''),
  subject: z.string().max(1000).default(''),
  received: z.string().max(60).default(''),
  text: z.string().max(20_000).default(''),
  attachments: z.string().max(5000).default(''),
});

export interface EventTriggerRow {
  id: string;
  flow_id: string;
  name: string;
  kind: 'file' | 'email';
  config: string;
  pool: string;
  enabled: number;
  since: string | null;
  watcher_robot_id: string | null;
  last_fired_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
}

export interface TriggerFired {
  type: 'trigger.fired';
  trigger_id: string;
  key: string;
  data: Record<string, unknown>;
}
export interface TriggerStatus {
  type: 'trigger.status';
  trigger_id: string;
  error: string | null;
}

export class EventTriggers {
  constructor(
    private readonly db: Db,
    private readonly jobs: Jobs,
    private readonly gateway: Gateway,
  ) {
    gateway.onRobotsChanged.push(() => this.assign());
    gateway.onTriggerMessage = (robotId, msg) => (msg.type === 'trigger.fired' ? this.fired(robotId, msg) : this.status(robotId, msg));
  }

  list() {
    return this.db
      .all<EventTriggerRow & { flow_name: string; watcher_name: string | null }>(
        `SELECT t.*, f.name AS flow_name, r.name AS watcher_name FROM event_triggers t
         JOIN flows f ON f.id = t.flow_id LEFT JOIN robots r ON r.id = t.watcher_robot_id ORDER BY t.name COLLATE NOCASE`,
      )
      .map((t) => ({
        id: t.id,
        flowId: t.flow_id,
        flowName: t.flow_name,
        name: t.name,
        kind: t.kind,
        config: json<Record<string, unknown>>(t.config, {}),
        pool: t.pool,
        enabled: !!t.enabled,
        includeExisting: t.since === null,
        watcher: t.watcher_robot_id ? { id: t.watcher_robot_id, name: t.watcher_name ?? t.watcher_robot_id, online: this.gateway.isOnline(t.watcher_robot_id) } : null,
        lastFiredAt: t.last_fired_at,
        lastError: t.last_error,
        runs: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trigger_events WHERE trigger_id = ?', t.id)?.n ?? 0,
        createdBy: t.created_by,
        createdAt: t.created_at,
      }));
  }

  save(input: TriggerInput, by: string, id?: string): string {
    if (!this.db.get('SELECT 1 FROM flows WHERE id = ? AND archived = 0', input.flowId)) throw notFound('The automation');
    const existing = id ? this.db.get<EventTriggerRow>('SELECT * FROM event_triggers WHERE id = ?', id) : undefined;
    if (id && !existing) throw notFound('The trigger');
    if (existing && existing.kind !== input.kind) throw badRequest('A trigger cannot change between file and email; create a new one.');
    // Files and emails from before the trigger existed don't start runs, unless asked to.
    const since = input.includeExisting ? null : (existing?.since ?? now());
    const triggerId = id ?? newId('trg');
    if (existing) {
      this.db.run(
        `UPDATE event_triggers SET flow_id = ?, name = ?, config = ?, pool = ?, enabled = ?, since = ?, last_error = NULL WHERE id = ?`,
        input.flowId,
        input.name,
        JSON.stringify(input.config),
        input.pool,
        input.enabled ? 1 : 0,
        since,
        triggerId,
      );
    } else {
      this.db.run(
        `INSERT INTO event_triggers (id, flow_id, name, kind, config, pool, enabled, since, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        triggerId,
        input.flowId,
        input.name,
        input.kind,
        JSON.stringify(input.config),
        input.pool,
        input.enabled ? 1 : 0,
        since,
        by,
        now(),
      );
    }
    this.assign(true);
    return triggerId;
  }

  remove(id: string): boolean {
    const removed = this.db.run('DELETE FROM event_triggers WHERE id = ?', id).changes > 0;
    if (removed) this.assign(true);
    return removed;
  }

  get(id: string): EventTriggerRow | undefined {
    return this.db.get<EventTriggerRow>('SELECT * FROM event_triggers WHERE id = ?', id);
  }

  /**
   * Give every enabled trigger to one online robot of its pool (keeping the current one while it
   * stays online) and tell each robot what to watch. `force` re-sends the lists to all robots.
   */
  assign(force = false): void {
    const online = this.gateway.onlineRobots();
    const load = new Map(online.map((r) => [r.robotId, 0]));
    const before = new Map<string, string[]>();
    const triggers = this.db.all<EventTriggerRow>('SELECT * FROM event_triggers ORDER BY created_at');
    for (const t of triggers) {
      if (t.watcher_robot_id) before.set(t.watcher_robot_id, [...(before.get(t.watcher_robot_id) ?? []), t.id]);
    }
    for (const t of triggers) {
      let watcher: string | null = null;
      if (t.enabled) {
        const candidates = online.filter((r) => r.pool === t.pool);
        const current = candidates.find((r) => r.robotId === t.watcher_robot_id);
        watcher = current?.robotId ?? candidates.sort((a, b) => load.get(a.robotId)! - load.get(b.robotId)!)[0]?.robotId ?? null;
      }
      if (watcher) load.set(watcher, load.get(watcher)! + 1);
      if (watcher !== t.watcher_robot_id) {
        this.db.run('UPDATE event_triggers SET watcher_robot_id = ? WHERE id = ?', watcher, t.id);
        t.watcher_robot_id = watcher;
      }
    }
    for (const robot of online) {
      const mine = triggers.filter((t) => t.enabled && t.watcher_robot_id === robot.robotId);
      const changed = force || JSON.stringify(before.get(robot.robotId) ?? []) !== JSON.stringify(mine.map((t) => t.id)) || robot.fresh;
      if (changed) this.gateway.sendTo(robot.robotId, { type: 'watch', triggers: mine.map((t) => this.forRobot(t)) });
    }
  }

  private forRobot(t: EventTriggerRow) {
    return { id: t.id, kind: t.kind, config: json<Record<string, unknown>>(t.config, {}), since: t.since };
  }

  /** A robot found a new file or email: one run per new one. */
  private fired(robotId: string, msg: TriggerFired): void {
    const t = this.get(String(msg.trigger_id));
    if (!t || !t.enabled || t.watcher_robot_id !== robotId) return;
    const key = String(msg.key ?? '').slice(0, 1000);
    if (!key) return;
    let inputs: Record<string, unknown>;
    try {
      inputs =
        t.kind === 'file'
          ? (({ path, name }) => ({ trigger_file: path, trigger_file_name: name }))(FiredFile.parse(msg.data))
          : { trigger_email: FiredEmail.parse(msg.data) };
    } catch {
      return; // not what this kind of trigger reports
    }
    const fresh = this.db.run('INSERT OR IGNORE INTO trigger_events (trigger_id, key, created_at) VALUES (?, ?, ?)', t.id, key, now()).changes > 0;
    if (!fresh) return;
    try {
      const job = this.jobs.create({ flowId: t.flow_id, trigger: 'event', triggerRef: t.id, triggeredBy: `Trigger “${t.name}”`, inputs, pool: t.pool });
      this.db.run('UPDATE trigger_events SET job_id = ? WHERE trigger_id = ? AND key = ?', job.id, t.id, key);
      this.db.run('UPDATE event_triggers SET last_fired_at = ?, last_error = NULL WHERE id = ?', now(), t.id);
    } catch (err) {
      // e.g. the automation was never published: try again when the robot reports it next time.
      this.db.run('DELETE FROM trigger_events WHERE trigger_id = ? AND key = ?', t.id, key);
      this.db.run('UPDATE event_triggers SET last_error = ? WHERE id = ?', (err as Error).message.slice(0, 500), t.id);
    }
  }

  /** A robot reports a problem watching (folder not found, mailbox sign-in failed...) or that it is fine again. */
  private status(robotId: string, msg: TriggerStatus): void {
    const t = this.get(String(msg.trigger_id));
    if (!t || t.watcher_robot_id !== robotId) return;
    this.db.run('UPDATE event_triggers SET last_error = ? WHERE id = ?', msg.error ? String(msg.error).slice(0, 500) : null, t.id);
  }
}
