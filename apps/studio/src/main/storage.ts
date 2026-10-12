import type { Flow } from '@autoflow/flow-types';
import { walkFlow } from '@autoflow/flow-types';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CredentialInput, CredentialSummary, FlowSummary } from '../shared/api';

/** Write via a temp file + rename so a crash never leaves a half-written file. */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, path);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error('Invalid flow id');
  return id;
}

/**
 * The user's flow library: one JSON file per flow in <userData>/flows.
 * Deleting moves the file to <userData>/flows/.trash so nothing is ever lost by accident.
 */
export class FlowStore {
  private readonly dir: string;
  private readonly meta: string;

  constructor(userData: string) {
    this.dir = join(userData, 'flows');
    this.meta = join(this.dir, '.runs.json');
  }

  private path(id: string): string {
    return join(this.dir, `${checkId(id)}.json`);
  }

  async list(): Promise<FlowSummary[]> {
    await fs.mkdir(this.dir, { recursive: true });
    const runs = await this.readRuns();
    const names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
    const summaries = await Promise.all(
      names.map(async (name) => {
        try {
          const full = join(this.dir, name);
          const [text, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
          const flow = JSON.parse(text) as Flow;
          return summarize(flow, stat.mtimeMs, runs[flow.id]);
        } catch {
          return null; // unreadable file: skip rather than break the whole list
        }
      }),
    );
    return summaries.filter((s): s is FlowSummary => s !== null).sort((a, b) => b.modified - a.modified);
  }

  async get(id: string): Promise<Flow> {
    return JSON.parse(await fs.readFile(this.path(id), 'utf8')) as Flow;
  }

  async save(flow: Flow): Promise<FlowSummary> {
    await fs.mkdir(this.dir, { recursive: true });
    await writeAtomic(this.path(flow.id), JSON.stringify(flow, null, 2));
    const runs = await this.readRuns();
    return summarize(flow, Date.now(), runs[flow.id]);
  }

  async remove(id: string): Promise<void> {
    const trash = join(this.dir, '.trash');
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(this.path(id), join(trash, `${id}-${Date.now()}.json`));
  }

  async duplicate(id: string): Promise<FlowSummary> {
    const flow = await this.get(id);
    return this.save({ ...flow, id: newFlowId(), name: `${flow.name} (copy)` });
  }

  async recordRun(id: string, status: string): Promise<void> {
    const runs = await this.readRuns();
    runs[checkId(id)] = { status, at: Date.now() };
    await fs.mkdir(this.dir, { recursive: true });
    await writeAtomic(this.meta, JSON.stringify(runs));
  }

  private async readRuns(): Promise<Record<string, { status: string; at: number }>> {
    try {
      return JSON.parse(await fs.readFile(this.meta, 'utf8'));
    } catch {
      return {};
    }
  }
}

export function newFlowId(): string {
  return `flow_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function summarize(flow: Flow, modified: number, lastRun?: { status: string; at: number }): FlowSummary {
  const stepCount = [...walkFlow(flow)].length;
  return { id: flow.id, name: flow.name, description: flow.description ?? '', modified, stepCount, lastRun };
}

// ---------------------------------------------------------------------------------

export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

interface StoredCredential {
  name: string;
  username: string;
  password: string; // base64 of the OS-encrypted bytes
  updated: number;
}

/**
 * Credentials for test runs on this PC. Passwords are encrypted with Windows DPAPI
 * (Electron safeStorage) so only this Windows user can read them; the UI never
 * receives a password back.
 */
export class Vault {
  private readonly file: string;

  constructor(
    userData: string,
    private readonly crypto: Encryptor,
  ) {
    this.file = join(userData, 'vault.json');
  }

  available(): boolean {
    return this.crypto.isEncryptionAvailable();
  }

  async list(): Promise<CredentialSummary[]> {
    return (await this.read())
      .map(({ name, username, updated }) => ({ name, username, updated }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(input: CredentialInput): Promise<void> {
    const name = input.name.trim();
    if (!name) throw new Error('A credential needs a name.');
    if (!this.available()) throw new Error('Secure storage is not available on this computer.');
    const all = await this.read();
    const existing = all.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!existing && !input.password) throw new Error('Enter a password for the new credential.');
    const password = input.password
      ? this.crypto.encryptString(input.password).toString('base64')
      : existing!.password;
    const entry: StoredCredential = { name, username: input.username.trim(), password, updated: Date.now() };
    await this.write([...all.filter((c) => c !== existing), entry]);
  }

  async remove(name: string): Promise<void> {
    await this.write((await this.read()).filter((c) => c.name !== name));
  }

  /** Decrypt the named credentials for a run. Unknown names are left out (the engine reports them). */
  async resolve(names: string[]): Promise<Record<string, { username: string; password: string }>> {
    const stored = await this.read();
    const out: Record<string, { username: string; password: string }> = {};
    for (const requested of names) {
      // Keyed by the name the step uses, matched ignoring case.
      const c = stored.find((s) => s.name.toLowerCase() === requested.toLowerCase());
      if (!c) continue;
      out[requested] = {
        username: c.username,
        password: this.crypto.decryptString(Buffer.from(c.password, 'base64')),
      };
    }
    return out;
  }

  private async read(): Promise<StoredCredential[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      return [];
    }
  }

  private async write(entries: StoredCredential[]): Promise<void> {
    await writeAtomic(this.file, JSON.stringify(entries, null, 2));
  }
}
