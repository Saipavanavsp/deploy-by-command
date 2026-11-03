// Runs the AWS pre-flight checks only (identity, instance type, AMI, VPC, dry run).
// Creates nothing. Needs MODE=aws and ALLOW_REAL_AWS=yes like everything else that touches AWS.
import { assertRealModeAllowed, loadConfig, loadDotEnv, secretsOf } from '../src/config.js';
import { createAwsClients, preflight } from '../src/aws/preflight.js';
import { redact } from '../src/errors.js';

loadDotEnv();
const cfg = loadConfig();
if (cfg.mode !== 'aws') {
  console.log('MODE is not "aws": pre-flight skipped. Set MODE=aws and ALLOW_REAL_AWS=yes to run it.');
  process.exit(0);
}
try {
  assertRealModeAllowed(cfg);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const secrets = secretsOf(cfg);
const log = {
  info: (m) => console.log(`INFO  ${redact(m, secrets)}`),
  warn: (m) => console.log(`WARN  ${redact(m, secrets)}`),
  error: (m) => console.log(`ERROR ${redact(m, secrets)}`),
};
console.log(`Pre-flight in ${cfg.region} for ${cfg.instanceType} (nothing will be created)\n`);
const result = await preflight({ clients: await createAwsClients(cfg), cfg, log });
console.log(`\nPre-flight ${result.ok ? 'PASSED' : 'FAILED'}: ${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks OK`);
process.exitCode = result.ok ? 0 : 1;
