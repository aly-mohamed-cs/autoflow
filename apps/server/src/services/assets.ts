// Shared values ("assets"): company-wide settings and files that automations read while they run,
// so e.g. a portal address or a price list is changed in one place instead of in every automation.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db.js';
import { now } from '../db.js';
import { newId } from '../security.js';
import { badRequest, HttpError } from './core.js';

export const ASSET_KINDS = ['text', 'number', 'yesno', 'file'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
const MAX_FILE = 20 * 1024 * 1024;

export const AssetBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(ASSET_KINDS),
  value: z.string().max(100_000).default(''),
  description: z.string().max(500).default(''),
  /** For files: the file name and its content (base64). Leave out to keep the current file. */
  fileName: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(Math.ceil((MAX_FILE * 4) / 3) + 4).optional(),
});
export type AssetInput = z.infer<typeof AssetBody>;

interface AssetRow {
  name: string;
  kind: AssetKind;
  value: string;
  file_name: string | null;
  file_size: number | null;
  description: string;
  updated_by: string | null;
  updated_at: string;
}

export interface AssetValue {
  kind: AssetKind;
  value: string | number | boolean | null;
  fileName?: string;
  content?: string;
}

export class Assets {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
  ) {}

  list() {
    return this.db.all<AssetRow>('SELECT * FROM assets ORDER BY name COLLATE NOCASE').map((a) => ({
      name: a.name,
      kind: a.kind,
      // A file's stored name is internal; people see the original file name.
      value: a.kind === 'file' ? '' : a.value,
      fileName: a.file_name,
      fileSize: a.file_size,
      description: a.description,
      updatedBy: a.updated_by,
      updatedAt: a.updated_at,
    }));
  }

  save(input: AssetInput, by: string): { created: boolean } {
    const existing = this.db.get<AssetRow>('SELECT * FROM assets WHERE name = ?', input.name);
    let value = input.value.trim();
    let fileName = existing?.kind === 'file' ? existing.file_name : null;
    let fileSize = existing?.kind === 'file' ? existing.file_size : null;
    if (input.kind === 'number' && (value === '' || !Number.isFinite(Number(value)))) throw badRequest('Enter a number.');
    if (input.kind === 'yesno' && !['true', 'false'].includes(value)) throw badRequest('Choose yes or no.');
    if (input.kind === 'text') value = input.value; // keep spaces in text
    if (input.kind === 'file') {
      if (input.content !== undefined) {
        const bytes = Buffer.from(input.content, 'base64');
        if (bytes.length > MAX_FILE) throw badRequest('Files can be at most 20 MB.');
        if (!input.fileName) throw badRequest('The file needs a name.');
        mkdirSync(this.dir, { recursive: true });
        value = newId('asset');
        writeFileSync(join(this.dir, value), bytes);
        fileName = input.fileName;
        fileSize = bytes.length;
      } else if (existing?.kind === 'file') {
        value = existing.value;
      } else {
        throw badRequest('Choose a file.');
      }
    }
    this.db.run(
      `INSERT INTO assets (name, kind, value, file_name, file_size, description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, value = excluded.value, file_name = excluded.file_name,
         file_size = excluded.file_size, description = excluded.description, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      input.name,
      input.kind,
      value,
      input.kind === 'file' ? fileName : null,
      input.kind === 'file' ? fileSize : null,
      input.description,
      by,
      now(),
    );
    if (existing?.kind === 'file' && existing.value !== value) this.removeFile(existing.value);
    return { created: !existing };
  }

  remove(name: string): boolean {
    const existing = this.db.get<AssetRow>('SELECT * FROM assets WHERE name = ?', name);
    if (!existing) return false;
    this.db.run('DELETE FROM assets WHERE name = ?', name);
    if (existing.kind === 'file') this.removeFile(existing.value);
    return true;
  }

  /** The value for a running automation. */
  read(name: string): AssetValue {
    const a = this.db.get<AssetRow>('SELECT * FROM assets WHERE name = ?', name);
    if (!a) throw new HttpError(404, `There is no shared value called “${name}”. Add it in the dashboard under Shared values.`);
    switch (a.kind) {
      case 'number':
        return { kind: a.kind, value: Number(a.value) };
      case 'yesno':
        return { kind: a.kind, value: a.value === 'true' };
      case 'file':
        return { kind: a.kind, value: null, fileName: a.file_name ?? 'file', content: readFileSync(join(this.dir, a.value)).toString('base64') };
      default:
        return { kind: a.kind, value: a.value };
    }
  }

  private removeFile(id: string): void {
    if (/^asset_[\w-]+$/.test(id)) rmSync(join(this.dir, id), { force: true });
  }
}
