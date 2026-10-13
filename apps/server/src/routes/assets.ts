import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import { requireRole } from '../auth/sessions.js';
import { AssetBody } from '../services/assets.js';

const queueName = z.string().trim().min(1).max(100);

/** What steps ask the Orchestrator while they run ("Get shared value", the queue steps). */
export const RunRequestBody = z.discriminatedUnion('op', [
  z.object({ op: z.literal('asset.get'), name: z.string().trim().min(1).max(100) }),
  z.object({
    op: z.literal('queue.add'),
    queue: queueName,
    reference: z.string().max(200).default(''),
    data: z.record(z.string(), z.unknown()).default({}),
    priority: z.number().int().min(-100).max(100).default(0),
  }),
  z.object({ op: z.literal('queue.next'), queue: queueName }),
  z.object({
    op: z.literal('queue.finish'),
    item: z.string().min(1).max(100),
    outcome: z.enum(['done', 'retry', 'failed']),
    result: z.unknown().optional(),
    message: z.string().max(2000).default(''),
  }),
  z.object({ op: z.literal('queue.release') }),
  z.object({ op: z.literal('queue.count'), queue: queueName, status: z.enum(['new', 'in_progress', 'done', 'failed', 'all']).default('new') }),
]);

/** `claimedBy`: the robot's job id, or `test:<user id>` for a Studio test run. */
export function runRequest(svc: Services, body: unknown, claimedBy: string): unknown {
  const request = RunRequestBody.parse(body);
  switch (request.op) {
    case 'asset.get':
      return svc.assets.read(request.name);
    case 'queue.add': {
      const queue = svc.queues.byName(request.queue);
      const [id] = svc.queues.addItems(queue.id, [{ reference: request.reference, data: request.data, priority: request.priority }]);
      return { id };
    }
    case 'queue.next':
      return { item: svc.queues.claimNext(request.queue, claimedBy) };
    case 'queue.finish':
      svc.queues.finish(request.item, request.outcome, claimedBy, { result: request.result, message: request.message });
      return { ok: true };
    case 'queue.release':
      // Only test runs give items back this way; robot runs do it when the run ends.
      return { released: claimedBy.startsWith('test:') ? svc.queues.releaseTestClaims(claimedBy) : 0 };
    case 'queue.count':
      return { count: svc.queues.count(request.queue, request.status) };
  }
}

export async function assetRoutes(app: FastifyInstance) {
  const { assets, audit } = app.svc;
  const actor = (r: { user?: { id: string; username: string } }) => ({ id: r.user!.id, name: r.user!.username });

  app.get('/api/assets', { preHandler: requireRole('builder') }, async () => ({ assets: assets.list() }));

  app.put('/api/assets', { preHandler: requireRole('builder'), bodyLimit: 30 * 1024 * 1024 }, async (request) => {
    const body = AssetBody.parse(request.body);
    const { created } = assets.save(body, request.user!.displayName);
    audit.record(actor(request), created ? 'asset.created' : 'asset.updated', body.name, { kind: body.kind, fileChanged: body.content !== undefined });
    return { ok: true };
  });

  app.delete('/api/assets/:name', { preHandler: requireRole('builder') }, async (request) => {
    const { name } = request.params as { name: string };
    if (assets.remove(name)) audit.record(actor(request), 'asset.deleted', name);
    return { ok: true };
  });

  /** Names for Studio's pickers. */
  app.get('/api/run/names', { preHandler: requireRole('builder') }, async () => ({
    assets: assets.list().map((a) => a.name),
    queues: app.svc.db.all<{ name: string }>('SELECT name FROM queues ORDER BY name COLLATE NOCASE').map((q) => q.name),
  }));

  /** Studio test runs: the same questions robots ask, as the signed-in builder. */
  app.post('/api/run/orchestrator', { preHandler: requireRole('builder'), bodyLimit: 2 * 1024 * 1024 }, async (request) =>
    runRequest(app.svc, request.body, `test:${request.user!.id}`),
  );
}
