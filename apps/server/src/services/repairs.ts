// Fixes the AI assistant made during robot runs. A fix only ever changed that one run;
// it becomes part of the automation when a builder approves it (a new version).
import { findStep, type Element, type Flow } from '@autoflow/flow-types';
import { json, now, type Db } from '../db.js';
import { newId } from '../security.js';
import { changeableParams } from './ai.js';
import { HttpError, notFound, type Bus } from './core.js';
import type { JobRow } from './jobs.js';
import { publishVersion } from './versions.js';

export interface RepairPatch {
  step_id: string;
  params: Record<string, unknown>;
  element: Element | null;
  new_element: boolean;
  explanation: string;
}

interface SuggestionRow {
  id: string;
  flow_id: string;
  base_version: number;
  job_id: string;
  patches: string;
  status: 'pending' | 'approved' | 'dismissed';
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  version: number | null;
}

export class Repairs {
  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
  ) {}

  /** A run reported a step that worked after an AI fix: add it to that run's suggestion. */
  record(job: JobRow, event: Record<string, unknown>, flow: Flow): void {
    const patch = toPatch(event, flow);
    if (!patch) return;
    const existing = this.db.get<SuggestionRow>('SELECT * FROM repair_suggestions WHERE job_id = ?', job.id);
    if (existing) {
      const patches = json<RepairPatch[]>(existing.patches, []).filter((p) => p.step_id !== patch.step_id);
      this.db.run('UPDATE repair_suggestions SET patches = ? WHERE id = ?', JSON.stringify([...patches, patch]), existing.id);
    } else {
      this.db.run(
        'INSERT INTO repair_suggestions (id, flow_id, base_version, job_id, patches, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        newId('fix'),
        job.flow_id,
        job.version,
        job.id,
        JSON.stringify([patch]),
        now(),
      );
    }
    this.bus.publish({ type: 'repair.updated', flowId: job.flow_id });
  }

  list(flowId: string): Record<string, unknown>[] {
    return this.db
      .all<SuggestionRow>("SELECT * FROM repair_suggestions WHERE flow_id = ? ORDER BY created_at DESC LIMIT 50", flowId)
      .map((r) => present(r));
  }

  forJob(jobId: string): Record<string, unknown> | null {
    const row = this.db.get<SuggestionRow>('SELECT * FROM repair_suggestions WHERE job_id = ?', jobId);
    return row ? present(row) : null;
  }

  /** Publish the fix on top of the latest version. */
  approve(id: string, approvedBy: string): { version: number; flowId: string } {
    const row = this.pending(id);
    const latest = this.db.get<{ definition: string; version: number }>(
      'SELECT v.definition, v.version FROM flow_versions v JOIN flows f ON f.id = v.flow_id AND f.latest_version = v.version WHERE f.id = ?',
      row.flow_id,
    );
    if (!latest) throw notFound('The automation');
    const patches = json<RepairPatch[]>(row.patches, []);
    const flow = applyPatches(JSON.parse(latest.definition) as Flow, patches);
    const notes = `AI fix from a robot run, approved by ${approvedBy}: ${patches.map((p) => p.explanation).join(' ')}`.slice(0, 2000);
    const version = publishVersion(this.db, flow, notes, approvedBy);
    this.decide(row, 'approved', approvedBy, version);
    return { version, flowId: row.flow_id };
  }

  dismiss(id: string, dismissedBy: string): { flowId: string } {
    const row = this.pending(id);
    this.decide(row, 'dismissed', dismissedBy, null);
    return { flowId: row.flow_id };
  }

  private pending(id: string): SuggestionRow {
    const row = this.db.get<SuggestionRow>('SELECT * FROM repair_suggestions WHERE id = ?', id);
    if (!row) throw notFound('The suggested fix');
    if (row.status !== 'pending') throw new HttpError(409, `This fix was already ${row.status}.`);
    return row;
  }

  private decide(row: SuggestionRow, status: 'approved' | 'dismissed', by: string, version: number | null): void {
    this.db.run(
      'UPDATE repair_suggestions SET status = ?, decided_by = ?, decided_at = ?, version = ? WHERE id = ?',
      status,
      by,
      now(),
      version,
      row.id,
    );
    this.bus.publish({ type: 'repair.updated', flowId: row.flow_id });
  }
}

/** Apply AI fixes to a flow definition (pure; throws when the automation changed too much). */
export function applyPatches(flow: Flow, patches: RepairPatch[]): Flow {
  const copy = structuredClone(flow);
  for (const patch of patches) {
    const step = findStep(copy, patch.step_id);
    if (!step) {
      throw new HttpError(409, 'The automation was changed after this run, so the fix no longer fits. Make the change in Studio instead.');
    }
    step.params = { ...step.params, ...patch.params };
    if (patch.element) {
      const elements = (copy.elements ??= []);
      const index = elements.findIndex((e) => e.id === patch.element!.id);
      if (index >= 0) elements[index] = { ...elements[index]!, selectors: patch.element.selectors, context: patch.element.context };
      else elements.push(patch.element);
    }
  }
  return copy;
}


const WEB_STRATEGIES = new Set(['role', 'text', 'label', 'placeholder', 'testid', 'css', 'xpath']);

/**
 * Check what a robot reports against the published automation: only settings the assistant may
 * change (see changeableParams) and only the element that step uses. Anything else is dropped,
 * so a misbehaving robot can't slip other changes into a suggested version.
 */
function toPatch(event: Record<string, unknown>, flow: Flow): RepairPatch | null {
  const patch = event.patch as Partial<RepairPatch> | undefined;
  if (!patch || typeof patch.step_id !== 'string' || typeof patch.params !== 'object' || patch.params === null) return null;
  const step = findStep(flow, patch.step_id);
  if (!step) return null;
  const changeable = changeableParams(step.activity);
  const newElementId = `el_ai_${step.id}`;
  const newElement = !!patch.new_element && !step.params?.element;
  const params = Object.fromEntries(
    Object.entries(patch.params as Record<string, unknown>).filter(([k, v]) =>
      k === 'element' ? newElement && v === newElementId : changeable.has(k) && JSON.stringify(v ?? null).length <= 2000,
    ),
  );
  let element: Element | null = null;
  const raw = patch.element;
  if (raw && typeof raw === 'object' && Array.isArray(raw.selectors) && changeable.has('element')) {
    const kind = step.activity.startsWith('desktop.') ? 'desktop' : 'web';
    const expectedId = newElement ? newElementId : step.params?.element;
    const selectors = raw.selectors
      .filter((s) => s && (kind === 'desktop' ? s.strategy === 'uia' : WEB_STRATEGIES.has(s.strategy)) && String(s.value ?? '').length <= 300)
      .slice(0, 10);
    if (raw.id === expectedId && raw.kind === kind && selectors.length) {
      element = { id: raw.id, name: String(raw.name ?? 'Element').slice(0, 120), kind, selectors, context: raw.context ?? {} };
    }
  }
  if (!Object.keys(params).length && !element) return null;
  return { step_id: step.id, params, element, new_element: newElement && !!element, explanation: String(event.explanation ?? '').slice(0, 500) };
}

function present(r: SuggestionRow): Record<string, unknown> {
  return {
    id: r.id,
    flowId: r.flow_id,
    baseVersion: r.base_version,
    jobId: r.job_id,
    patches: json(r.patches, []),
    status: r.status,
    createdAt: r.created_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    version: r.version,
  };
}
