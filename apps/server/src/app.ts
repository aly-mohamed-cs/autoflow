import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { sessionToken, userForToken } from './auth/sessions.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { flowRoutes } from './routes/flows.js';
import { jobRoutes } from './routes/jobs.js';
import { robotRoutes } from './routes/robots.js';
import { triggerRoutes } from './routes/triggers.js';
import type { Vault } from './security.js';
import { Audit, Bus, HttpError, Settings } from './services/core.js';
import { Gateway } from './services/gateway.js';
import { Jobs } from './services/jobs.js';
import { Queues, Scheduler } from './services/triggers.js';

export const VERSION = '0.1.0';

export interface Services {
  config: Config;
  db: Db;
  vault: Vault;
  bus: Bus;
  settings: Settings;
  audit: Audit;
  jobs: Jobs;
  gateway: Gateway;
  scheduler: Scheduler;
  queues: Queues;
}

declare module 'fastify' {
  interface FastifyInstance {
    svc: Services;
  }
}

export function createServices(config: Config, db: Db, vault: Vault): Services {
  const bus = new Bus();
  bus.setMaxListeners(500);
  const jobs = new Jobs(db, bus);
  return {
    config,
    db,
    vault,
    bus,
    settings: new Settings(db),
    audit: new Audit(db),
    jobs,
    gateway: new Gateway(db, jobs, bus),
    scheduler: new Scheduler(db, jobs),
    queues: new Queues(db, jobs, bus),
  };
}

export async function buildApp(svc: Services, options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const { config } = svc;
  const https = config.tls
    ? config.tls.pfx
      ? { pfx: readFileSync(config.tls.pfx), passphrase: config.tls.passphrase }
      : { cert: readFileSync(config.tls.cert!), key: readFileSync(config.tls.key!) }
    : null;
  const app = Fastify({
    logger: options.logger ?? { level: 'info' },
    trustProxy: false,
    bodyLimit: 25 * 1024 * 1024,
    ...(https ? { https } : {}),
  }) as unknown as FastifyInstance;

  app.decorate('svc', svc);
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024 } });

  // Who is calling: a signed-in person (cookie or Bearer token). Robots authenticate on their own routes.
  app.addHook('onRequest', async (request) => {
    request.user = userForToken(svc.db, sessionToken(request)) ?? undefined;
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof ZodError) {
      const first = error.issues[0];
      return reply.code(400).send({ error: `${first?.path.join('.') || 'Request'}: ${first?.message ?? 'invalid'}` });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
    request.log.error(error);
    return reply.code(500).send({ error: 'Something went wrong on the server. The administrator can find details in the server log.' });
  });

  app.get('/health', async () => ({ ok: true, version: VERSION, time: new Date().toISOString() }));

  await app.register(authRoutes);
  await app.register(flowRoutes);
  await app.register(jobRoutes);
  await app.register(robotRoutes);
  await app.register(triggerRoutes);
  await app.register(adminRoutes);

  // Installers for Studio and Robot (copied here by update-server.ps1).
  const installers = join(config.dataDir, 'installers');
  mkdirSync(installers, { recursive: true });
  await app.register(fastifyStatic, { root: installers, prefix: '/downloads/', decorateReply: false, serve: true });

  // The dashboard (single-page app).
  if (existsSync(config.dashboardDir)) {
    // wildcard: files are looked up per request, so a rebuilt dashboard is served without a restart.
    await app.register(fastifyStatic, { root: config.dashboardDir, prefix: '/', wildcard: true });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({ message: 'Autoflow Orchestrator is running. The dashboard has not been built yet (pnpm --filter @autoflow/dashboard build).' }));
  }
  return app;
}
