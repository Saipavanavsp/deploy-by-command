// Source-line counts (non-blank lines) for backend, frontend, tests and sample-app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'dist', 'state', 'keys', 'results']);

function walk(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p, exts);
    return exts.some((x) => e.name.endsWith(x)) ? [p] : [];
  });
}

const count = (files) => files.reduce((n, f) => n + fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length, 0);

const areas = [
  ['Backend (src)', walk(path.join(root, 'backend', 'src'), ['.js'])],
  ['Backend scripts', walk(path.join(root, 'backend', 'scripts'), ['.js', '.py'])],
  ['Frontend (src)', walk(path.join(root, 'frontend', 'src'), ['.js', '.jsx', '.css'])],
  ['Tests', walk(path.join(root, 'backend', 'test'), ['.js'])],
  ['Sample app', walk(path.join(root, 'sample-app'), ['.js', '.html', 'Dockerfile'])],
];

console.log(`${'Area'.padEnd(20)}${'Files'.padStart(6)}${'Lines'.padStart(8)}`);
let total = 0;
for (const [name, files] of areas) {
  const n = count(files);
  total += n;
  console.log(`${name.padEnd(20)}${String(files.length).padStart(6)}${String(n).padStart(8)}`);
}
console.log(`${'Total'.padEnd(26)}${String(total).padStart(8)}`);
