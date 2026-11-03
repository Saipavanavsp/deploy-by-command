// Table V: live Gemini observation. Needs GEMINI_API_KEY; says so honestly if missing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { interpretCommand } from '../src/interpreter/gemini.js';
import { FREE_FORM_COMMAND } from './reference-commands.js';

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv();
const cfg = loadConfig({ ...process.env, MODE: 'mock' });

if (!cfg.gemini.apiKey) {
  console.log('Table V — live Gemini observation: not measured.');
  console.log('GEMINI_API_KEY is not set, so Gemini was not called. Set it in .env (or Colab Secrets) and run again.');
  process.exit(0);
}

const commands = ['Deploy my website', 'Deploy my website', FREE_FORM_COMMAND];
const rows = [];
for (const command of commands) {
  const t0 = performance.now();
  const r = await interpretCommand(command, cfg);
  rows.push({ command, intent: r.intent, engine: r.engine, confidence: r.confidence, ms: Math.round(performance.now() - t0), warning: r.warning || '' });
}

const w = [46, 13, 8, 11, 8];
const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join(' ');
console.log(`Table V — live Gemini observation (model ${cfg.gemini.model})\n`);
console.log(line(['Command', 'Intent', 'Engine', 'Confidence', 'Time']) + ' Warning');
console.log('-'.repeat(110));
for (const r of rows) console.log(line([`"${r.command}"`, r.intent, r.engine, r.confidence, `${r.ms} ms`]) + ` ${r.warning || '—'}`);

const outDir = path.join(here, '..', 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'gemini.json'), JSON.stringify({ model: cfg.gemini.model, rows }, null, 2));
