// Shared test helpers: temp state dir, app factory, stubbed fetch, wait-for-idle over HTTP.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

export const FAKE_GEMINI_KEY = 'AIzaFAKE-test-key-0123456789abcdefghijklmn';
export const FAKE_CF_TOKEN = 'cf-test-token-SECRET-9f8e7d6c5b4a';

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-test-'));
}

export function makeConfig(env = {}, overrides = {}) {
  const stateDir = overrides.stateDir || tempDir();
  return loadConfig(
    { MODE: 'mock', MOCK_DELAY_MS: '1', ...env },
    {
      stateDir,
      keysDir: path.join(stateDir, 'keys'),
      gemini: { retryDelayMs: 5, timeoutMs: 2000 },
      cloudflare: { verifyAttempts: 2, verifyDelayMs: 1 },
      ...overrides,
    },
  );
}

export function makeApp({ env, overrides, ...opts } = {}) {
  const config = opts.config || makeConfig(env, overrides);
  return createApp({ config, serveFrontend: false, ...opts });
}

// Polls GET /state until the one-job lock is released.
export async function waitIdle(app, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await request(app).get('/api/state');
    if (!res.body.busy) return res.body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('operation did not finish in time');
}

// fetch stub: each call consumes the next scripted response (last one repeats).
export function stubFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

export const geminiReply = (obj) => ({
  status: 200,
  body: { choices: [{ index: 0, message: { role: 'assistant', content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] },
});

export async function allLogs(app) {
  const res = await request(app).get('/api/logs?since=0');
  return res.body.logs;
}
