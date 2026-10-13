import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/sessions.js';
import { AiTaskBody, DEFAULT_AI, type AiSettings, type RepairRequest } from '../services/ai.js';
import { HttpError } from '../services/core.js';

/** What the engine sends when a step fails (see engine/runtime/repair.py). */
export const RepairBody = z.object({
  flow_name: z.string().max(300).optional(),
  activity: z.string().max(100),
  step: z.object({ id: z.string().max(100), label: z.string().max(300).nullable().optional(), params: z.record(z.string(), z.unknown()) }),
  element: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.object({ message: z.string().max(4000), hint: z.string().max(2000).nullable().optional() }),
  screen: z.unknown().optional(),
  variables: z.array(z.unknown()).max(200).optional(),
  attempts: z.array(z.unknown()).max(10).optional(),
});

const SettingsBody = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().trim().url().max(300),
  model: z.string().trim().min(1).max(200),
  /** Leave empty to keep the stored key; "-" removes it. */
  apiKey: z.string().max(500).default(''),
  timeoutS: z.number().int().min(10).max(600).default(120),
});

export async function aiRoutes(app: FastifyInstance) {
  const { settings, vault, audit, ai } = app.svc;
  const actor = (r: { user?: { id: string; username: string } }) => ({ id: r.user!.id, name: r.user!.username });

  app.get('/api/ai/status', { preHandler: requireRole('viewer') }, async () => {
    const cfg = ai.config();
    return { enabled: cfg.enabled, model: cfg.enabled ? cfg.model : null };
  });

  app.post('/api/ai/draft-flow', { preHandler: requireRole('builder'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const { description } = z.object({ description: z.string().trim().min(10).max(4000) }).parse(request.body);
    const result = await ai.draftFlow(description);
    audit.record(actor(request), 'ai.draft', undefined, { steps: result.flow.steps?.length ?? 0, dropped: result.dropped.length });
    return result;
  });

  app.post('/api/ai/explain-error', { preHandler: requireRole('operator'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = z
      .object({ activity: z.string().max(100), message: z.string().max(2000), hint: z.string().max(1000).nullable().optional(), params: z.record(z.string(), z.unknown()).optional() })
      .parse(request.body);
    return { explanation: await ai.explainError(body) };
  });

  /** The AI step during a Studio test run. */
  app.post('/api/ai/complete', { preHandler: requireRole('builder'), bodyLimit: 1024 * 1024, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    return ai.complete(AiTaskBody.parse(request.body));
  });

  /** Studio test runs: new settings for a step that failed (shown to the builder to keep or discard). */
  app.post('/api/ai/repair-step', { preHandler: requireRole('builder'), bodyLimit: 2 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = RepairBody.parse(request.body) as RepairRequest;
    const reply = await ai.repairStep(body);
    audit.record(actor(request), 'ai.repair', undefined, { activity: body.activity, fixable: reply.fixable, where: 'studio' });
    return reply;
  });

  app.get('/api/settings/ai', { preHandler: requireRole('admin') }, async () => {
    const cfg = ai.config();
    return { ai: { ...cfg, apiKey: cfg.apiKey ? '••••••' : '' } };
  });

  app.put('/api/settings/ai', { preHandler: requireRole('admin') }, async (request) => {
    const body = SettingsBody.parse(request.body);
    const current = settings.get<AiSettings>('ai', DEFAULT_AI);
    const apiKey = body.apiKey === '-' ? '' : body.apiKey && body.apiKey !== '••••••' ? vault.encrypt(body.apiKey) : current.apiKey;
    settings.set('ai', { ...body, apiKey });
    audit.record(actor(request), 'settings.ai_updated', undefined, { enabled: body.enabled, baseUrl: body.baseUrl, model: body.model });
    return { ok: true };
  });

  /** Ask the configured model a tiny question to check the connection. */
  app.post('/api/settings/ai/test', { preHandler: requireRole('admin') }, async () => {
    const cfg = ai.config();
    if (!cfg.enabled) throw new HttpError(400, 'Turn the assistant on and save first.');
    const started = Date.now();
    try {
      const explanation = await ai.explainError({ activity: 'control.log', message: 'Connection test - reply OK.' });
      return { ok: true, ms: Date.now() - started, sample: explanation.slice(0, 200) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
