// Table IV: rule-based classifier on the 12 reference commands.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyWithRules } from '../src/interpreter/rules.js';
import { FREE_FORM_COMMAND, REFERENCE_COMMANDS } from './reference-commands.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rows = REFERENCE_COMMANDS.map(([command, expected]) => {
  const r = classifyWithRules(command);
  return { command, expected, got: r.intent, confidence: r.confidence, passed: r.intent === expected };
});
const passed = rows.filter((r) => r.passed).length;

const w = [46, 13, 13, 8];
const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join(' ');
console.log('Table IV — rule-based classifier on the reference commands\n');
console.log(line(['Command', 'Expected', 'Got', 'Result']));
console.log('-'.repeat(w.reduce((a, b) => a + b + 1, 0)));
for (const r of rows) console.log(line([`"${r.command}"`, r.expected, r.got, r.passed ? 'Passed' : 'Failed']));
console.log(`\nPassed: ${passed} / ${rows.length}`);

const free = classifyWithRules(FREE_FORM_COMMAND);
console.log(`\nFree-form sentence (rules only): "${FREE_FORM_COMMAND}"`);
console.log(`  -> ${free.intent} (confidence ${free.confidence}) — ${free.reason}`);
console.log('  Nothing runs for UNKNOWN. With a Gemini key, see scripts/observe-gemini.js (Table V).');

const outDir = path.join(here, '..', 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'classifier.json'), JSON.stringify({ passed, total: rows.length, rows, freeForm: { command: FREE_FORM_COMMAND, ...free } }, null, 2));
process.exitCode = passed === rows.length ? 0 : 1;
