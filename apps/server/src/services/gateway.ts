// Robots connect here over WebSocket (outbound from the robot, so robot PCs need no
// inbound firewall rules). The gateway hands queued jobs to idle robots and records
// what they report back.
import type { WebSocket } from 'ws';
import type { Db } from '../db.js';
import { json, now } from '../db.js';
import type { Bus } from './core.js';
import type { JobRow, Jobs } from './jobs.js';

interface Connection {
  robotId: string;
  pool: string;
  socket: WebSocket;
  /** Job the robot is working on (or was just offered). */
  jobId: string | null;
  lastSeen: number;
}

export type RobotMessage =
  | { type: 'hello'; version?: string; capabilities?: string[]; machine?: string; busy_job_id?: string | null }
  | { type: 'heartbeat'; busy_job_id?: string | null }
  | { type: 'job.event'; job_id: string; event: Record<string, unknown> }
  | { type: 'job.finished'; job_id: string; status: 'succeeded' | 'failed' | 'cancelled'; duration_ms?: number; outputs?: Record<string, unknown>; error?: { message: string; hint?: string | null; step_id?: string } | null }
  | { type: 'job.rejected'; job_id: string; reason?: string };

const DISCONNECT_GRACE_MS = 90_000;
const CANCEL_GRACE_MS = 60_000;

export class Gateway {
  private readonly connections = new Map<string, Connection>();
  private readonly lostJobs = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null;
  /** Whether a job's robot may ask the AI assistant to fix failed steps (set by createServices). */
  repairAllowed: (job: JobRow) => boolean = () => false;

  constructor(
    private readonly db: Db,
    private readonly jobs: Jobs,
    private readonly bus: Bus,
  ) {
    jobs.onQueued.push(() => this.dispatch());
  }

  start(): void {
    // Jobs left "running" by a server restart: give robots a chance to reconnect and claim them.
    for (const job of this.db.all<{ id: string }>(`SELECT id FROM jobs WHERE status = 'running'`)) this.watchLost(job.id);
    this.timer = setInterval(() => {
      this.dispatch();
      this.enforceTimeouts();
    }, 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.lostJobs.values()) clearTimeout(t);
    for (const c of this.connections.values()) c.socket.close(1001, 'Server shutting down');
  }

  isOnline(robotId: string): boolean {
    return this.connections.has(robotId);
  }

  busyJob(robotId: string): string | null {
    return this.connections.get(robotId)?.jobId ?? null;
  }

  /** A robot authenticated and opened its connection. */
  attach(robotId: string, socket: WebSocket): void {
    const robot = this.db.get<{ pool: string; enabled: number }>('SELECT pool, enabled FROM robots WHERE id = ?', robotId);
    if (!robot || !robot.enabled) {
      socket.close(4003, 'Robot disabled');
      return;
    }
    this.connections.get(robotId)?.socket.close(4000, 'Replaced by a newer connection');
    const conn: Connection = { robotId, pool: robot.pool, socket, jobId: null, lastSeen: Date.now() };
    this.connections.set(robotId, conn);
    this.touch(robotId);
    socket.on('message', (raw) => this.onMessage(conn, raw.toString()));
    socket.on('close', () => this.detach(conn));
    socket.on('error', () => undefined);
    this.send(conn, { type: 'welcome', robot_id: robotId, server_time: new Date().toISOString() });
    this.publishRobot(robotId);
  }

  private detach(conn: Connection): void {
    if (this.connections.get(conn.robotId) !== conn) return;
    this.connections.delete(conn.robotId);
    if (conn.jobId) this.watchLost(conn.jobId);
    this.publishRobot(conn.robotId);
  }

  /** If nobody reports progress on a running job for a while, fail it. */
  private watchLost(jobId: string): void {
    if (this.lostJobs.has(jobId)) return;
    this.lostJobs.set(
      jobId,
      setTimeout(() => {
        this.lostJobs.delete(jobId);
        const job = this.jobs.get(jobId);
        if (job?.status === 'running') {
          this.jobs.finish(jobId, {
            status: 'failed',
            error: {
              message: 'The robot stopped responding during the run.',
              hint: 'Check that the robot computer is on, signed in and connected to the network.',
            },
          });
        }
      }, DISCONNECT_GRACE_MS),
    );
  }

  private onMessage(conn: Connection, raw: string): void {
    let msg: RobotMessage;
    try {
      msg = JSON.parse(raw) as RobotMessage;
    } catch {
      return;
    }
    conn.lastSeen = Date.now();
    this.touch(conn.robotId);
    switch (msg.type) {
      case 'hello':
        this.db.run(
          'UPDATE robots SET version = ?, capabilities = ?, machine = COALESCE(?, machine) WHERE id = ?',
          msg.version ?? '',
          JSON.stringify(msg.capabilities ?? []),
          msg.machine ?? null,
          conn.robotId,
        );
        this.resume(conn, msg.busy_job_id ?? null);
        this.publishRobot(conn.robotId);
        this.dispatch();
        break;
      case 'heartbeat':
        this.resume(conn, msg.busy_job_id ?? null);
        if (!conn.jobId) this.dispatch();
        break;
      case 'job.event':
        if (this.ownsJob(conn, msg.job_id)) this.jobs.recordEvent(msg.job_id, msg.event);
        break;
      case 'job.finished':
        if (this.ownsJob(conn, msg.job_id)) {
          this.jobs.finish(msg.job_id, { status: msg.status, durationMs: msg.duration_ms, outputs: msg.outputs, error: msg.error });
          conn.jobId = null;
          this.publishRobot(conn.robotId);
          this.dispatch();
        }
        break;
      case 'job.rejected':
        if (this.ownsJob(conn, msg.job_id)) {
          this.jobs.requeue(msg.job_id);
          conn.jobId = null;
          this.publishRobot(conn.robotId);
        }
        break;
    }
  }

  /** After a reconnect the robot tells us which job it is still running. */
  private resume(conn: Connection, busyJobId: string | null): void {
    if (busyJobId) {
      const job = this.jobs.get(busyJobId);
      if (job && job.status === 'running' && job.robot_id === conn.robotId) {
        conn.jobId = busyJobId;
        const lost = this.lostJobs.get(busyJobId);
        if (lost) {
          clearTimeout(lost);
          this.lostJobs.delete(busyJobId);
        }
        if (job.cancel_requested) this.send(conn, { type: 'job.cancel', job_id: busyJobId });
      } else {
        // The server already gave up on that job; tell the robot to stop it.
        this.send(conn, { type: 'job.cancel', job_id: busyJobId });
      }
    } else if (conn.jobId) {
      const job = this.jobs.get(conn.jobId);
      if (!job || job.status !== 'running') conn.jobId = null;
    }
  }

  private ownsJob(conn: Connection, jobId: string): boolean {
    const job = this.jobs.get(jobId);
    return !!job && job.robot_id === conn.robotId && job.status === 'running';
  }

  /** Offer queued jobs to idle robots. */
  dispatch(): void {
    for (const conn of this.connections.values()) {
      if (conn.jobId) continue;
      const enabled = this.db.get<{ enabled: number }>('SELECT enabled FROM robots WHERE id = ?', conn.robotId)?.enabled;
      if (!enabled) continue;
      const job = this.jobs.claimNext(conn.robotId, conn.pool);
      if (!job) continue;
      conn.jobId = job.id;
      try {
        this.send(conn, {
          type: 'job.assign',
          job: {
            id: job.id,
            flow: this.jobs.definition(job),
            version: job.version,
            inputs: json(job.inputs, {}),
            timeout_s: job.timeout_s,
            repair: this.repairAllowed(job),
          },
        });
        this.jobs.publish(job);
        this.publishRobot(conn.robotId);
      } catch {
        conn.jobId = null;
        this.jobs.requeue(job.id);
      }
    }
  }

  /** Ask robots to stop cancelled or overdue jobs; fail jobs whose robot ignores that. */
  private enforceTimeouts(): void {
    const running = this.db.all<{ id: string; robot_id: string; started_at: string; timeout_s: number; cancel_requested: number }>(
      `SELECT id, robot_id, started_at, timeout_s, cancel_requested FROM jobs WHERE status = 'running'`,
    );
    const nowMs = Date.now();
    for (const job of running) {
      const conn = this.connections.get(job.robot_id);
      const overdueMs = nowMs - Date.parse(job.started_at) - job.timeout_s * 1000;
      if (job.cancel_requested || overdueMs > 0) {
        if (conn) this.send(conn, { type: 'job.cancel', job_id: job.id });
        if (overdueMs > CANCEL_GRACE_MS || (job.cancel_requested && !conn)) {
          this.jobs.finish(job.id, {
            status: job.cancel_requested ? 'cancelled' : 'failed',
            error: job.cancel_requested
              ? { message: 'Stopped by a user.' }
              : { message: `The run took longer than its limit of ${Math.round(job.timeout_s / 60)} minutes and was stopped.` },
          });
          if (conn?.jobId === job.id) conn.jobId = null;
        }
      }
    }
  }

  /** Called by the API when a user cancels a running job. */
  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job?.robot_id) return;
    const conn = this.connections.get(job.robot_id);
    if (conn) this.send(conn, { type: 'job.cancel', job_id: jobId });
  }

  disconnect(robotId: string): void {
    this.connections.get(robotId)?.socket.close(4003, 'Robot disabled');
  }

  private send(conn: Connection, message: Record<string, unknown>): void {
    conn.socket.send(JSON.stringify(message));
  }

  private touch(robotId: string): void {
    this.db.run('UPDATE robots SET last_seen_at = ? WHERE id = ?', now(), robotId);
  }

  private publishRobot(robotId: string): void {
    this.bus.publish({ type: 'robot.updated', robot: { id: robotId, online: this.isOnline(robotId), jobId: this.busyJob(robotId) } });
  }
}
