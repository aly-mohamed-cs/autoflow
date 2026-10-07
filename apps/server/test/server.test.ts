import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, createServices, type Services } from '../src/app.js';
import { roleForGroups, escapeFilter } from '../src/auth/ldap.js';
import type { Config } from '../src/config.js';
import { Db } from '../src/db.js';
import { Vault } from '../src/security.js';

let app: FastifyInstance;
let svc: Services;
let base: string;
let dataDir: string;
let adminToken: string;

const FLOW = {
  id: 'flow_invoices',
  name: 'Enter invoices',
  description: 'Test flow',
  variables: [{ name: 'customer', type: 'text', is_input: true }],
  steps: [
    { id: 's1', activity: 'control.get_credential', params: { credential: 'Portal' }, outputs: { credential: 'login' } },
    { id: 's2', activity: 'control.log', params: { message: 'Hi {{customer}}' } },
  ],
};

async function api<T = any>(method: string, path: string, body?: unknown, token = adminToken): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method: method as 'GET',
    url: path,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as T };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'autoflow-server-'));
  const config: Config = {
    dataDir,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1',
    tls: null,
    dashboardDir: join(dataDir, 'no-dashboard'),
    sessionHours: 1,
    retentionDays: 30,
    insecureHttp: true,
  };
  const db = new Db(join(dataDir, 'test.db'));
  db.migrate();
  svc = createServices(config, db, Vault.fromKey(Buffer.alloc(32, 7)));
  app = await buildApp(svc, { logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  base = `127.0.0.1:${address.port}`;
  svc.gateway.start();
  svc.scheduler.start();
});

afterAll(async () => {
  svc.scheduler.stop();
  svc.gateway.stop();
  await app.close();
  svc.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('setup and sign-in', () => {
  it('creates the first administrator once', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toMatchObject({ needsSetup: true });
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'admin', displayName: 'Admin', password: 'correct horse battery' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toContain('af_session=');
    const again = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'second', displayName: 'Second', password: 'correct horse battery' } });
    expect(again.statusCode).toBe(409);
  });

  it('signs in and rejects wrong passwords', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ADMIN', password: 'correct horse battery', client: 'studio' } });
    expect(ok.statusCode).toBe(200);
    adminToken = ok.json().token;
    expect((await api('GET', '/api/auth/me')).body.user).toMatchObject({ username: 'admin', role: 'admin' });
  });

  it('enforces roles and blocks cookie requests without the CSRF header', async () => {
    await api('POST', '/api/users', { username: 'vic', displayName: 'Viewer', role: 'viewer', password: 'viewer password 1' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'vic', password: 'viewer password 1' } });
    const viewer = login.json().token;
    expect((await api('GET', '/api/flows', undefined, viewer)).status).toBe(200);
    expect((await api('POST', `/api/flows/${FLOW.id}/versions`, { flow: FLOW }, viewer)).status).toBe(403);
    const cookie = login.headers['set-cookie'] as string;
    const csrf = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(csrf.statusCode).toBe(200); // logout itself is harmless
    const blocked = await app.inject({ method: 'PUT', url: '/api/credentials', headers: { cookie: (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct horse battery' } })).headers['set-cookie'] as string }, payload: { name: 'x', password: 'y' } });
    expect(blocked.statusCode).toBe(403);
  });
});

describe('publishing, robots and runs', () => {
  let robotToken: string;
  let robot: WebSocket;
  const received: any[] = [];

  it('publishes immutable versions', async () => {
    expect((await api('POST', `/api/flows/${FLOW.id}/versions`, { flow: FLOW, notes: 'first' })).body).toEqual({ version: 1 });
    expect((await api('POST', `/api/flows/${FLOW.id}/versions`, { flow: { ...FLOW, name: 'Enter invoices v2' } })).body).toEqual({ version: 2 });
    const detail = (await api('GET', `/api/flows/${FLOW.id}`)).body;
    expect(detail.flow).toMatchObject({ name: 'Enter invoices v2', latestVersion: 2 });
    expect(detail.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(detail.inputs).toEqual([{ name: 'customer', type: 'text', description: '', default: null, sensitive: false }]);
    expect(detail.credentials).toEqual(['Portal']);
  });

  it('stores credentials encrypted', async () => {
    expect((await api('PUT', '/api/credentials', { name: 'Portal', username: 'robot', password: 'S3cret!' })).status).toBe(200);
    const row = svc.db.get<{ secret: string }>('SELECT secret FROM credentials WHERE name = ?', 'Portal')!;
    expect(row.secret).not.toContain('S3cret');
    expect(svc.vault.decrypt(row.secret)).toBe('S3cret!');
    expect(JSON.stringify((await api('GET', '/api/credentials')).body)).not.toContain('S3cret');
  });

  it('enrolls a robot with a one-time key', async () => {
    const { key } = (await api('POST', '/api/robots/enrollment-keys', { pool: 'default', hours: 1 })).body;
    const enroll = await app.inject({ method: 'POST', url: '/api/robot/enroll', payload: { key, name: 'Robot 1', machine: 'VM-01' } });
    expect(enroll.statusCode).toBe(200);
    robotToken = enroll.json().token;
    const reuse = await app.inject({ method: 'POST', url: '/api/robot/enroll', payload: { key, name: 'Robot 2' } });
    expect(reuse.statusCode).toBe(403);
  });

  it('connects, receives a job, reports events and finishes it', async () => {
    robot = new WebSocket(`ws://${base}/api/robot/connect`, { headers: { authorization: `Bearer ${robotToken}` } });
    robot.on('message', (m) => received.push(JSON.parse(m.toString())));
    await new Promise((resolve) => robot.on('open', resolve));
    robot.send(JSON.stringify({ type: 'hello', version: '0.1.0', capabilities: ['browser'] }));
    await waitFor(() => received.some((m) => m.type === 'welcome'));
    await waitFor(async () => (await api('GET', '/api/robots')).body.robots[0].online);

    const run = await api('POST', `/api/flows/${FLOW.id}/run`, { inputs: { customer: 'Acme' } });
    expect(run.status).toBe(200);
    const jobId = run.body.job.id;
    await waitFor(() => received.some((m) => m.type === 'job.assign'));
    const assign = received.find((m) => m.type === 'job.assign');
    expect(assign.job).toMatchObject({ id: jobId, version: 2, inputs: { customer: 'Acme' } });
    expect(assign.job.flow.name).toBe('Enter invoices v2');

    // Only the credentials this automation uses, only for this robot.
    const creds = await app.inject({ method: 'GET', url: `/api/robot/jobs/${jobId}/credentials`, headers: { authorization: `Bearer ${robotToken}` } });
    expect(creds.json()).toEqual({ credentials: { Portal: { username: 'robot', password: 'S3cret!' } } });
    const stranger = await app.inject({ method: 'GET', url: `/api/robot/jobs/${jobId}/credentials`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(stranger.statusCode).toBe(401);

    const shot = await app.inject({
      method: 'POST',
      url: `/api/robot/jobs/${jobId}/artifacts?name=s2-error.png&step_id=s2&kind=screenshot`,
      headers: { authorization: `Bearer ${robotToken}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([137, 80, 78, 71]),
    });
    expect(shot.statusCode).toBe(200);

    for (const event of [
      { event: 'run_started', ts: 1 },
      { event: 'step_started', step_id: 's2', ts: 2 },
      { event: 'variable', name: 'x', value: 1, ts: 2.5 }, // not kept
      { event: 'log', step_id: 's2', level: 'info', message: 'Hi Acme', ts: 3 },
      { event: 'step_finished', step_id: 's2', status: 'ok', ts: 4 },
    ]) {
      robot.send(JSON.stringify({ type: 'job.event', job_id: jobId, event }));
    }
    robot.send(JSON.stringify({ type: 'job.finished', job_id: jobId, status: 'succeeded', duration_ms: 1234, outputs: { ok: true } }));
    await waitFor(async () => (await api('GET', `/api/jobs/${jobId}`)).body.job.status === 'succeeded');
    const detail = (await api('GET', `/api/jobs/${jobId}`)).body;
    expect(detail.events.map((e: any) => e.event)).toEqual(['run_started', 'step_started', 'log', 'step_finished']);
    expect(detail.job).toMatchObject({ durationMs: 1234, outputs: { ok: true }, robotName: 'Robot 1', flowName: 'Enter invoices v2' });
    expect(detail.artifacts[0]).toMatchObject({ kind: 'screenshot', stepId: 's2' });
    const img = await app.inject({ method: 'GET', url: `/api/artifacts/${detail.artifacts[0].id}`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(img.headers['content-type']).toBe('image/png');

    const stats = (await api('GET', '/api/stats')).body;
    expect(stats.today.succeeded).toBe(1);
    expect(stats.robots).toMatchObject({ total: 1, online: 1 });
  });

  it('starts runs from webhooks and reports their status', async () => {
    const hook = (await api('POST', '/api/webhooks', { flowId: FLOW.id, name: 'ERP' })).body;
    const path = new URL(hook.url).pathname;
    const call = await app.inject({ method: 'POST', url: path, payload: { customer: 'From ERP' } });
    expect(call.statusCode).toBe(200);
    const { jobId } = call.json();
    await waitFor(() => received.filter((m) => m.type === 'job.assign').length === 2);
    robot.send(JSON.stringify({ type: 'job.finished', job_id: jobId, status: 'failed', error: { message: 'Portal was down' } }));
    await waitFor(async () => (await app.inject({ method: 'GET', url: `${path}/jobs/${jobId}` })).json().status === 'failed');
    expect((await app.inject({ method: 'POST', url: '/api/hooks/afh_wrong', payload: {} })).statusCode).toBe(404);
  });

  it('turns queue items into runs and retries failures', async () => {
    const { id } = (await api('POST', '/api/queues', { name: 'Invoices', flowId: FLOW.id, maxRetries: 1 })).body;
    expect((await api('POST', `/api/queues/${id}/items`, { items: [{ reference: 'INV-1', data: { no: 'INV-1' } }] })).body).toEqual({ added: 1 });
    const assigned = () => received.filter((m) => m.type === 'job.assign');
    await waitFor(() => assigned().length === 3);
    const first = assigned()[2].job;
    expect(first.inputs).toEqual({ queue_item: { no: 'INV-1' }, queue_item_reference: 'INV-1' });
    robot.send(JSON.stringify({ type: 'job.finished', job_id: first.id, status: 'failed', error: { message: 'timeout' } }));
    await waitFor(() => assigned().length === 4); // retried once
    robot.send(JSON.stringify({ type: 'job.finished', job_id: assigned()[3].job.id, status: 'succeeded', outputs: { ref: 'R-9' } }));
    await waitFor(async () => (await api('GET', `/api/queues/${id}/items`)).body.items[0].status === 'done');
    const item = (await api('GET', `/api/queues/${id}/items`)).body.items[0];
    expect(item).toMatchObject({ attempts: 2, result: { ref: 'R-9' } });
  });

  it('cancels a queued run and validates schedules', async () => {
    robot.close();
    await waitFor(async () => !(await api('GET', '/api/robots')).body.robots[0].online);
    const run = (await api('POST', `/api/flows/${FLOW.id}/run`, {})).body.job;
    expect(run.status).toBe('queued');
    expect((await api('POST', `/api/jobs/${run.id}/cancel`)).body.job.status).toBe('cancelled');
    expect((await api('POST', '/api/schedules', { flowId: FLOW.id, name: 'Bad', cron: 'not a cron' })).status).toBe(400);
    const created = (await api('POST', '/api/schedules', { flowId: FLOW.id, name: 'Weekdays 8:00', cron: '0 8 * * 1-5', timezone: 'Africa/Cairo' })).body;
    expect(created.nextRunAt).toMatch(/^\d{4}-/);
    const preview = (await api('POST', '/api/schedules/preview', { cron: '0 8 * * 1-5', timezone: 'Africa/Cairo' })).body;
    expect(preview.next).toHaveLength(5);
  });

  it('records an audit trail', async () => {
    const actions = (await api('GET', '/api/audit')).body.entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['setup.admin_created', 'flow.published', 'credential.created', 'robot.enrolled', 'credentials.read', 'job.started']));
  });
});

describe('directory helpers', () => {
  it('maps AD groups to the highest role', () => {
    const settings = { groupRoles: { admin: ['RPA-Admins'], builder: ['CN=RPA-Builders,OU=Groups,DC=c,DC=local'], operator: [], viewer: ['Domain Users'] }, defaultRole: null };
    expect(roleForGroups(['CN=Domain Users,CN=Users,DC=c,DC=local'], settings)).toBe('viewer');
    expect(roleForGroups(['CN=RPA-Builders,OU=Groups,DC=c,DC=local', 'CN=Domain Users,DC=x'], settings)).toBe('builder');
    expect(roleForGroups(['CN=rpa-admins,OU=G,DC=c'], settings)).toBe('admin');
    expect(roleForGroups(['CN=Other,DC=c'], settings)).toBeNull();
  });

  it('escapes LDAP filters', () => {
    expect(escapeFilter('a*b(c)\\')).toBe('a\\2ab\\28c\\29\\5c');
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not reached');
}
