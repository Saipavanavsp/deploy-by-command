// Area: Validation and refusal (2 tests)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { allLogs, makeApp } from './helpers.js';

test('[Validation and refusal] empty, too-long and malformed input is rejected', async () => {
  const app = makeApp();
  const cases = [
    {},
    { text: '' },
    { text: '    ' },
    { text: 'a'.repeat(301) },
    { text: 123 },
    { text: 'Deploy my website', extra: true },
  ];
  for (const body of cases) {
    const res = await request(app).post('/api/command').send(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(res.body.error.code, 'INVALID_INPUT');
    assert.equal(typeof res.body.error.message, 'string');
  }
  const ok300 = await request(app).post('/api/command').send({ text: `${'a'.repeat(299)}?` });
  assert.equal(ok300.status, 200);

  const malformed = await request(app).post('/api/command').set('content-type', 'application/json').send('{"text": ');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'INVALID_INPUT');

  const huge = await request(app).post('/api/command').send({ text: 'x', pad: 'y'.repeat(11 * 1024) });
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error.code, 'PAYLOAD_TOO_LARGE');

  const badTerminate = await request(app).post('/api/launch').send({ anything: 1 });
  assert.equal(badTerminate.status, 400);
});

test('[Validation and refusal] an unsupported command runs nothing', async () => {
  const app = makeApp();
  for (const text of ['delete everything', 'what is the weather', 'can you put my site on the internet please']) {
    const res = await request(app).post('/api/command').send({ text });
    assert.equal(res.status, 200);
    assert.equal(res.body.intent, 'UNKNOWN');
    assert.equal(res.body.operation, null);
    assert.deepEqual(res.body.plan, []);
    assert.ok(res.body.reason.length > 0, 'cause is shown');
    assert.ok(Array.isArray(res.body.supported) && res.body.supported.length === 6);
  }
  const free = await request(app).post('/api/command').send({ text: 'can you put my site on the internet please' });
  assert.equal(free.body.confidence, 0.2);
  const state = await request(app).get('/api/state');
  assert.equal(state.body.busy, false);
  assert.equal(state.body.lastOp, null);
  assert.equal(state.body.infra, null);
  assert.deepEqual(state.body.steps, { launch: 'pending', configure: 'pending', deploy: 'pending' });
  const logs = await allLogs(app);
  assert.ok(!logs.some((l) => /Operation .* started/.test(l.msg)), 'no operation started');
});
