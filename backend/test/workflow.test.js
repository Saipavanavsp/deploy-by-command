// Area: Workflow and ordering (6 tests)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { allLogs, makeApp, makeConfig, waitIdle } from './helpers.js';
import { createMockProvider } from '../src/providers/mock.js';

test('[Workflow and ordering] prerequisites are enforced', async () => {
  const app = makeApp();
  for (const [method, path, code] of [
    ['post', '/api/configure', 'NO_INSTANCE'],
    ['post', '/api/deploy', 'NO_INSTANCE'],
    ['post', '/api/restart', 'NO_INSTANCE'],
    ['get', '/api/status', 'NO_INSTANCE'],
  ]) {
    const res = await request(app)[method](path).send(method === 'post' ? {} : undefined);
    assert.equal(res.status, 409, path);
    assert.equal(res.body.error.code, code, path);
  }
  assert.equal((await request(app).post('/api/launch').send({})).status, 202);
  await waitIdle(app);
  const deploy = await request(app).post('/api/deploy').send({});
  assert.equal(deploy.status, 409);
  assert.equal(deploy.body.error.code, 'NOT_CONFIGURED');
  const restart = await request(app).post('/api/restart').send({});
  assert.equal(restart.body.error.code, 'NOT_DEPLOYED');
  const second = await request(app).post('/api/launch').send({});
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'ALREADY_TRACKED');
});

test('[Workflow and ordering] full workflow launches, configures and deploys (simulated)', async () => {
  const app = makeApp();
  const res = await request(app).post('/api/full').send({});
  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, true);
  const state = await waitIdle(app);
  assert.deepEqual(state.steps, { launch: 'done', configure: 'done', deploy: 'done' });
  assert.match(state.infra.instanceId, /^i-0sim/);
  assert.match(state.infra.publicIp, /^198\.51\.100\.\d+$/);
  assert.equal(state.dockerReady, true);
  assert.equal(state.deployment.url, `http://${state.infra.publicIp}`);
  assert.equal(state.lastResult.ok, true);
  assert.match(state.lastResult.message, /Simulated deployment complete/);
  assert.match(state.lastResult.message, /not a real/);
  const logs = await allLogs(app);
  assert.ok(logs.some((l) => l.msg.startsWith('[SIMULATED]')));
  assert.ok(logs.every((l) => /^\d{4}-\d\d-\d\dT/.test(l.ts) && ['INFO', 'WARN', 'ERROR'].includes(l.level)));
  // status and restart work once deployed
  assert.equal((await request(app).get('/api/status')).status, 202);
  const afterStatus = await waitIdle(app);
  assert.equal(afterStatus.lastResult.ok, true);
  assert.equal(afterStatus.lastStatus.checks.length, 3);
  assert.equal((await request(app).post('/api/restart').send({})).status, 202);
  assert.equal((await waitIdle(app)).lastResult.ok, true);
});

test('[Workflow and ordering] only one operation runs at a time (409 BUSY)', async () => {
  const app = makeApp({ env: { MOCK_DELAY_MS: '150' } });
  const first = await request(app).post('/api/full').send({});
  assert.equal(first.status, 202);
  const second = await request(app).post('/api/launch').send({});
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'BUSY');
  const third = await request(app).post('/api/full').send({});
  assert.equal(third.body.error.code, 'BUSY');
  const state = await waitIdle(app, 10000);
  assert.equal(state.steps.deploy, 'done');
});

test('[Workflow and ordering] FULL_DEPLOY skips steps that are already finished', async () => {
  const app = makeApp();
  await request(app).post('/api/full').send({});
  const first = await waitIdle(app);
  await request(app).post('/api/full').send({});
  const second = await waitIdle(app);
  assert.equal(second.infra.instanceId, first.infra.instanceId, 'no second server');
  const msgs = (await allLogs(app)).map((l) => l.msg);
  assert.ok(msgs.some((m) => /skip launch/.test(m)));
  assert.ok(msgs.some((m) => /skip configure/.test(m)));
  assert.equal(msgs.filter((m) => m === 'Step launch: running').length, 1);
  assert.equal(second.steps.deploy, 'done');
});

test('[Workflow and ordering] Terminate needs typed confirmation and is unreachable from command text', async () => {
  const app = makeApp();
  await request(app).post('/api/launch').send({});
  const launched = await waitIdle(app);
  for (const body of [{}, { confirm: 'yes' }, { confirm: 'terminate please' }]) {
    const res = await request(app).post('/api/terminate').send(body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'CONFIRMATION_REQUIRED');
  }
  const viaText = await request(app).post('/api/command').send({ text: 'terminate my instance' });
  assert.equal(viaText.body.intent, 'UNKNOWN');
  assert.equal((await request(app).get('/api/state')).body.infra.instanceId, launched.infra.instanceId);

  const ok = await request(app).post('/api/terminate').send({ confirm: launched.infra.instanceId });
  assert.equal(ok.status, 202);
  const after = await waitIdle(app);
  assert.equal(after.infra, null);
  assert.deepEqual(after.steps, { launch: 'pending', configure: 'pending', deploy: 'pending' });

  await request(app).post('/api/launch').send({});
  await waitIdle(app);
  assert.equal((await request(app).post('/api/terminate').send({ confirm: 'TERMINATE' })).status, 202);
  assert.equal((await waitIdle(app)).infra, null);
});

test('[Workflow and ordering] a failing provider is never reported as success', async () => {
  const config = makeConfig();
  const mock = createMockProvider({ cfg: config });
  const provider = { ...mock, deploy: async () => { throw new Error('disk full on server'); } };
  const app = makeApp({ config, provider });
  await request(app).post('/api/full').send({});
  const state = await waitIdle(app);
  assert.equal(state.steps.launch, 'done');
  assert.equal(state.steps.configure, 'done');
  assert.equal(state.steps.deploy, 'failed');
  assert.equal(state.deployment, null);
  assert.equal(state.lastResult.ok, false);
  assert.match(state.lastError.message, /disk full/);
  assert.equal(state.lastOp.status, 'failed');
  const msgs = await allLogs(app);
  assert.ok(msgs.some((l) => l.level === 'ERROR' && /disk full/.test(l.msg)));
  assert.ok(!msgs.some((l) => /deployment complete/i.test(l.msg)));

  // Injected failure through MOCK_FAIL_STEP behaves the same way.
  const app2 = makeApp({ env: { MOCK_FAIL_STEP: 'configure' } });
  await request(app2).post('/api/full').send({});
  const s2 = await waitIdle(app2);
  assert.equal(s2.steps.configure, 'failed');
  assert.equal(s2.steps.deploy, 'pending');
  assert.equal(s2.dockerReady, false);
  assert.match(s2.lastError.message, /MOCK_FAIL_STEP=configure/);
});
