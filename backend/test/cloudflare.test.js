// Area: Cloudflare route (7 tests). Wrangler and fetch are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createCloudflarePublisher, extractPagesUrl } from '../src/cloudflare.js';
import { createLogger } from '../src/logger.js';
import { secretsOf } from '../src/config.js';
import { FAKE_CF_TOKEN, allLogs, makeApp, makeConfig, stubFetch, waitIdle } from './helpers.js';

const CF_ENV = { CLOUDFLARE_API_TOKEN: FAKE_CF_TOKEN, CLOUDFLARE_ACCOUNT_ID: 'acct1234567890', CF_PROJECT_NAME: 'deploy-by-command' };
const DEPLOY_OUTPUT = [
  '⛅️ wrangler 4.x',
  'See https://developers.cloudflare.com/pages/ for docs.',
  'Dashboard: https://dash.cloudflare.com/acct/pages/view/deploy-by-command',
  '✨ Success! Uploaded 1 files (0.42 sec)',
  '🌎 Deploying...',
  '✨ Deployment complete! Take a peek over at https://a1b2c3d4.deploy-by-command.pages.dev',
].join('\n');

function wranglerStub(deployResult = { code: 0, stdout: DEPLOY_OUTPUT, stderr: '' }) {
  const calls = [];
  const fn = async (args, opts) => {
    calls.push({ args, env: opts.env });
    if (args[1] === 'project') return { code: 1, stdout: '', stderr: 'A project with this name already exists [code: 8000002]' };
    return deployResult;
  };
  fn.calls = calls;
  return fn;
}

function publisher({ fetch, runWrangler, env = CF_ENV }) {
  const cfg = makeConfig(env);
  const log = createLogger({ secrets: () => secretsOf(cfg) });
  return { pub: createCloudflarePublisher({ cfg, log, fetch, runWrangler, sleep: async () => {} }), log };
}

test('[Cloudflare route] missing credentials give a clear plain-English error', async () => {
  const app = makeApp();
  const res = await request(app).post('/api/cloudflare').send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'CLOUDFLARE_NOT_CONFIGURED');
  assert.match(res.body.error.message, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are missing/);
  assert.match(res.body.error.message, /\.env/);
  const onlyToken = makeApp({ env: { CLOUDFLARE_API_TOKEN: FAKE_CF_TOKEN } });
  const r2 = await request(onlyToken).post('/api/cloudflare').send({});
  assert.match(r2.body.error.message, /CLOUDFLARE_ACCOUNT_ID is missing/);
  assert.ok(!JSON.stringify(r2.body).includes(FAKE_CF_TOKEN));
});

test('[Cloudflare route] the correct project URL is chosen from Wrangler output', () => {
  assert.equal(extractPagesUrl(DEPLOY_OUTPUT, 'deploy-by-command'), 'https://a1b2c3d4.deploy-by-command.pages.dev');
  const withProd = `${DEPLOY_OUTPUT}\nProduction: https://deploy-by-command.pages.dev\nOther: https://other-site.pages.dev`;
  assert.equal(extractPagesUrl(withProd, 'deploy-by-command'), 'https://deploy-by-command.pages.dev');
  assert.equal(extractPagesUrl('see https://other-site.pages.dev and https://developers.cloudflare.com', 'deploy-by-command'), null);
});

test('[Cloudflare route] reported as verified only after HTTP 200', async () => {
  const fetch = stubFetch([{ status: 200, body: '<html>ok</html>' }]);
  const wr = wranglerStub();
  const { pub } = publisher({ fetch, runWrangler: wr });
  const r = await pub.publish();
  assert.equal(r.verified, true);
  assert.equal(r.url, 'https://a1b2c3d4.deploy-by-command.pages.dev');
  assert.equal(fetch.calls[0].url, r.url);
  assert.match(r.message, /verified/);
  assert.deepEqual(wr.calls[1].args.slice(0, 5), ['pages', 'deploy', 'sample-app/public', '--project-name', 'deploy-by-command']);
  assert.equal(wr.calls[1].env.CLOUDFLARE_API_TOKEN, FAKE_CF_TOKEN, 'token passed to wrangler via env only');
});

test('[Cloudflare route] a non-200 answer is reported as uploaded but not verified', async () => {
  const fetch = stubFetch([{ status: 404, body: 'not found' }]);
  const { pub } = publisher({ fetch, runWrangler: wranglerStub() });
  const r = await pub.publish();
  assert.equal(r.verified, false);
  assert.match(r.message, /Files were uploaded but could not be verified/);
  assert.match(r.message, /HTTP 404/);
  assert.equal(fetch.calls.length, 2, 'retried verifyAttempts times');
});

test('[Cloudflare route] an unreachable URL is reported, never as success', async () => {
  const fetch = stubFetch([new Error('getaddrinfo ENOTFOUND a1b2c3d4.deploy-by-command.pages.dev')]);
  const { pub } = publisher({ fetch, runWrangler: wranglerStub() });
  const r = await pub.publish();
  assert.equal(r.verified, false);
  assert.match(r.message, /could not be reached/);
});

test('[Cloudflare route] Wrangler errors are plain English and the token is redacted', async () => {
  const failing = wranglerStub({ code: 1, stdout: '', stderr: `✘ [ERROR] Authentication error [code: 10000] using token ${FAKE_CF_TOKEN}` });
  const { pub, log } = publisher({ fetch: stubFetch([{ status: 200 }]), runWrangler: failing });
  await assert.rejects(pub.publish(), (err) => {
    assert.equal(err.code, 'CLOUDFLARE_FAILED');
    assert.match(err.message, /Wrangler could not upload the site/);
    assert.match(err.message, /Authentication error/);
    assert.ok(!err.message.includes(FAKE_CF_TOKEN));
    return true;
  });
  assert.ok(!JSON.stringify(log.all()).includes(FAKE_CF_TOKEN));

  const noUrl = wranglerStub({ code: 0, stdout: 'Done. See https://developers.cloudflare.com', stderr: '' });
  const { pub: p2 } = publisher({ fetch: stubFetch([{ status: 200 }]), runWrangler: noUrl });
  await assert.rejects(p2.publish(), /printed no pages\.dev URL/);
});

test('[Cloudflare route] POST /cloudflare runs in the background and records the verified result without leaking the token', async () => {
  const app = makeApp({ env: CF_ENV, fetch: stubFetch([{ status: 200 }]), runWrangler: wranglerStub() });
  const res = await request(app).post('/api/cloudflare').send({});
  assert.equal(res.status, 202);
  const state = await waitIdle(app);
  assert.equal(state.cloudflare.verified, true);
  assert.equal(state.cloudflare.url, 'https://a1b2c3d4.deploy-by-command.pages.dev');
  assert.equal(state.lastResult.ok, true);
  assert.equal(state.config.cloudflareConfigured, true);
  const everything = JSON.stringify(state) + JSON.stringify(await allLogs(app));
  assert.ok(!everything.includes(FAKE_CF_TOKEN));
  assert.ok(!everything.includes('acct1234567890'));
});
