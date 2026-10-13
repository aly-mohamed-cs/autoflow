import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth/sessions.js';
import { ChainBody } from '../services/chains.js';
import { notFound } from '../services/core.js';
import { TriggerBody } from '../services/eventTriggers.js';

export async function eventRoutes(app: FastifyInstance) {
  const { eventTriggers, chains, audit } = app.svc;
  const actor = (r: { user?: { id: string; username: string } }) => ({ id: r.user!.id, name: r.user!.username });

  // -- event triggers (new file, new email) ----------------------------------------------------

  app.get('/api/event-triggers', { preHandler: requireRole('operator') }, async (request) => {
    const { flowId } = request.query as { flowId?: string };
    const all = eventTriggers.list();
    return { triggers: flowId ? all.filter((t) => t.flowId === flowId) : all };
  });

  // Builders: an email trigger signs in to a mailbox with a saved credential.
  app.post('/api/event-triggers', { preHandler: requireRole('builder') }, async (request) => {
    const body = TriggerBody.parse(request.body);
    const id = eventTriggers.save(body, request.user!.displayName);
    audit.record(actor(request), 'trigger.created', id, { name: body.name, kind: body.kind, flowId: body.flowId });
    return { id };
  });

  app.put('/api/event-triggers/:id', { preHandler: requireRole('builder') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = TriggerBody.parse(request.body);
    eventTriggers.save(body, request.user!.displayName, id);
    audit.record(actor(request), 'trigger.updated', id, { name: body.name, enabled: body.enabled });
    return { ok: true };
  });

  app.delete('/api/event-triggers/:id', { preHandler: requireRole('builder') }, async (request) => {
    const { id } = request.params as { id: string };
    if (!eventTriggers.remove(id)) throw notFound('The trigger');
    audit.record(actor(request), 'trigger.deleted', id);
    return { ok: true };
  });

  // -- chained automations ---------------------------------------------------------------------

  app.get('/api/flows/:id/chains', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    return chains.forFlow(id);
  });

  app.post('/api/flows/:id/chains', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = ChainBody.parse(request.body);
    const chainId = chains.add(id, body, request.user!.displayName);
    audit.record(actor(request), 'chain.created', id, { next: body.nextFlowId, runWhen: body.runWhen });
    return { id: chainId };
  });

  app.patch('/api/chains/:id', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    chains.update(id, ChainBody.pick({ passOutputs: true, enabled: true }).partial().parse(request.body));
    return { ok: true };
  });

  app.delete('/api/chains/:id', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    const removed = chains.remove(id);
    if (!removed) throw notFound('The follow-up');
    audit.record(actor(request), 'chain.deleted', removed.flowId, { chain: id });
    return { ok: true };
  });
}
