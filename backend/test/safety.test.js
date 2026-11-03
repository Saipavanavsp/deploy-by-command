// Area: Configuration and safety (4 tests)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { loadConfig, validateSshCidr } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createMockProvider } from '../src/providers/mock.js';
import { FAKE_GEMINI_KEY, allLogs, makeApp, makeConfig, tempDir, waitIdle } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('[Configuration and safety] real mode is refused without the second lock', () => {
  const dir = tempDir();
  assert.throws(
    () => createApp({ config: loadConfig({ MODE: 'aws', ALLOW_REAL_AWS: 'no' }, { stateDir: dir }), serveFrontend: false }),
    (err) => err.code === 'REAL_MODE_LOCKED' && /ALLOW_REAL_AWS/.test(err.message),
  );
  assert.throws(() => createApp({ config: loadConfig({ MODE: 'aws' }, { stateDir: dir }), serveFrontend: false }), /REAL_MODE_LOCKED|both locks/);
  // The real server entry point refuses to start too.
  const run = spawnSync(process.execPath, [path.join(here, '..', 'src', 'server.js')], {
    env: { ...process.env, MODE: 'aws', ALLOW_REAL_AWS: 'no', ENV_FILE: path.join(dir, 'missing.env'), PORT: '0' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /REFUSING TO START/);
});

test('[Configuration and safety] SSH_CIDR 0.0.0.0/0 is rejected', () => {
  assert.throws(() => loadConfig({ MODE: 'mock', SSH_CIDR: '0.0.0.0/0' }), (e) => e.code === 'UNSAFE_SSH_CIDR');
  assert.throws(() => validateSshCidr('0.0.0.0/0'), (e) => e.code === 'UNSAFE_SSH_CIDR');
  assert.throws(() => validateSshCidr('10.0.0.0/0'), (e) => e.code === 'UNSAFE_SSH_CIDR');
  assert.throws(() => validateSshCidr('not-a-cidr'), (e) => e.code === 'INVALID_SSH_CIDR');
  assert.equal(validateSshCidr('203.0.113.7/32'), '203.0.113.7/32');
  assert.equal(validateSshCidr(''), ''); // empty = auto-detect my IP /32
});

test('[Configuration and safety] the private key path and secrets never reach the browser', async () => {
  const config = makeConfig({ GEMINI_API_KEY: FAKE_GEMINI_KEY });
  const keyPath = path.join(config.keysDir, 'deploy-by-command-123.pem');
  const mock = createMockProvider({ cfg: config });
  const provider = {
    ...mock,
    async launch(ctx) {
      ctx.track({ keyName: 'deploy-by-command-123', keyPath });
      const r = await mock.launch(ctx);
      return { ...r, keyName: 'deploy-by-command-123', keyPath };
    },
  };
  const app = makeApp({ config, provider, fetch: async () => { throw new Error('offline'); } });
  await request(app).post('/api/launch').send({});
  await waitIdle(app);
  const raw = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'state-mock.json'), 'utf8'));
  assert.equal(raw.infra.keyPath, keyPath, 'the key path is kept on disk');
  const responses = [
    await request(app).get('/api/state'),
    await request(app).get('/api/health'),
    await request(app).get('/api/logs?since=0'),
    await request(app).post('/api/command').send({ text: 'what is the status?' }),
  ];
  for (const res of responses) {
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('.pem'), `key path leaked by ${res.req.path}`);
    assert.ok(!text.includes('keyPath'), `keyPath field leaked by ${res.req.path}`);
    assert.ok(!text.includes(FAKE_GEMINI_KEY), `Gemini key leaked by ${res.req.path}`);
  }
  assert.ok(!JSON.stringify(await allLogs(app)).includes(keyPath));
});

test('[Configuration and safety] state is kept per mode; simulated state never loads in real mode', async () => {
  const dir = tempDir();
  const mockApp = makeApp({ config: makeConfig({}, { stateDir: dir }) });
  await request(mockApp).post('/api/launch').send({});
  const mockState = await waitIdle(mockApp);
  assert.ok(fs.existsSync(path.join(dir, 'state-mock.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'state-aws.json')));

  const awsConfig = makeConfig({ MODE: 'aws', ALLOW_REAL_AWS: 'yes' }, { stateDir: dir });
  const stub = createMockProvider({ cfg: awsConfig }); // never touches AWS
  const awsApp = makeApp({ config: awsConfig, provider: stub });
  const awsState = (await request(awsApp).get('/api/state')).body;
  assert.equal(awsState.mode, 'aws');
  assert.equal(awsState.infra, null, 'simulated infra must not appear in real mode');

  // Even if simulated infra is copied into the real-mode file, it is ignored.
  const copied = JSON.parse(fs.readFileSync(path.join(dir, 'state-mock.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'state-aws.json'), JSON.stringify({ ...copied, mode: 'aws' }));
  const awsApp2 = makeApp({ config: awsConfig, provider: stub });
  assert.equal((await request(awsApp2).get('/api/state')).body.infra, null);
  fs.writeFileSync(path.join(dir, 'state-aws.json'), JSON.stringify(copied)); // mode: mock
  const awsApp3 = makeApp({ config: awsConfig, provider: stub });
  assert.equal((await request(awsApp3).get('/api/state')).body.infra, null);

  // Mock mode still sees its own server after a restart.
  const mockAgain = makeApp({ config: makeConfig({}, { stateDir: dir }) });
  assert.equal((await request(mockAgain).get('/api/state')).body.infra.instanceId, mockState.infra.instanceId);
});
