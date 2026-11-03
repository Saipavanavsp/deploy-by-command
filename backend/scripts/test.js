// Runs the 29-test suite with node:test, prints a per-area table and an N/N summary,
// and writes results/tests.json (used by benchmark.js and plot.py).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(here, '..', 'test');
const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(testDir, f));

const areas = new Map();
let pass = 0;
let fail = 0;
const started = performance.now();

const stream = run({ files, concurrency: true });
const record = (ok) => (data) => {
  if (data.nesting !== 0 || data.details?.type === 'suite') return;
  const area = /^\[([^\]]+)\]/.exec(data.name)?.[1] || 'Other';
  const a = areas.get(area) || { passed: 0, failed: 0 };
  if (ok) { a.passed++; pass++; } else { a.failed++; fail++; }
  areas.set(area, a);
};
stream.on('test:pass', record(true));
stream.on('test:fail', record(false));
stream.compose(spec).pipe(process.stdout);

// Table III order.
const AREA_ORDER = ['Health and routing', 'Rule classifier', 'Gemini handling', 'Validation and refusal', 'Workflow and ordering', 'Configuration and safety', 'Cloudflare route'];

stream.on('end', () => {
  const seconds = (performance.now() - started) / 1000;
  const total = pass + fail;
  const rank = (a) => (AREA_ORDER.indexOf(a) + 1 || 99);
  const sorted = [...areas.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  areas.clear();
  for (const [k, v] of sorted) areas.set(k, v);
  console.log('\nTable III — tests by area');
  console.log('Area'.padEnd(28) + 'Passed'.padStart(8) + 'Total'.padStart(8));
  for (const [area, a] of areas) console.log(area.padEnd(28) + String(a.passed).padStart(8) + String(a.passed + a.failed).padStart(8));
  console.log(`\nTests: ${pass}/${total} passed (${fail} failed) in ${seconds.toFixed(2)} s`);
  const outDir = path.join(here, '..', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'tests.json'), JSON.stringify({ passed: pass, failed: fail, total, seconds, areas: Object.fromEntries(areas) }, null, 2));
  process.exitCode = fail === 0 && total > 0 ? 0 : 1;
});
