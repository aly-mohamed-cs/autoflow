import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/sessions.js';
import { AiService, DEFAULT_AI, type AiSettings } from '../services/ai.js';
import { HttpError } from '../services/core.js';

const SettingsBody = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().trim().url().max(300),
  model: z.string().trim().min(1).max(200),
  /** Leave empty to keep the stored key; "-" removes it. */
  apiKey: z.string().max(500).default(''),
  timeoutS: z.number().int().min(10).max(600).default(120),
});

export async function aiRoutes(app: FastifyInstance) {
  const { settings, vault, audit } = app.svc;
  const ai = new AiService(settings, (sealed) => vault.decrypt(sealed));
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
