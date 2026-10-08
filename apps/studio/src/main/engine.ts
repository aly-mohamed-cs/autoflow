import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { EngineStatus } from '../shared/api';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Where to find the Python engine: env override, packaged copy, or the dev checkout. */
export function findPython(appPath: string, resourcesPath: string): string | null {
  const candidates = [
    process.env.AUTOFLOW_PYTHON,
    join(resourcesPath, 'engine', 'python', 'python.exe'),
    resolve(appPath, '..', '..', 'engine', '.venv', 'Scripts', 'python.exe'),
    resolve(appPath, '..', '..', 'engine', '.venv', 'bin', 'python'),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

/**
 * Runs `python -m autoflow_engine rpc` and speaks newline-delimited JSON-RPC with it.
 * Restarts the engine automatically if it crashes (at most a few times per minute).
 */
export class EngineProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private restarts: number[] = [];
  private stopping = false;
  private stderrTail: string[] = [];
  status: EngineStatus = { state: 'starting' };

  constructor(
    private readonly python: string | null,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onStatus: (status: EngineStatus) => void,
    /** Questions the engine asks Studio during a run (e.g. host.repair). */
    private readonly onRequest: (method: string, params: unknown) => Promise<unknown> = async (m) => {
      throw new Error(`Unknown request ${m}`);
    },
  ) {}

  start(): void {
    if (!this.python) {
      this.setStatus({
        state: 'missing',
        message: 'The automation engine was not found. Reinstall Autoflow Studio, or run "uv sync" in engine/.',
      });
      return;
    }
    this.stopping = false;
    this.setStatus({ state: 'starting', python: this.python });
    const child = spawn(this.python, ['-m', 'autoflow_engine', 'rpc'], {
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    });
    this.child = child;

    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderrTail = [...this.stderrTail.slice(-40), line];
      console.warn('[engine]', line);
    });
    child.on('error', (err) => {
      this.setStatus({ state: 'crashed', message: `Could not start the engine: ${err.message}` });
    });
    child.on('exit', (code) => {
      this.child = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new EngineError('The automation engine stopped unexpectedly.', -1));
      }
      this.pending.clear();
      if (this.stopping) return;
      const now = Date.now();
      this.restarts = [...this.restarts.filter((t) => now - t < 60_000), now];
      const detail = this.stderrTail.slice(-5).join('\n');
      if (this.restarts.length <= 3) {
        this.setStatus({ state: 'starting', message: `Engine stopped (code ${code}); restarting…` });
        setTimeout(() => this.start(), 500);
      } else {
        this.setStatus({ state: 'crashed', message: `The engine keeps stopping (code ${code}).\n${detail}` });
      }
    });
  }

  stop(): void {
    this.stopping = true;
    this.child?.stdin.end();
    const child = this.child;
    setTimeout(() => child?.kill(), 1500);
  }

  restart(): void {
    this.stop();
    this.restarts = [];
    setTimeout(() => this.start(), 300);
  }

  call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const child = this.child;
    if (!child || this.status.state !== 'ready') {
      return Promise.reject(new EngineError(this.status.message ?? 'The automation engine is not ready yet.', -2));
    }
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError(`The engine did not answer "${method}" in time.`, -3));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise as (v: unknown) => void, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private handleLine(line: string): void {
    let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      console.warn('[engine] non-JSON output:', line);
      return;
    }
    if (message.method && typeof message.id === 'string') {
      this.answer(message.id, message.method, message.params);
      return;
    }
    if (message.method) {
      if (message.method === 'engine.ready') {
        const params = message.params as { engine_version?: string };
        this.setStatus({ state: 'ready', version: params.engine_version, python: this.python ?? undefined });
      } else {
        this.onNotification(message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new EngineError(message.error.message, message.error.code, message.error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  private answer(id: string, method: string, params: unknown): void {
    const reply = (body: Record<string, unknown>) => this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
    this.onRequest(method, params).then(
      (result) => reply({ result: result ?? null }),
      (err: Error) => reply({ error: { code: 1, message: err.message } }),
    );
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}
