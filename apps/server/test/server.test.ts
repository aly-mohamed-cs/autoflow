import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, createServices, type Services } from '../src/app.js';
import { roleForGroups, escapeFilter } from '../src/auth/ldap.js';
import { extractJson, pickCategory, sanitizeSteps } from '../src/services/ai.js';
import { applyPatches } from '../src/services/repairs.js';
import { compareVersions } from '../src/services/robotReleases.js';
import type { Config } from '../src/config.js';
import { Db } from '../src/db.js';
import { MIGRATIONS } from '../src/migrations.js';
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

  it('lets running automations take queue items, and gives back the ones they did not finish', async () => {
    const { id: queueId } = (await api('POST', '/api/queues', { name: 'Work', maxRetries: 2 })).body;
    await api('POST', `/api/queues/${queueId}/items`, { items: [{ reference: 'A', data: { n: 1 } }, { reference: 'B', data: { n: 2 } }] });
    const run = (await api('POST', `/api/flows/${FLOW.id}/run`, {})).body.job;
    await waitFor(() => received.some((m) => m.type === 'job.assign' && m.job.id === run.id));
    const ask = (body: unknown, job = run.id, token = robotToken) =>
      app.inject({ method: 'POST', url: `/api/robot/jobs/${job}/orchestrator`, headers: { authorization: `Bearer ${token}` }, payload: body as object });

    const first = (await ask({ op: 'queue.next', queue: 'work' })).json().item; // names ignore case
    expect(first).toMatchObject({ reference: 'A', data: { n: 1 }, attempt: 1 });
    expect((await ask({ op: 'queue.finish', item: first.id, outcome: 'done', result: { booked: true } })).json()).toEqual({ ok: true });
    const second = (await ask({ op: 'queue.next', queue: 'Work' })).json().item;
    expect(second.reference).toBe('B');
    expect((await ask({ op: 'queue.count', queue: 'Work', status: 'in_progress' })).json()).toEqual({ count: 1 });
    expect((await ask({ op: 'queue.next', queue: 'Work' })).json()).toEqual({ item: null });
    expect((await ask({ op: 'queue.next', queue: 'Nope' })).json().error).toMatch(/no queue called “Nope”/);
    expect((await ask({ op: 'queue.next', queue: 'Work' }, run.id, adminToken)).statusCode).toBe(401);

    // The run ends without finishing B: it goes back to the queue for the next run.
    robot.send(JSON.stringify({ type: 'job.finished', job_id: run.id, status: 'succeeded' }));
    await waitFor(async () => (await api('GET', `/api/queues/${queueId}/items`)).body.items.some((i: any) => i.reference === 'B' && i.status === 'new'));
    const items = (await api('GET', `/api/queues/${queueId}/items`)).body.items;
    expect(items.find((i: any) => i.reference === 'A')).toMatchObject({ status: 'done', result: { booked: true } });
    expect((await ask({ op: 'queue.next', queue: 'Work' })).statusCode).toBe(403); // the run is over
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

describe('AI assistant (local model)', () => {
  let model: Server;
  let modelUrl: string;
  const received: { auth?: string; body: any }[] = [];
  let reply: (body: any) => { status?: number; content: string } = () => ({ content: '' });

  beforeAll(async () => {
    model = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        received.push({ auth: req.headers.authorization, body });
        const r = reply(body);
        res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: r.content } }] }));
      });
    });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
  });

  afterAll(() => new Promise<void>((resolve) => model.close(() => resolve())));

  it('is off until an administrator turns it on', async () => {
    expect((await api('GET', '/api/ai/status')).body).toEqual({ enabled: false, model: null });
    expect((await api('POST', '/api/ai/draft-flow', { description: 'Read invoices from Excel and log each one' })).status).toBe(404);
  });

  it('stores the model server key encrypted and never returns it', async () => {
    const saved = await api('PUT', '/api/settings/ai', { enabled: true, baseUrl: modelUrl, model: 'test-model', apiKey: 'sk-local-123', timeoutS: 30 });
    expect(saved.status).toBe(200);
    const stored = svc.settings.get<{ apiKey: string }>('ai', { apiKey: '' });
    expect(stored.apiKey).not.toContain('sk-local-123');
    const shown = await api('GET', '/api/settings/ai');
    expect(shown.body.ai).toMatchObject({ enabled: true, model: 'test-model', apiKey: '••••••' });
    // Saving the masked value again keeps the stored key.
    await api('PUT', '/api/settings/ai', { ...shown.body.ai, apiKey: '••••••' });
    expect(svc.settings.get<{ apiKey: string }>('ai', { apiKey: '' }).apiKey).toBe(stored.apiKey);
    expect((await api('GET', '/api/ai/status')).body).toEqual({ enabled: true, model: 'test-model' });
  });

  it('drafts a flow from a description and keeps only known steps and settings', async () => {
    reply = () => ({
      content:
        'Here is the automation:\n```json\n' +
        JSON.stringify({
          name: 'Log invoices',
          description: 'Reads the invoice sheet and logs each row',
          variables: [{ name: 'invoice_file', type: 'file', is_input: true }, { name: 'bad name!', type: 'text' }],
          steps: [
            { activity: 'excel.read', params: { file: '{{invoice_file}}', sheet: 'Invoices', has_header: true, evil: 'x' }, outputs: { table: 'invoices' } },
            {
              activity: 'control.for_each',
              params: { items: '{{invoices}}', item_variable: 'row' },
              blocks: { body: [{ activity: 'control.log', label: 'Log it', params: { message: 'Invoice {{row["Number"]}}' } }, { activity: 'shell.format_disk', params: {} }] },
            },
            { activity: 'browser.run_script', params: { script: 'alert(1)' } },
          ],
        }) +
        '\n```',
    });
    const res = await api('POST', '/api/ai/draft-flow', { description: 'Read invoices from Excel and log each one' });
    expect(res.status).toBe(200);
    const { flow, dropped } = res.body;
    expect(dropped.sort()).toEqual(['browser.run_script', 'shell.format_disk']);
    expect(flow.name).toBe('Log invoices');
    expect(flow.variables.map((v: { name: string }) => v.name)).toEqual(['invoice_file']);
    expect(flow.steps.map((s: { activity: string }) => s.activity)).toEqual(['excel.read', 'control.for_each']);
    expect(flow.steps[0].params).toEqual({ file: '{{invoice_file}}', sheet: 'Invoices', has_header: true });
    expect(flow.steps[0].outputs).toEqual({ table: 'invoices' });
    expect(flow.steps[1].blocks.body).toHaveLength(1);
    expect(flow.steps[1].blocks.body[0]).toMatchObject({ activity: 'control.log', label: 'Log it' });
    expect(new Set(JSON.stringify(flow).match(/"id":"s[0-9a-f]+"/g)).size).toBe(3);

    const sent = received.at(-1)!;
    expect(sent.auth).toBe('Bearer sk-local-123');
    expect(sent.body).toMatchObject({ model: 'test-model', response_format: { type: 'json_object' } });
    expect(sent.body.messages[0].content).toContain('control.for_each');
    expect(sent.body.messages[0].content).not.toContain('browser.run_script');
  });

  it('explains errors without sending secrets and reports model problems plainly', async () => {
    reply = () => ({ content: '  The page did not show the Login button in time. Pick the element again.  ' });
    const res = await api('POST', '/api/ai/explain-error', {
      activity: 'browser.click',
      message: "Couldn't find 'Login button' after 10 s",
      params: { element: 'Login button', password: 'hunter2' },
    });
    expect(res.body.explanation).toBe('The page did not show the Login button in time. Pick the element again.');
    expect(JSON.stringify(received.at(-1)!.body)).not.toContain('hunter2');

    reply = () => ({ status: 500, content: '' });
    const failed = await api('POST', '/api/ai/explain-error', { activity: 'browser.click', message: 'x' });
    expect(failed.status).toBe(502);
    expect((await api('POST', '/api/settings/ai/test')).body).toMatchObject({ ok: false });

    reply = () => ({ content: 'not json at all' });
    expect((await api('POST', '/api/ai/draft-flow', { description: 'Read invoices from Excel and log each one' })).status).toBe(502);
  });

  it('lets robots fix failed steps and files working fixes for a builder to approve', async () => {
    const flow = {
      id: 'flow_fixable',
      name: 'Fixable',
      steps: [
        { id: 'open', activity: 'browser.open', params: { url: 'http://portal.local' } },
        { id: 'click', activity: 'browser.click', params: { element: 'btn' } },
      ],
      elements: [
        { id: 'btn', name: 'Log on button', kind: 'web', screenshot: 'data:image/png;base64,AAAA', selectors: [{ strategy: 'role', value: 'button', options: { name: 'Log on' } }] },
      ],
    };
    await api('POST', `/api/flows/${flow.id}/versions`, { flow });
    const { key } = (await api('POST', '/api/robots/enrollment-keys', { pool: 'ai', hours: 1 })).body;
    const token = (await app.inject({ method: 'POST', url: '/api/robot/enroll', payload: { key, name: 'AI robot' } })).json().token;
    const asRobot = { authorization: `Bearer ${token}` };
    const messages: any[] = [];
    const ws = new WebSocket(`ws://${base}/api/robot/connect`, { headers: asRobot });
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'hello', version: '0.1.0', capabilities: ['browser'] }));
    await waitFor(() => messages.some((m) => m.type === 'welcome'));

    const jobId = (await api('POST', `/api/flows/${flow.id}/run`, { pool: 'ai' })).body.job.id;
    await waitFor(() => messages.some((m) => m.type === 'job.assign'));
    expect(messages.find((m) => m.type === 'job.assign').job).toMatchObject({ id: jobId, repair: true });

    reply = () => ({
      content: JSON.stringify({
        fixable: true,
        explanation: 'The button is now called "Sign in".',
        params: { timeout: 5, element: 'other', bogus: 1 },
        selectors: [
          { strategy: 'role', value: 'button', options: { name: 'Sign in', exact: true, onclick: 'evil()' } },
          { strategy: 'uia', value: 'Button', options: {} },
        ],
      }),
    });
    const request = {
      flow_name: 'Fixable',
      activity: 'browser.click',
      step: { id: 'click', label: null, params: { element: 'btn' } },
      element: { id: 'btn', name: 'Log on button', kind: 'web', selectors: flow.elements[0]!.selectors, context: {} },
      error: { message: "Couldn't find 'Log on button' after 30 seconds.", hint: null },
      screen: { kind: 'web', url: 'http://portal.local', title: 'Portal', elements: [{ tag: 'button', type: 'submit', text: 'Sign in' }] },
      variables: [],
      attempts: [],
    };
    const fix = await app.inject({ method: 'POST', url: `/api/robot/jobs/${jobId}/repair`, headers: asRobot, payload: request });
    expect(fix.json()).toEqual({
      fixable: true,
      explanation: 'The button is now called "Sign in".',
      params: { timeout: 5 },
      selectors: [{ strategy: 'role', value: 'button', options: { name: 'Sign in', exact: true } }],
    });
    expect(received.at(-1)!.body.messages[1].content).toContain("Couldn't find 'Log on button'");
    const outsider = await app.inject({ method: 'POST', url: `/api/robot/jobs/${jobId}/repair`, headers: { authorization: `Bearer ${adminToken}` }, payload: request });
    expect(outsider.statusCode).toBe(401);

    // The engine reports that the fix worked; the run finishes.
    const patched = { ...request.element, selectors: [fix.json().selectors[0], ...request.element.selectors] };
    ws.send(JSON.stringify({ type: 'job.event', job_id: jobId, event: { event: 'repair_started', step_id: 'click', attempt: 1, ts: 1 } }));
    ws.send(
      JSON.stringify({
        type: 'job.event',
        job_id: jobId,
        event: {
          event: 'step_repaired',
          step_id: 'click',
          attempt: 1,
          ts: 2,
          explanation: 'The button is now called "Sign in".',
          patch: { step_id: 'click', params: { timeout: 5 }, element: patched, new_element: false },
        },
      }),
    );
    // A robot can't slip other changes into the suggestion: web addresses and other elements are dropped.
    ws.send(
      JSON.stringify({
        type: 'job.event',
        job_id: jobId,
        event: {
          event: 'step_repaired',
          step_id: 'open',
          ts: 3,
          explanation: 'Use another site.',
          patch: { step_id: 'open', params: { url: 'http://evil.example' }, element: null, new_element: false },
        },
      }),
    );
    ws.send(JSON.stringify({ type: 'job.finished', job_id: jobId, status: 'succeeded', duration_ms: 10 }));
    await waitFor(async () => (await api('GET', `/api/flows/${flow.id}`)).body.fixes.length === 1);

    const runDetail = (await api('GET', `/api/jobs/${jobId}`)).body;
    expect(runDetail.events.map((e: any) => e.event)).toEqual(['repair_started', 'step_repaired', 'step_repaired']);
    expect(runDetail.fix.patches.map((p: any) => p.step_id)).toEqual(['click']);
    expect(runDetail.fix).toMatchObject({ status: 'pending', baseVersion: 1, patches: [{ step_id: 'click', explanation: 'The button is now called "Sign in".' }] });
    expect((await api('GET', '/api/flows')).body.flows.find((f: any) => f.id === flow.id).pendingFixes).toBe(1);

    const approved = await api('POST', `/api/fixes/${runDetail.fix.id}/approve`, {});
    expect(approved.body).toEqual({ version: 2, flowId: flow.id });
    const v2 = (await api('GET', `/api/flows/${flow.id}/versions/2`)).body.definition;
    expect(v2.steps[1].params).toEqual({ element: 'btn', timeout: 5 });
    expect(v2.elements[0].selectors.map((s: any) => s.options.name)).toEqual(['Sign in', 'Log on']);
    expect(v2.elements[0].screenshot).toBe('data:image/png;base64,AAAA');
    expect((await api('GET', `/api/flows/${flow.id}`)).body.versions[0].notes).toContain('The button is now called "Sign in".');
    expect((await api('POST', `/api/fixes/${runDetail.fix.id}/approve`, {})).status).toBe(409);

    // Builders can turn repair off per automation.
    await api('PATCH', `/api/flows/${flow.id}`, { aiRepair: false });
    const second = (await api('POST', `/api/flows/${flow.id}/run`, { pool: 'ai' })).body.job.id;
    await waitFor(() => messages.filter((m) => m.type === 'job.assign').length === 2);
    expect(messages.filter((m) => m.type === 'job.assign')[1].job.repair).toBe(false);
    const off = await app.inject({ method: 'POST', url: `/api/robot/jobs/${second}/repair`, headers: asRobot, payload: request });
    expect(off.json()).toMatchObject({ fixable: false });
    ws.send(JSON.stringify({ type: 'job.finished', job_id: second, status: 'failed', duration_ms: 10 }));
    await waitFor(async () => (await api('GET', `/api/jobs/${second}`)).body.job.status === 'failed');
    ws.close();
  });

  it('only applies fixes that still fit the automation', () => {
    const flow = { id: 'f', name: 'f', steps: [{ id: 'a', activity: 'control.log', params: { message: 'x' } }] } as any;
    expect(() => applyPatches(flow, [{ step_id: 'gone', params: {}, element: null, new_element: false, explanation: '' }])).toThrow(/changed after this run/);
    const added = applyPatches(flow, [
      {
        step_id: 'a',
        params: { element: 'el_ai_a' },
        element: { id: 'el_ai_a', name: 'Save', kind: 'web', selectors: [{ strategy: 'text', value: 'Save' }] } as any,
        new_element: true,
        explanation: '',
      },
    ]);
    expect(added.elements).toHaveLength(1);
    expect(flow.elements).toBeUndefined(); // the original is untouched
  });

  it('suggests repairs for Studio test runs without touching credentials', async () => {
    reply = () => ({ content: '{"fixable": true, "explanation": "Use the right sheet.", "params": {"sheet": "Invoices 2026", "password": "x"}}' });
    const res = await api('POST', '/api/ai/repair-step', {
      activity: 'excel.read',
      step: { id: 's1', params: { file: 'C:/data/inv.xlsx', sheet: 'Invoices' } },
      error: { message: "There is no sheet named 'Invoices'." },
      screen: { kind: 'files', paths: { file: { workbook: 'C:/data/inv.xlsx', sheets: [{ name: 'Invoices 2026', first_row: ['Number'] }] } } },
    });
    expect(res.body).toEqual({ fixable: true, explanation: 'Use the right sheet.', params: { sheet: 'Invoices 2026' } });
  });

  it('says plainly when the model server is not running', async () => {
    const shown = (await api('GET', '/api/settings/ai')).body.ai;
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise((resolve) => closed.close(resolve)); // a port where nothing listens
    await api('PUT', '/api/settings/ai', { ...shown, baseUrl: `http://localhost:${port}/v1` });
    const res = await api('POST', '/api/ai/explain-error', { activity: 'browser.click', message: 'x' });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain(`Nothing is answering at localhost:${port}`);
    await api('PUT', '/api/settings/ai', { ...shown, baseUrl: modelUrl });
  });

  it('stores conditions from drafts in their proper shape', () => {
    const [step] = sanitizeSteps([{ activity: 'control.if', params: { condition: '{{amount}} > 100' }, blocks: { then: [] } }], []);
    expect(step!.params!.condition).toEqual({ match: 'all', rules: [], expression: '{{amount > 100}}' });
  });

  it('finds JSON in chatty answers', () => {
    expect(extractJson('Sure! {"a": {"b": 1}} Hope that helps')).toBe('{"a": {"b": 1}}');
    expect(extractJson('```json\n{"x": 2}\n```')).toBe('{"x": 2}');
  });

  it('does the tasks of the AI step: classify, pull out fields, translate', async () => {
    await api('PUT', '/api/settings/ai', { enabled: true, baseUrl: modelUrl, model: 'test-model', apiKey: '', timeoutS: 30 });
    reply = (body) => {
      const system = body.messages[0].content as string;
      if (system.startsWith('Sort')) return { content: '"Invoice".' };
      if (system.startsWith('Pull')) return { content: 'Sure: {"Total": "120.50", "Due date": null, "extra": 1}' };
      return { content: ' Bonjour ' };
    };
    const classify = await api('POST', '/api/ai/complete', { task: 'classify', text: 'Invoice 42 attached', categories: ['Order', 'Invoice'] });
    expect(classify.body).toEqual({ result: 'Invoice' });
    const extract = await api('POST', '/api/ai/complete', { task: 'extract', text: 'Total 120.50', fields: ['Total', 'Due date'] });
    expect(extract.body).toEqual({ result: { Total: '120.50', 'Due date': null } });
    const translate = await api('POST', '/api/ai/complete', { task: 'translate', text: 'Hello', language: 'French' });
    expect(translate.body).toEqual({ result: 'Bonjour' });
    expect((await api('POST', '/api/ai/complete', { task: 'classify', text: 'x', categories: [] })).status).toBe(400);
  });

  it('matches the category a model meant', () => {
    expect(pickCategory('Category: complaint.', ['Invoice', 'Complaint'])).toBe('Complaint');
    expect(pickCategory('ORDER', ['Order', 'Purchase order'])).toBe('Order');
    expect(pickCategory('It is a purchase order', ['Order', 'Purchase order'])).toBe('Purchase order');
    expect(pickCategory('No idea', ['Order'])).toBe('No idea');
  });
});

describe('shared values and queues in Studio test runs', () => {
  const run = (body: unknown) => api('POST', '/api/run/orchestrator', body);

  it('keeps shared values and hands them to running automations', async () => {
    expect((await api('PUT', '/api/assets', { name: 'Portal address', kind: 'text', value: 'https://vendors.example' })).status).toBe(200);
    expect((await api('PUT', '/api/assets', { name: 'Limit', kind: 'number', value: 'lots' })).body.error).toBe('Enter a number.');
    await api('PUT', '/api/assets', { name: 'Limit', kind: 'number', value: '250' });
    await api('PUT', '/api/assets', { name: 'Live', kind: 'yesno', value: 'true' });
    const content = Buffer.from('item,price\nA,1\n').toString('base64');
    await api('PUT', '/api/assets', { name: 'Prices', kind: 'file', fileName: 'prices.csv', content, description: 'Price list' });

    const list = (await api('GET', '/api/assets')).body.assets;
    expect(list.map((a: any) => a.name)).toEqual(['Limit', 'Live', 'Portal address', 'Prices']);
    expect(list[3]).toMatchObject({ kind: 'file', value: '', fileName: 'prices.csv', fileSize: 15 });
    expect((await run({ op: 'asset.get', name: 'portal address' })).body).toEqual({ kind: 'text', value: 'https://vendors.example' });
    expect((await run({ op: 'asset.get', name: 'Limit' })).body).toEqual({ kind: 'number', value: 250 });
    expect((await run({ op: 'asset.get', name: 'Live' })).body).toEqual({ kind: 'yesno', value: true });
    expect((await run({ op: 'asset.get', name: 'Prices' })).body).toMatchObject({ kind: 'file', fileName: 'prices.csv', content });
    expect((await run({ op: 'asset.get', name: 'Nope' })).status).toBe(404);

    // Editing without a new file keeps the file; deleting removes it from disk.
    await api('PUT', '/api/assets', { name: 'Prices', kind: 'file', description: 'Prices 2026' });
    expect((await run({ op: 'asset.get', name: 'Prices' })).body.content).toBe(content);
    const stored = svc.db.get<{ value: string }>('SELECT value FROM assets WHERE name = ?', 'Prices')!.value;
    await api('DELETE', '/api/assets/Prices');
    expect(existsSync(join(dataDir, 'assets', stored))).toBe(false);
    expect(svc.db.all('SELECT * FROM audit WHERE action LIKE ?', 'asset.%')).toHaveLength(6);
  });

  it('lets test runs fill and work a queue, and gives unfinished items back afterwards', async () => {
    await api('POST', '/api/queues', { name: 'Test work', maxRetries: 1 });
    expect((await run({ op: 'queue.add', queue: 'Test work', reference: 'X', data: { n: 1 } })).body.id).toMatch(/^qi_/);
    await run({ op: 'queue.add', queue: 'Test work', reference: 'Y', data: { n: 2 } });
    const x = (await run({ op: 'queue.next', queue: 'Test work' })).body.item;
    expect((await run({ op: 'queue.finish', item: x.id, outcome: 'retry', message: 'Portal down' })).body).toEqual({ ok: true });
    expect((await run({ op: 'queue.count', queue: 'Test work', status: 'new' })).body).toEqual({ count: 2 });

    const again = (await run({ op: 'queue.next', queue: 'Test work' })).body.item;
    expect(again).toMatchObject({ reference: 'Y' }); // X went to the back
    const x2 = (await run({ op: 'queue.next', queue: 'Test work' })).body.item;
    expect(x2).toMatchObject({ reference: 'X', attempt: 2 });
    await run({ op: 'queue.finish', item: x2.id, outcome: 'retry', message: 'Still down' });
    expect((await run({ op: 'queue.count', queue: 'Test work', status: 'failed' })).body).toEqual({ count: 1 }); // out of retries

    // The test run ends with Y unfinished: it goes back, and the try doesn't count.
    expect((await run({ op: 'queue.release' })).body).toEqual({ released: 1 });
    const queueId = svc.db.get<{ id: string }>('SELECT id FROM queues WHERE name = ?', 'Test work')!.id;
    const y = (await api('GET', `/api/queues/${queueId}/items`)).body.items.find((i: any) => i.reference === 'Y');
    expect(y).toMatchObject({ status: 'new', attempts: 0, jobId: null });
    expect((await run({ op: 'queue.finish', item: y.id, outcome: 'done' })).body.error).toMatch(/not being worked on by this run/);
    expect((await api('GET', '/api/run/names')).body).toMatchObject({ assets: ['Limit', 'Live', 'Portal address'], queues: expect.arrayContaining(['Test work']) });
  });
});

describe('steps that run commands or scripts', () => {
  it('can only be published by administrators, unless they allow builders', async () => {
    await api('POST', '/api/users', { username: 'bob', displayName: 'Builder', role: 'builder', password: 'builder password 1' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'builder password 1' } });
    const builder = login.json().token;
    const scripted = {
      id: 'flow_scripts',
      name: 'Nightly clean-up',
      steps: [
        { id: 'c', activity: 'system.run_command', params: { command: 'del /q C:\\Temp\\*.tmp' } },
        { id: 'p', activity: 'system.run_python', params: { code: 'result = 1' }, disabled: true },
      ],
    };
    const denied = await api('POST', `/api/flows/${scripted.id}/versions`, { flow: scripted }, builder);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain('(Run command)'); // a skipped step does not count
    expect((await api('POST', `/api/flows/${scripted.id}/versions`, { flow: scripted })).status).toBe(200); // admin

    expect((await api('GET', '/api/settings/security', undefined, builder)).status).toBe(403);
    expect((await api('PUT', '/api/settings/security', { builderScripts: true })).status).toBe(200);
    expect((await api('POST', `/api/flows/${scripted.id}/versions`, { flow: scripted }, builder)).status).toBe(200);
    expect((await api('GET', '/api/settings/security')).body).toEqual({ security: { builderScripts: true } });
    const audit = (await api('GET', '/api/audit')).body.entries;
    expect(audit.find((e: any) => e.action === 'flow.published' && e.target === scripted.id)?.details).toMatchObject({
      scripts: ['Run command'],
    });
    await api('PUT', '/api/settings/security', { builderScripts: false });
  });
});

describe('event triggers and chained automations', () => {
  const publish = (id: string, name: string, inputs: string[] = []) =>
    api('POST', `/api/flows/${id}/versions`, {
      flow: { id, name, variables: inputs.map((n) => ({ name: n, type: 'any', is_input: true })), steps: [{ id: 's1', activity: 'control.log', params: { message: 'hi' } }] },
    });
  const enrollRobot = async (pool: string, name: string) => {
    const { key } = (await api('POST', '/api/robots/enrollment-keys', { pool, hours: 1 })).body;
    return (await app.inject({ method: 'POST', url: '/api/robot/enroll', payload: { key, name } })).json() as { token: string };
  };
  const triggers = async () => (await api('GET', '/api/event-triggers')).body.triggers as any[];

  it('hands each trigger to one online robot, which starts one run per new file or email', async () => {
    await publish('flow_inbox', 'Process invoices');
    const robot = await enrollRobot('watchers', 'Watcher');
    const messages: any[] = [];
    const connect = async () => {
      const ws = new WebSocket(`ws://${base}/api/robot/connect`, { headers: { authorization: `Bearer ${robot.token}` } });
      ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
      await new Promise((resolve) => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'hello', version: '0.5.0', capabilities: [] }));
      return ws;
    };
    let ws = await connect();
    const lastWatch = () => messages.filter((m) => m.type === 'watch').at(-1);

    const file = (await api('POST', '/api/event-triggers', {
      kind: 'file', flowId: 'flow_inbox', name: 'New invoices', pool: 'watchers', config: { folder: 'C:\\Invoices', pattern: '*.pdf' },
    })).body;
    await waitFor(() => lastWatch()?.triggers.length === 1);
    expect(lastWatch().triggers[0]).toMatchObject({ id: file.id, kind: 'file', config: { folder: 'C:\\Invoices', pattern: '*.pdf', subfolders: false, intervalS: 30 } });
    expect(lastWatch().triggers[0].since).toMatch(/^\d{4}-/); // files from before don't count

    const fire = (id: string, key: string, data: unknown) => ws.send(JSON.stringify({ type: 'trigger.fired', trigger_id: id, key, data }));
    fire(file.id, 'C:\\Invoices\\a.pdf|1|10', { path: 'C:\\Invoices\\a.pdf', name: 'a.pdf' });
    fire(file.id, 'C:\\Invoices\\a.pdf|1|10', { path: 'C:\\Invoices\\a.pdf', name: 'a.pdf' }); // seen again: no second run
    fire(file.id, 'C:\\Invoices\\b.pdf|1|10', { wrong: true }); // not what a file trigger reports
    fire('trg_unknown', 'x', { path: 'x', name: 'x' });
    await waitFor(async () => (await triggers())[0]?.runs === 1);
    await new Promise((r) => setTimeout(r, 100));
    const runs = svc.db.all<any>(`SELECT * FROM jobs WHERE trigger = 'event'`);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ flow_id: 'flow_inbox', pool: 'watchers', triggered_by: 'Trigger “New invoices”', trigger_ref: file.id });
    expect(JSON.parse(runs[0].inputs)).toEqual({ trigger_file: 'C:\\Invoices\\a.pdf', trigger_file_name: 'a.pdf' });

    ws.send(JSON.stringify({ type: 'trigger.status', trigger_id: file.id, error: 'The folder C:\\Invoices was not found.' }));
    await waitFor(async () => (await triggers())[0].lastError !== null);
    expect((await triggers())[0]).toMatchObject({ flowName: 'Process invoices', watcher: { name: 'Watcher', online: true }, includeExisting: false, lastError: 'The folder C:\\Invoices was not found.' });

    // Email: only the robot watching the trigger gets the mailbox password.
    await api('PUT', '/api/credentials', { name: 'Invoices mailbox', username: 'invoices@company.local', password: 'Mailbox-pass1' });
    const mail = (await api('POST', '/api/event-triggers', {
      kind: 'email', flowId: 'flow_inbox', name: 'Invoice mails', pool: 'watchers', config: { server: 'mail.company.local', credential: 'Invoices mailbox', subjectContains: 'Invoice' },
    })).body;
    await waitFor(() => lastWatch()?.triggers.length === 2);
    const credential = (token: string) => app.inject({ method: 'GET', url: `/api/robot/triggers/${mail.id}/credential`, headers: { authorization: `Bearer ${token}` } });
    expect((await credential(robot.token)).json()).toEqual({ username: 'invoices@company.local', password: 'Mailbox-pass1' });
    expect((await credential((await enrollRobot('elsewhere', 'Other robot')).token)).statusCode).toBe(403);
    fire(mail.id, 'AAMk1', { id: 'AAMk1', from: 'vendor@example.com', subject: 'Invoice 42', received: '2026-10-13T08:00:00Z', text: 'Please pay', attachments: 'inv42.pdf' });
    await waitFor(() => svc.db.all(`SELECT 1 FROM jobs WHERE trigger = 'event'`).length === 2);
    const emailRun = svc.db.get<any>(`SELECT inputs FROM jobs WHERE trigger = 'event' AND trigger_ref = ?`, mail.id);
    expect(JSON.parse(emailRun.inputs).trigger_email).toMatchObject({ id: 'AAMk1', subject: 'Invoice 42', attachments: 'inv42.pdf' });

    // Turned off: the robot stops watching it. Gone offline: nobody watches; back: told again.
    await api('PUT', `/api/event-triggers/${mail.id}`, {
      kind: 'email', flowId: 'flow_inbox', name: 'Invoice mails', pool: 'watchers', enabled: false, config: { server: 'mail.company.local', credential: 'Invoices mailbox' },
    });
    await waitFor(() => lastWatch()?.triggers.length === 1);
    expect((await credential(robot.token)).statusCode).toBe(403);
    ws.close();
    await waitFor(async () => (await triggers()).every((t) => t.watcher === null));
    messages.length = 0;
    ws = await connect();
    await waitFor(() => lastWatch()?.triggers.length === 1);
    ws.close();
    expect((await api('DELETE', `/api/event-triggers/${file.id}`)).status).toBe(200);
    expect(svc.db.all('SELECT * FROM trigger_events WHERE trigger_id = ?', file.id)).toHaveLength(0);
  });

  it('starts the next automation when one finishes, with its results, and stops endless chains', async () => {
    await publish('flow_report', 'Download report');
    await publish('flow_send', 'Send report', ['report', 'previous_run']);
    await publish('flow_alert', 'Tell IT', ['previous_run', 'report']);
    expect((await api('POST', '/api/flows/flow_report/chains', { runWhen: 'succeeded', nextFlowId: 'flow_send' })).status).toBe(200);
    await api('POST', '/api/flows/flow_report/chains', { runWhen: 'failed', nextFlowId: 'flow_alert', passOutputs: false });
    expect((await api('POST', '/api/flows/flow_report/chains', { runWhen: 'succeeded', nextFlowId: 'flow_send' })).status).toBe(400);
    const chained = () => svc.db.all<any>(`SELECT * FROM jobs WHERE trigger = 'chain' ORDER BY queued_at, rowid`);

    const ok = svc.jobs.create({ flowId: 'flow_report', trigger: 'manual', pool: 'chains' });
    svc.jobs.finish(ok.id, { status: 'succeeded', outputs: { report: 'C:\\out\\r.xlsx', extra: 'not a start value of Send report' } });
    expect(chained()).toHaveLength(1);
    expect(chained()[0]).toMatchObject({ flow_id: 'flow_send', chain_depth: 1, pool: 'chains', triggered_by: 'After “Download report”' });
    expect(JSON.parse(chained()[0].inputs)).toEqual({ report: 'C:\\out\\r.xlsx', previous_run: { automation: 'Download report', status: 'succeeded', error: '', run_id: ok.id } });

    const bad = svc.jobs.create({ flowId: 'flow_report', trigger: 'manual', pool: 'chains' });
    svc.jobs.finish(bad.id, { status: 'failed', outputs: { report: 'x' }, error: { message: 'Portal down' } });
    expect(chained()).toHaveLength(2);
    expect(JSON.parse(chained()[1].inputs)).toEqual({ previous_run: { automation: 'Download report', status: 'failed', error: 'Portal down', run_id: bad.id } });

    const stopped = svc.jobs.create({ flowId: 'flow_report', trigger: 'manual', pool: 'chains' });
    svc.jobs.finish(stopped.id, { status: 'cancelled' });
    expect(chained()).toHaveLength(2); // a person stopped it

    // An automation that starts itself stops after 10 runs in a row.
    await api('POST', '/api/flows/flow_alert/chains', { runWhen: 'finished', nextFlowId: 'flow_alert' });
    svc.jobs.finish(svc.jobs.create({ flowId: 'flow_alert', trigger: 'chain', pool: 'chains', chainDepth: 10 }).id, { status: 'succeeded' });
    expect(chained().filter((j) => j.chain_depth === 11)).toHaveLength(0);

    const links = (await api('GET', '/api/flows/flow_send/chains')).body;
    expect(links.startedBy).toEqual([expect.objectContaining({ flowName: 'Download report', runWhen: 'succeeded' })]);
    const next = (await api('GET', '/api/flows/flow_report/chains')).body.next;
    expect(next.map((c: any) => [c.runWhen, c.nextFlowName, c.passOutputs])).toEqual([['succeeded', 'Send report', true], ['failed', 'Tell IT', false]]);
    expect((await api('PATCH', `/api/chains/${next[0].id}`, { enabled: false })).status).toBe(200);
    expect((await api('GET', '/api/flows/flow_send/chains')).body.startedBy).toEqual([]);
    expect((await api('DELETE', `/api/chains/${next[1].id}`)).status).toBe(200);
  });
});

describe('API keys, notices, server health and the live screen view', () => {
  it('lets other systems run automations with an API key, within its role', async () => {
    const created = (await api('POST', '/api/api-keys', { name: 'ERP', role: 'operator', days: 30 })).body;
    expect(created.key).toMatch(/^afk_/);
    const listed = (await api('GET', '/api/api-keys')).body.keys[0];
    expect(listed).toMatchObject({ name: 'ERP', role: 'operator', hint: `afk_…${created.key.slice(-4)}`, revoked: false });
    expect(JSON.stringify((await api('GET', '/api/api-keys')).body)).not.toContain(created.key); // shown once

    expect((await api('GET', '/api/auth/me', undefined, created.key)).body.user).toMatchObject({ displayName: 'API key “ERP”', role: 'operator', source: 'api' });
    const run = await api('POST', `/api/flows/${FLOW.id}/run`, { inputs: { customer: 'From ERP' } }, created.key);
    expect(run.status).toBe(200);
    expect(run.body.job).toMatchObject({ trigger: 'api', triggeredBy: 'API key “ERP”' });
    await api('POST', `/api/jobs/${run.body.job.id}/cancel`);
    expect((await api('POST', `/api/flows/${FLOW.id}/versions`, { flow: FLOW }, created.key)).status).toBe(403); // not a builder
    expect((await api('GET', '/api/api-keys', undefined, created.key)).status).toBe(403);

    const viewer = (await api('POST', '/api/api-keys', { name: 'Reporting', role: 'viewer', days: null })).body;
    expect((await api('GET', '/api/jobs', undefined, viewer.key)).status).toBe(200);
    expect((await api('POST', `/api/flows/${FLOW.id}/run`, {}, viewer.key)).status).toBe(403);
    expect((await api('POST', '/api/api-keys', { name: 'Too strong', role: 'admin' })).status).toBe(400);

    expect((await api('DELETE', `/api/api-keys/${created.id}`)).status).toBe(200);
    expect((await api('GET', '/api/auth/me', undefined, created.key)).status).toBe(401);
    expect((await api('GET', '/api/auth/me', undefined, 'afk_made_up')).status).toBe(401);
  });

  it('shows notices to everyone until they expire', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const { id } = (await api('POST', '/api/notices', { message: 'Robots are updated tonight at 22:00.', tone: 'warning', until: soon })).body;
    await api('POST', '/api/notices', { message: 'Old news', until: new Date(Date.now() - 1000).toISOString() });
    const viewer = (await api('POST', '/api/api-keys', { name: 'Notice reader', role: 'viewer' })).body.key;
    expect((await api('GET', '/api/notices', undefined, viewer)).body.notices).toEqual([
      expect.objectContaining({ id, message: 'Robots are updated tonight at 22:00.', tone: 'warning', until: soon }),
    ]);
    expect((await api('GET', '/api/notices?all=1')).body.notices).toHaveLength(2);
    expect((await api('POST', '/api/notices', { message: 'x' }, viewer)).status).toBe(403);
    expect((await api('DELETE', `/api/notices/${id}`)).status).toBe(200);
    expect((await api('GET', '/api/notices')).body.notices).toEqual([]);
  });

  it('reports the server health in plain words', async () => {
    const health = (await api('GET', '/api/server-health')).body;
    expect(health).toMatchObject({ version: expect.any(String), robots: { total: expect.any(Number) }, jobs: { queued: expect.any(Number) } });
    expect(health.database.size).toBeGreaterThan(0);
    const names = health.checks.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Backups', 'Certificate', 'Robots', 'Waiting runs', 'Failed runs']));
    expect(health.checks.find((c: any) => c.name === 'Certificate')).toMatchObject({ status: 'warning', message: expect.stringContaining('plain HTTP') });
    const viewer = (await api('POST', '/api/api-keys', { name: 'Health peek', role: 'viewer' })).body.key;
    expect((await api('GET', '/api/server-health', undefined, viewer)).status).toBe(403);
  });

  it('shows a robot screen live only while someone watches, and records who did', async () => {
    const { key } = (await api('POST', '/api/robots/enrollment-keys', { pool: 'screens', hours: 1 })).body;
    const robot = (await app.inject({ method: 'POST', url: '/api/robot/enroll', payload: { key, name: 'Screen robot' } })).json();
    const robotId = svc.db.get<{ id: string }>('SELECT id FROM robots WHERE name = ?', 'Screen robot')!.id;
    expect((await api('GET', `/api/robots/${robotId}/screen`)).body).toEqual({ online: false, frame: null, jobId: null });

    const messages: any[] = [];
    const ws = new WebSocket(`ws://${base}/api/robot/connect`, { headers: { authorization: `Bearer ${robot.token}` } });
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'hello', version: '0.5.0', capabilities: [] }));
    await waitFor(async () => (await api('GET', `/api/robots/${robotId}/screen`)).body.online);
    await waitFor(() => messages.some((m) => m.type === 'screen.watch'));
    expect(messages.filter((m) => m.type === 'screen.watch')).toHaveLength(1);
    expect(messages.find((m) => m.type === 'screen.watch')).toEqual({ type: 'screen.watch', seconds: 20 });
    ws.send(JSON.stringify({ type: 'screen.frame', data: Buffer.from('jpeg bytes').toString('base64'), width: 1280, height: 720 }));
    await waitFor(async () => (await api('GET', `/api/robots/${robotId}/screen`)).body.frame !== null);
    const view = (await api('GET', `/api/robots/${robotId}/screen`)).body;
    expect(view.frame).toMatchObject({ image: `data:image/jpeg;base64,${Buffer.from('jpeg bytes').toString('base64')}`, width: 1280, height: 720, error: null });
    expect(messages.filter((m) => m.type === 'screen.watch')).toHaveLength(1); // not asked again within seconds
    ws.send(JSON.stringify({ type: 'screen.unavailable', reason: 'The screen view is turned off on this robot.' }));
    await waitFor(async () => (await api('GET', `/api/robots/${robotId}/screen`)).body.frame?.error !== null);
    expect(svc.db.all('SELECT * FROM audit WHERE action = ? AND target = ?', 'robot.screen_viewed', robotId)).toHaveLength(1);
    const viewer = (await api('POST', '/api/api-keys', { name: 'Screen peek', role: 'viewer' })).body.key;
    expect((await api('GET', `/api/robots/${robotId}/screen`, undefined, viewer)).status).toBe(403);
    ws.close();
  });
});

/** Just enough of an SMTP server to receive the Orchestrator's emails. */
function fakeSmtp() {
  const mails: string[] = [];
  const server = createNetServer((socket) => {
    let data = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = data ? buffer.indexOf('\r\n.\r\n') : buffer.indexOf('\r\n')) >= 0) {
        if (data) {
          mails.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          data = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake\r\n250 OK\r\n');
        else if (verb === 'DATA') {
          data = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  return { server, mails };
}

describe('sign-in codes by email', () => {
  let smtp: ReturnType<typeof fakeSmtp>;
  let smtpPort: number;
  const login = (username: string, password: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } }).then((r) => ({ status: r.statusCode, body: r.json() }));
  const enterCode = (ticket: string, code: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login/code', payload: { ticket, code } }).then((r) => ({ status: r.statusCode, body: r.json() }));
  const codeIn = (mail: string) => /code is (\d{6})/.exec(mail.replace(/=\r\n/g, ''))?.[1] ?? '';
  const settingsBody = (codes: string) => ({ codes, smtp: { host: '127.0.0.1', port: smtpPort, security: 'none', from: 'autoflow@company.local', username: '' } });

  beforeAll(async () => {
    smtp = fakeSmtp();
    await new Promise<void>((r) => smtp.server.listen(0, '127.0.0.1', r));
    smtpPort = (smtp.server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await api('PUT', '/api/settings/signin', settingsBody('off'));
    smtp.server.close();
  });

  it('can only be turned on with a working mail server and an email address for the administrator', async () => {
    expect((await api('PUT', '/api/settings/signin', { codes: 'admins', smtp: { host: '', port: 25, security: 'none', from: '' } })).body.error).toMatch(/mail server/);
    expect((await api('PUT', '/api/settings/signin', settingsBody('admins'))).body.error).toMatch(/your own email address/);
    expect((await api('POST', '/api/settings/signin/test')).body.error).toMatch(/your own email address/);
    const me = (await api('GET', '/api/auth/me')).body.user;
    expect((await api('PATCH', `/api/users/${me.id}`, { email: 'not an email' })).status).toBe(400);
    expect((await api('PATCH', `/api/users/${me.id}`, { email: 'admin@company.local' })).status).toBe(200);
    await api('PUT', '/api/settings/signin', settingsBody('off'));
    const test = (await api('POST', '/api/settings/signin/test')).body;
    expect(test).toEqual({ ok: true, sentTo: 'admin@company.local' });
    expect(smtp.mails.at(-1)).toContain('Subject: Autoflow test email');
    const saved = (await api('PUT', '/api/settings/signin', { ...settingsBody('admins'), smtp: { ...settingsBody('admins').smtp, password: 'smtp secret' } })).body;
    expect(saved).toMatchObject({ codes: 'admins', smtp: { host: '127.0.0.1', password: '', hasPassword: true } });
    expect(JSON.stringify(svc.db.get('SELECT value FROM settings WHERE key = ?', 'smtp'))).not.toContain('smtp secret');
    // Remove it again: the fake mail server has no sign-in.
    await api('PUT', '/api/settings/signin', { ...settingsBody('admins'), smtp: { ...settingsBody('admins').smtp, password: '' } });
  });

  it('asks administrators for the code from the email, and nobody else', async () => {
    const first = await login('admin', 'correct horse battery');
    expect(first.body).toEqual({ twoFactor: true, ticket: expect.stringMatching(/^afl_/), sentTo: 'a***@company.local' });
    expect(first.body.token).toBeUndefined();
    const code = codeIn(smtp.mails.at(-1)!);
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await enterCode(first.body.ticket, wrong)).body.error).toBe('That code is not right. Check the newest email.');
    expect((await enterCode(first.body.ticket, 'abc')).status).toBe(400);
    const ok = await enterCode(first.body.ticket, code);
    expect(ok.status).toBe(200);
    expect((await api('GET', '/api/auth/me', undefined, ok.body.token)).body.user.username).toBe('admin');
    expect((await enterCode(first.body.ticket, code)).status).toBe(401); // used up

    // Five wrong codes end the attempt.
    const again = (await login('admin', 'correct horse battery')).body;
    for (let i = 0; i < 4; i++) await enterCode(again.ticket, wrong);
    expect((await enterCode(again.ticket, wrong)).body.error).toMatch(/Too many wrong codes/);
    expect((await enterCode(again.ticket, codeIn(smtp.mails.at(-1)!))).status).toBe(401);

    // Builders sign in with their password only while codes are for administrators.
    await api('POST', '/api/users', { username: 'bea', displayName: 'Bea', role: 'builder', password: 'a long password 1' });
    expect((await login('bea', 'a long password 1')).body.token).toMatch(/^afs_/);
  });

  it('turned on for everyone, people without an email address are told what to do', async () => {
    await api('PUT', '/api/settings/signin', settingsBody('everyone'));
    expect((await api('GET', '/api/settings/signin')).body.withoutEmail).toEqual(expect.arrayContaining([{ displayName: 'Bea', role: 'builder' }]));
    const denied = await login('bea', 'a long password 1');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/no email address/);
    expect((await login('bea', 'wrong password!!')).status).toBe(401); // the password is still checked first
  });
});

describe('database updates', () => {
  it('rebuilds the runs table without losing runs, their steps or files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoflow-migrate-'));
    const path = join(dir, 'old.db');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    MIGRATIONS.slice(0, 3).forEach((sql, i) => {
      raw.exec(sql);
      raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, 'then');
    });
    raw.exec(`
      INSERT INTO flows (id, name, created_at, updated_at) VALUES ('f', 'F', 'x', 'x');
      INSERT INTO jobs (id, flow_id, version, status, trigger, queued_at, repair_calls) VALUES ('j', 'f', 1, 'succeeded', 'manual', 'x', 2);
      INSERT INTO job_events (job_id, seq, ts, kind, data) VALUES ('j', 1, 1, 'log', '{}');
      INSERT INTO artifacts (id, job_id, kind, name, path, size, created_at) VALUES ('a', 'j', 'screenshot', 'n', 'p', 1, 'x');
    `);
    raw.close();

    const db = new Db(path);
    try {
      expect(db.migrate()).toBe(MIGRATIONS.length - 3);
      expect(db.get('SELECT trigger, repair_calls, chain_depth FROM jobs WHERE id = ?', 'j')).toEqual({ trigger: 'manual', repair_calls: 2, chain_depth: 0 });
      expect(db.all('SELECT * FROM job_events')).toHaveLength(1);
      expect(db.all('SELECT * FROM artifacts')).toHaveLength(1);
      db.run(`INSERT INTO jobs (id, flow_id, version, status, trigger, queued_at) VALUES ('k', 'f', 1, 'queued', 'event', 'x')`);
      // Deleting a run still removes its steps and files (the references survived the rebuild).
      db.run('DELETE FROM jobs WHERE id = ?', 'j');
      expect(db.all('SELECT * FROM job_events')).toHaveLength(0);
      expect(db.all('SELECT * FROM artifacts')).toHaveLength(0);
      expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('robot self-update', () => {
  it('offers the newest robot package, lets admins trigger it and notices a rollback', async () => {
    const asRobot = async (pool: string, name: string) => {
      const { key } = (await api('POST', '/api/robots/enrollment-keys', { pool, hours: 1 })).body;
      return (await app.inject({ method: 'POST', url: '/api/robot/enroll', payload: { key, name } })).json() as { token: string; robotId: string };
    };
    const robot = await asRobot('updates', 'Updating robot');
    const auth = { authorization: `Bearer ${robot.token}` };
    const check = async () => (await app.inject({ method: 'GET', url: '/api/robot/update', headers: auth })).json();

    expect(await check()).toEqual({ version: null, automatic: true });
    const installers = join(svc.config.dataDir, 'installers');
    const pkg = Buffer.from('robot package 0.10.0');
    writeFileSync(join(installers, 'Autoflow-Robot-0.9.0.zip'), 'older');
    writeFileSync(join(installers, 'Autoflow-Robot-0.10.0.zip'), pkg);
    writeFileSync(join(installers, 'Autoflow-Studio-Setup-0.10.0.exe'), 'studio');
    const copiedEarlier = (file: string) => utimesSync(join(installers, file), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    // A package that is still being copied in is not offered yet.
    expect(await check()).toEqual({ version: null, automatic: true });
    copiedEarlier('Autoflow-Robot-0.9.0.zip');
    expect((await check()).version).toBe('0.9.0');
    copiedEarlier('Autoflow-Robot-0.10.0.zip');
    expect(await check()).toEqual({
      version: '0.10.0',
      url: '/downloads/Autoflow-Robot-0.10.0.zip',
      size: pkg.length,
      sha256: createHash('sha256').update(pkg).digest('hex'),
      automatic: true,
    });
    expect((await app.inject({ method: 'GET', url: '/downloads/Autoflow-Robot-0.10.0.zip' })).body).toBe('robot package 0.10.0');
    expect((await app.inject({ method: 'GET', url: '/api/robot/update' })).statusCode).toBe(401);

    const messages: any[] = [];
    const ws = new WebSocket(`ws://${base}/api/robot/connect`, { headers: auth });
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'hello', version: '0.2.0', capabilities: [] }));
    const listed = async () => (await api('GET', '/api/robots')).body;
    await waitFor(async () => (await listed()).robots.find((r: any) => r.id === robot.robotId)?.version === '0.2.0');
    let list = await listed();
    expect(list).toMatchObject({ latestVersion: '0.10.0', automaticUpdates: true });
    expect(list.robots.find((r: any) => r.id === robot.robotId)).toMatchObject({ updateAvailable: true, updating: null, updateError: null });

    // "Update now" reaches the robot, which reports that it is installing.
    expect((await api('POST', `/api/robots/${robot.robotId}/update`, {})).body).toEqual({ ok: true, version: '0.10.0' });
    await waitFor(() => messages.some((m) => m.type === 'robot.update'));
    ws.send(JSON.stringify({ type: 'robot.updating', version: '0.10.0' }));
    await waitFor(async () => (await listed()).robots.find((r: any) => r.id === robot.robotId)?.updating === '0.10.0');

    // It comes back on the old version: the update was rolled back.
    ws.send(JSON.stringify({ type: 'hello', version: '0.2.0', capabilities: [] }));
    await waitFor(async () => !!(await listed()).robots.find((r: any) => r.id === robot.robotId)?.updateError);
    list = await listed();
    expect(list.robots.find((r: any) => r.id === robot.robotId)).toMatchObject({ updating: null });
    expect(list.robots.find((r: any) => r.id === robot.robotId).updateError).toContain('did not start');

    // A successful update shows up in the audit log.
    ws.send(JSON.stringify({ type: 'robot.updating', version: '0.10.0' }));
    ws.send(JSON.stringify({ type: 'hello', version: '0.10.0', capabilities: [] }));
    await waitFor(async () => (await listed()).robots.find((r: any) => r.id === robot.robotId)?.version === '0.10.0');
    expect((await listed()).robots.find((r: any) => r.id === robot.robotId)).toMatchObject({ updateAvailable: false, updateError: null });
    const audit = (await api('GET', '/api/audit')).body;
    expect(JSON.stringify(audit)).toContain('robot.version_changed');
    expect((await api('POST', `/api/robots/${robot.robotId}/update`, {})).status).toBe(409); // already newest

    // A newer package copied into Downloads is announced to connected robots right away.
    svc.gateway.checkRobotReleases();
    messages.length = 0;
    writeFileSync(join(installers, 'Autoflow-Robot-0.11.0.zip'), 'robot package 0.11.0');
    svc.gateway.checkRobotReleases();
    expect(messages).toEqual([]); // still being copied
    copiedEarlier('Autoflow-Robot-0.11.0.zip');
    svc.gateway.checkRobotReleases();
    await waitFor(() => messages.some((m) => m.type === 'robot.update'));
    expect(messages).toEqual([{ type: 'robot.update', force: false }]);

    expect((await api('PUT', '/api/settings/robot-updates', { automatic: false })).status).toBe(200);
    expect((await check()).automatic).toBe(false);
    ws.close();
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
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
