// Table VIII: response times, rate limit, test count/time and frontend bundle sizes.
// Usage: node scripts/benchmark.js [--skip-tests]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(here, '..');
const rootDir = path.join(backendDir, '..');
const N = 50;
const WARMUP = 10;

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function mockApp() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-bench-'));
  // Explicit env object: mock mode, no Gemini key (rules engine), no delays.
  const cfg = loadConfig({ MODE: 'mock', MOCK_DELAY_MS: '0' }, { stateDir });
  return createApp({ config: cfg, serveFrontend: false });
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function measure(base, name, doRequest) {
  for (let i = 0; i < WARMUP; i++) await (await doRequest(base)).arrayBuffer();
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const res = await doRequest(base);
    await res.arrayBuffer();
    times.push(performance.now() - t0);
    if (!res.ok) throw new Error(`${name} returned HTTP ${res.status}`);
  }
  times.sort((a, b) => a - b);
  return { endpoint: name, n: N, medianMs: +percentile(times, 50).toFixed(2), p95Ms: +percentile(times, 95).toFixed(2) };
}

const endpoints = [
  ['GET /health', (b) => fetch(`${b}/health`)],
  ['POST /command (rules)', (b) => fetch(`${b}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Deploy my website' }) })],
  ['GET /logs', (b) => fetch(`${b}/logs?since=0`)],
];

// 1) latency
const server = await listen(mockApp());
const base = `http://127.0.0.1:${server.address().port}/api`;
const latency = [];
for (const [name, fn] of endpoints) latency.push(await measure(base, name, fn));
server.close();

// Baseline: a bare Node HTTP server on the same machine (shows loopback/client overhead).
const bare = await new Promise((resolve) => {
  const s = http.createServer((req, res) => res.end('ok')).listen(0, '127.0.0.1', () => resolve(s));
});
const baseline = await measure(`http://127.0.0.1:${bare.address().port}`, 'bare Node HTTP (baseline)', (b) => fetch(b));
bare.close();

// 2) rate limit on a fresh app: 260 requests inside one minute window
const rlServer = await listen(mockApp());
const rlBase = `http://127.0.0.1:${rlServer.address().port}/api`;
const statuses = [];
for (let batch = 0; batch < 13; batch++) {
  const res = await Promise.all(Array.from({ length: 20 }, () => fetch(`${rlBase}/health`)));
  statuses.push(...res.map((r) => r.status));
}
rlServer.close();
const ok200 = statuses.filter((s) => s === 200).length;
const r429 = statuses.filter((s) => s === 429).length;
const rate = { sent: statuses.length, ok200, r429, first429At: statuses.indexOf(429) + 1 || null, enforced: ok200 === 240 && r429 === statuses.length - 240 };

// 3) tests
let tests = { measured: false };
if (!process.argv.includes('--skip-tests')) {
  const t0 = performance.now();
  const run = spawnSync(process.execPath, [path.join(here, 'test.js')], { cwd: backendDir, encoding: 'utf8' });
  const seconds = (performance.now() - t0) / 1000;
  const m = /Tests: (\d+)\/(\d+) passed/.exec(run.stdout || '');
  tests = m ? { measured: true, passed: Number(m[1]), total: Number(m[2]), seconds: +seconds.toFixed(2) } : { measured: false };
}

// 4) bundle sizes from the vite build output
const assetsDir = path.join(rootDir, 'frontend', 'dist', 'assets');
const bundle = {};
if (fs.existsSync(assetsDir)) {
  for (const ext of ['js', 'css']) {
    const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith(`.${ext}`));
    if (!files.length) continue;
    const bufs = files.map((f) => fs.readFileSync(path.join(assetsDir, f)));
    bundle[ext] = {
      rawKB: +(bufs.reduce((a, b) => a + b.length, 0) / 1000).toFixed(2),
      gzipKB: +(bufs.reduce((a, b) => a + zlib.gzipSync(b).length, 0) / 1000).toFixed(2),
    };
  }
}

const nm = 'not measured';
console.log('Table VIII — performance (mock mode, loopback, sequential requests)\n');
console.log(`${'Measurement'.padEnd(40)}Value`);
console.log('-'.repeat(72));
for (const l of [...latency, baseline]) console.log(`${`${l.endpoint} median / p95`.padEnd(40)}${l.medianMs} ms / ${l.p95Ms} ms  (n=${l.n})`);
console.log(`${'Rate limit (240/min)'.padEnd(40)}${rate.sent} sent: ${rate.ok200} x 200, ${rate.r429} x 429 (first 429 at #${rate.first429At}) — ${rate.enforced ? 'enforced' : 'NOT as expected'}`);
console.log(`${'Automated tests'.padEnd(40)}${tests.measured ? `${tests.passed}/${tests.total} passed in ${tests.seconds} s` : nm}`);
console.log(`${'Frontend JS bundle (raw / gzip)'.padEnd(40)}${bundle.js ? `${bundle.js.rawKB} kB / ${bundle.js.gzipKB} kB` : `${nm} (run vite build first)`}`);
console.log(`${'Frontend CSS bundle (raw / gzip)'.padEnd(40)}${bundle.css ? `${bundle.css.rawKB} kB / ${bundle.css.gzipKB} kB` : `${nm} (run vite build first)`}`);
console.log(`${'Real AWS launch / deploy time'.padEnd(40)}${nm} (needs a live AWS run)`);
console.log(`\nMachine: ${os.cpus()[0]?.model || 'unknown CPU'}, Node ${process.version}, ${os.platform()}`);

const outDir = path.join(backendDir, 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'benchmark.json'), JSON.stringify({ latency, baseline, rate, tests, bundle, node: process.version, platform: os.platform() }, null, 2));
process.exit(0);
