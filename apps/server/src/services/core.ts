// Small shared services: live event bus, settings, audit log.
import { EventEmitter } from 'node:events';
import type { Db } from '../db.js';
import { json, now } from '../db.js';

export type LiveEvent =
  | { type: 'job.updated'; job: Record<string, unknown> }
  | { type: 'job.event'; jobId: string; event: Record<string, unknown> }
  | { type: 'robot.updated'; robot: Record<string, unknown> }
  | { type: 'queue.updated'; queueId: string }
  | { type: 'repair.updated'; flowId: string };

/** In-process pub/sub feeding the dashboard's live view (Server-Sent Events). */
export class Bus extends EventEmitter {
  publish(event: LiveEvent): void {
    this.emit('live', event);
  }
  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.on('live', listener);
    return () => this.off('live', listener);
  }
}

export class Settings {
  constructor(private readonly db: Db) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    return row ? { ...fallback, ...json<Partial<T>>(row.value, {}) } as T : fallback;
  }

  set(key: string, value: unknown): void {
    this.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value),
    );
  }
}

export interface Actor {
  id?: string | null;
  name: string;
}

export class Audit {
  constructor(private readonly db: Db) {}

  record(actor: Actor, action: string, target?: string, details: Record<string, unknown> = {}): void {
    this.db.run(
      'INSERT INTO audit (ts, user_id, actor, action, target, details) VALUES (?, ?, ?, ?, ?, ?)',
      now(),
      actor.id ?? null,
      actor.name,
      action,
      target ?? null,
      JSON.stringify(details),
    );
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} was not found.`);
export const badRequest = (message: string) => new HttpError(400, message);
