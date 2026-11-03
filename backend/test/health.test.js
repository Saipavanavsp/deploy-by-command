// Area: Health and routing (2 tests)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp } from './helpers.js';

test('[Health and routing] GET /health reports ok in mock mode', async () => {
  const app = makeApp();
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.mode, 'mock');
  assert.equal(res.body.simulated, true);
  assert.equal(res.body.engine, 'rules');
});

test('[Health and routing] every route works with and without the /api prefix', async () => {
  const app = makeApp();
  for (const prefix of ['', '/api']) {
    const h = await request(app).get(`${prefix}/health`);
    assert.equal(h.status, 200, `${prefix}/health`);
    const c = await request(app).post(`${prefix}/command`).send({ text: 'what is the status?' });
    assert.equal(c.status, 200, `${prefix}/command`);
    assert.equal(c.body.intent, 'STATUS');
    const l = await request(app).get(`${prefix}/logs?since=0`);
    assert.equal(l.status, 200, `${prefix}/logs`);
    assert.ok(Array.isArray(l.body.logs));
    const s = await request(app).get(`${prefix}/state`);
    assert.equal(s.status, 200, `${prefix}/state`);
    assert.equal(s.body.mode, 'mock');
    // operation routes exist under both prefixes (refused by preconditions, not 404)
    const st = await request(app).get(`${prefix}/status`);
    assert.equal(st.status, 409, `${prefix}/status`);
    assert.equal(st.body.error.code, 'NO_INSTANCE');
  }
  const missing = await request(app).get('/api/does-not-exist');
  assert.equal(missing.status, 404);
});
