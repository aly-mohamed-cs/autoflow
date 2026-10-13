// Chained automations (Brity "process flows"): when automation A succeeds, fails or finishes,
// start automation B - optionally with A's results as B's start values.
import { z } from 'zod';
import type { Db } from '../db.js';
import { json, now } from '../db.js';
import { newId } from '../security.js';
import { badRequest, notFound } from './core.js';
import type { JobRow, Jobs } from './jobs.js';

/** A chain that leads back to itself stops after this many runs in a row. */
export const MAX_CHAIN_DEPTH = 10;

export const ChainBody = z.object({
  runWhen: z.enum(['succeeded', 'failed', 'finished']),
  nextFlowId: z.string().min(1),
  passOutputs: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type ChainInput = z.infer<typeof ChainBody>;

interface ChainRow {
  id: string;
  flow_id: string;
  run_when: 'succeeded' | 'failed' | 'finished';
  next_flow_id: string;
  pass_outputs: number;
  enabled: number;
  created_by: string | null;
  created_at: string;
}

export class Chains {
  constructor(
    private readonly db: Db,
    private readonly jobs: Jobs,
  ) {
    jobs.onFinished.push((job) => this.onJobFinished(job));
  }

  /** What starts after this automation, and which automations start it. */
  forFlow(flowId: string) {
    const next = this.db
      .all<ChainRow & { next_name: string }>(
        `SELECT c.*, f.name AS next_name FROM flow_chains c JOIN flows f ON f.id = c.next_flow_id WHERE c.flow_id = ? ORDER BY c.created_at`,
        flowId,
      )
      .map((c) => ({ id: c.id, runWhen: c.run_when, nextFlowId: c.next_flow_id, nextFlowName: c.next_name, passOutputs: !!c.pass_outputs, enabled: !!c.enabled }));
    const startedBy = this.db
      .all<ChainRow & { from_name: string }>(
        `SELECT c.*, f.name AS from_name FROM flow_chains c JOIN flows f ON f.id = c.flow_id WHERE c.next_flow_id = ? AND c.enabled = 1 ORDER BY f.name`,
        flowId,
      )
      .map((c) => ({ id: c.id, runWhen: c.run_when, flowId: c.flow_id, flowName: c.from_name }));
    return { next, startedBy };
  }

  add(flowId: string, input: ChainInput, by: string): string {
    for (const id of [flowId, input.nextFlowId]) {
      if (!this.db.get('SELECT 1 FROM flows WHERE id = ? AND archived = 0', id)) throw notFound('The automation');
    }
    if (this.db.get('SELECT 1 FROM flow_chains WHERE flow_id = ? AND next_flow_id = ? AND run_when = ?', flowId, input.nextFlowId, input.runWhen)) {
      throw badRequest('That automation already starts at that point.');
    }
    const id = newId('chain');
    this.db.run(
      `INSERT INTO flow_chains (id, flow_id, run_when, next_flow_id, pass_outputs, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      flowId,
      input.runWhen,
      input.nextFlowId,
      input.passOutputs ? 1 : 0,
      input.enabled ? 1 : 0,
      by,
      now(),
    );
    return id;
  }

  update(id: string, input: Partial<Pick<ChainInput, 'passOutputs' | 'enabled'>>): void {
    const row = this.db.get<ChainRow>('SELECT * FROM flow_chains WHERE id = ?', id);
    if (!row) throw notFound('The follow-up');
    this.db.run(
      'UPDATE flow_chains SET pass_outputs = ?, enabled = ? WHERE id = ?',
      input.passOutputs === undefined ? row.pass_outputs : input.passOutputs ? 1 : 0,
      input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
      id,
    );
  }

  remove(id: string): { flowId: string } | null {
    const row = this.db.get<ChainRow>('SELECT * FROM flow_chains WHERE id = ?', id);
    if (!row) return null;
    this.db.run('DELETE FROM flow_chains WHERE id = ?', id);
    return { flowId: row.flow_id };
  }

  private startValues(flowId: string): Set<string> {
    const row = this.db.get<{ definition: string }>(
      'SELECT v.definition FROM flow_versions v JOIN flows f ON f.id = v.flow_id AND v.version = f.latest_version WHERE f.id = ?',
      flowId,
    );
    const variables = json<{ variables?: { name: string; is_input?: boolean }[] }>(row?.definition, {}).variables ?? [];
    return new Set(variables.filter((v) => v.is_input).map((v) => v.name));
  }

  private onJobFinished(job: JobRow): void {
    if (job.status === 'cancelled') return; // a person stopped it: don't carry on
    const chains = this.db.all<ChainRow & { from_name: string }>(
      `SELECT c.*, f.name AS from_name FROM flow_chains c JOIN flows f ON f.id = c.flow_id WHERE c.flow_id = ? AND c.enabled = 1`,
      job.flow_id,
    );
    for (const chain of chains) {
      if (chain.run_when !== 'finished' && chain.run_when !== job.status) continue;
      if (job.chain_depth + 1 > MAX_CHAIN_DEPTH) {
        console.error(`chain ${chain.id}: stopped after ${MAX_CHAIN_DEPTH} automations in a row`);
        continue;
      }
      // Only start values the next automation has (results with the same names, and previous_run).
      const wanted = this.startValues(chain.next_flow_id);
      const offered: Record<string, unknown> = chain.pass_outputs ? { ...json<Record<string, unknown>>(job.outputs, {}) } : {};
      offered.previous_run = {
        automation: chain.from_name,
        status: job.status,
        error: json<{ message?: string }>(job.error, {}).message ?? '',
        run_id: job.id,
      };
      const inputs = Object.fromEntries(Object.entries(offered).filter(([name]) => wanted.has(name)));
      try {
        this.jobs.create({
          flowId: chain.next_flow_id,
          trigger: 'chain',
          triggerRef: chain.id,
          triggeredBy: `After “${chain.from_name}”`,
          inputs,
          pool: job.pool,
          chainDepth: job.chain_depth + 1,
        });
      } catch (err) {
        console.error(`chain ${chain.id} could not start a run:`, (err as Error).message);
      }
    }
  }
}
