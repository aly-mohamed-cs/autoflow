// SQLite through Node's built-in driver: a single file, nothing to install on the server.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private stmt(sql: string) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.stmt(sql).run(...params) as { changes: number; lastInsertRowid: number | bigint };
  }

  /** Run fn in a transaction; rolled back if it throws. Nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  migrate(): number {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const done = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
    let applied = 0;
    for (const [index, sql] of MIGRATIONS.entries()) {
      const version = index + 1;
      if (done.has(version)) continue;
      // Some migrations rebuild a table (SQLite can't change a CHECK in place): with foreign keys on,
      // dropping the old table would delete the rows that point to it. Checked before committing.
      this.raw.exec('PRAGMA foreign_keys = OFF');
      try {
        this.tx(() => {
          this.raw.exec(sql);
          const broken = this.all('PRAGMA foreign_key_check');
          if (broken.length) throw new Error(`Database update ${version} left ${broken.length} broken references.`);
          this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', version, new Date().toISOString());
        });
      } finally {
        this.raw.exec('PRAGMA foreign_keys = ON');
      }
      applied++;
    }
    return applied;
  }

  /** Consistent online copy of the database (used by backups). */
  backupTo(path: string): void {
    this.raw.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.raw.close();
  }
}

export const now = () => new Date().toISOString();

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
