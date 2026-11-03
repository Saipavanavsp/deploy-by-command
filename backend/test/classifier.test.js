// Area: Rule classifier (1 test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithRules } from '../src/interpreter/rules.js';
import { REFERENCE_COMMANDS } from '../scripts/reference-commands.js';

test('[Rule classifier] the 12 reference commands map to the expected intents', () => {
  assert.equal(REFERENCE_COMMANDS.length, 12);
  for (const [command, expected] of REFERENCE_COMMANDS) {
    const r = classifyWithRules(command);
    assert.equal(r.intent, expected, `"${command}" -> ${r.intent}, expected ${expected}`);
    if (expected !== 'UNKNOWN') assert.ok(r.confidence >= 0.5, `"${command}" confidence ${r.confidence}`);
  }
});
