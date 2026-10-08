import type { Flow } from '@autoflow/flow-types';
import { now, type Db } from '../db.js';

/** Store a new immutable version of an automation (creating the automation if it's new). */
export function publishVersion(db: Db, flow: Flow, notes: string, publishedBy: string): number {
  return db.tx(() => {
    const existing = db.get<{ latest_version: number }>('SELECT latest_version FROM flows WHERE id = ?', flow.id);
    const next = (existing?.latest_version ?? 0) + 1;
    if (existing) {
      db.run(
        'UPDATE flows SET name = ?, description = ?, latest_version = ?, updated_at = ?, archived = 0 WHERE id = ?',
        flow.name,
        flow.description ?? '',
        next,
        now(),
        flow.id,
      );
    } else {
      db.run(
        'INSERT INTO flows (id, name, description, latest_version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        flow.id,
        flow.name,
        flow.description ?? '',
        next,
        publishedBy,
        now(),
        now(),
      );
    }
    db.run(
      'INSERT INTO flow_versions (flow_id, version, definition, notes, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      flow.id,
      next,
      JSON.stringify(flow),
      notes,
      publishedBy,
      now(),
    );
    return next;
  });
}
