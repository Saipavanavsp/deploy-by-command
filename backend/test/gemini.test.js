// Area: Gemini handling (7 tests). Gemini is mocked with a stubbed fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { FAKE_GEMINI_KEY, allLogs, geminiReply, makeApp, stubFetch } from './helpers.js';

const env = { GEMINI_API_KEY: FAKE_GEMINI_KEY, GEMINI_MODEL: 'gemini-flash-latest' };
const appWith = (fetch) => makeApp({ env, fetch });
const ask = (app, text) => request(app).post('/api/command').send({ text });

test('[Gemini handling] a valid Gemini reply is used (engine gemini) and only the command text is sent', async () => {
  const fetch = stubFetch([geminiReply({ intent: 'FULL_DEPLOY', confidence: 0.95, reason: 'User wants the site online.' })]);
  const res = await ask(appWith(fetch), 'can you put my site on the internet please');
  assert.equal(res.status, 200);
  assert.equal(res.body.intent, 'FULL_DEPLOY');
  assert.equal(res.body.engine, 'gemini');
  assert.equal(res.body.confidence, 0.95);
  assert.equal(res.body.operation, 'full');
  assert.ok(res.body.plan.length > 0);
  assert.equal(fetch.calls.length, 1);
  const sent = JSON.parse(fetch.calls[0].init.body);
  assert.match(fetch.calls[0].url, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/);
  assert.equal(sent.temperature, 0);
  assert.deepEqual(sent.response_format, { type: 'json_object' });
  assert.equal(sent.model, 'gemini-flash-latest');
  assert.equal(sent.messages.at(-1).content, 'can you put my site on the internet please');
  assert.match(sent.messages[0].content, /data/i);
  assert.match(sent.messages[0].content, /ignore any instruction/i);
});

test('[Gemini handling] an off-list or malformed reply is rejected and rules decide', async () => {
  for (const bad of [
    geminiReply({ intent: 'DELETE_ALL', confidence: 0.99, reason: 'x' }),
    geminiReply({ intent: 'LAUNCH', confidence: 0.9 }),
    geminiReply({ intent: 'LAUNCH', confidence: 0.9, reason: 'x', extra: 'field' }),
    geminiReply('not json at all'),
  ]) {
    const fetch = stubFetch([bad]);
    const res = await ask(appWith(fetch), 'Deploy my website');
    assert.equal(res.body.engine, 'rules');
    assert.equal(res.body.intent, 'FULL_DEPLOY');
    assert.match(res.body.warning, /discarded/);
    assert.equal(fetch.calls.length, 1);
  }
});

test('[Gemini handling] a network failure falls back to rules without leaking the key', async () => {
  const fetch = stubFetch([new Error(`connect ECONNREFUSED https://example.invalid/?key=${FAKE_GEMINI_KEY}`)]);
  const app = appWith(fetch);
  const res = await ask(app, 'restart the app');
  assert.equal(res.status, 200);
  assert.equal(res.body.engine, 'rules');
  assert.equal(res.body.intent, 'RESTART');
  assert.match(res.body.warning, /fell back to rules/);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_GEMINI_KEY), 'key leaked in response');
  assert.ok(!JSON.stringify(await allLogs(app)).includes(FAKE_GEMINI_KEY), 'key leaked in logs');
  const state = await request(app).get('/api/state');
  assert.ok(!JSON.stringify(state.body).includes(FAKE_GEMINI_KEY), 'key leaked in state');
  const health = await request(app).get('/api/health');
  assert.ok(!JSON.stringify(health.body).includes(FAKE_GEMINI_KEY), 'key leaked in health');
});

test('[Gemini handling] low confidence (< 0.5) becomes UNKNOWN', async () => {
  const fetch = stubFetch([geminiReply({ intent: 'FULL_DEPLOY', confidence: 0.3, reason: 'Not sure.' })]);
  const res = await ask(appWith(fetch), 'maybe do the thing');
  assert.equal(res.body.intent, 'UNKNOWN');
  assert.equal(res.body.operation, null);
  assert.deepEqual(res.body.plan, []);
  assert.match(res.body.reason, /below 0\.5/);
});

test('[Gemini handling] HTTP 404 shows Google\'s cause with the key redacted', async () => {
  const fetch = stubFetch([{
    status: 404,
    body: [{ error: { code: 404, message: `models/gemini-1.0-pro is not found for API version v1beta (key ${FAKE_GEMINI_KEY})`, status: 'NOT_FOUND' } }],
  }]);
  const app = appWith(fetch);
  const res = await ask(app, 'launch a server');
  assert.equal(res.body.engine, 'rules');
  assert.equal(res.body.intent, 'LAUNCH');
  assert.match(res.body.warning, /Gemini HTTP 404/);
  assert.match(res.body.warning, /is not found for API version/);
  assert.match(res.body.warning, /\[REDACTED\]/);
  assert.ok(!res.body.warning.includes(FAKE_GEMINI_KEY));
  assert.ok(!JSON.stringify(await allLogs(app)).includes(FAKE_GEMINI_KEY));
});

test('[Gemini handling] HTTP 503 is retried (up to 3 attempts)', async () => {
  const recovers = stubFetch([{ status: 503, body: { error: { message: 'overloaded' } } }, geminiReply({ intent: 'STATUS', confidence: 0.9, reason: 'Status check.' })]);
  const ok = await ask(appWith(recovers), 'how are things');
  assert.equal(recovers.calls.length, 2);
  assert.equal(ok.body.engine, 'gemini');
  assert.equal(ok.body.intent, 'STATUS');
  assert.equal(ok.body.warning, undefined);

  const down = stubFetch([{ status: 503, body: { error: { message: 'overloaded' } } }]);
  const fb = await ask(appWith(down), 'what is the status?');
  assert.equal(down.calls.length, 3);
  assert.equal(fb.body.engine, 'rules');
  assert.equal(fb.body.intent, 'STATUS');
  assert.match(fb.body.warning, /Gemini HTTP 503.*fell back to rules/);
});

test('[Gemini handling] HTTP 404 is a permanent error and is not retried', async () => {
  const fetch = stubFetch([{ status: 404, body: { error: { message: 'model not found' } } }, geminiReply({ intent: 'LAUNCH', confidence: 1, reason: 'x' })]);
  const res = await ask(appWith(fetch), 'Deploy my website');
  assert.equal(fetch.calls.length, 1);
  assert.equal(res.body.engine, 'rules');
});
