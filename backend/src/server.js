// Entry point: loads .env (or ENV_FILE), prints the mode banner, binds 127.0.0.1.
import fs from 'node:fs';
import { assertRealModeAllowed, isLoopback, loadConfig, loadDotEnv } from './config.js';
import { stateFileFor } from './state.js';
import { createApp } from './app.js';

const envFile = loadDotEnv();

let cfg;
try {
  cfg = loadConfig();
  assertRealModeAllowed(cfg);
} catch (err) {
  console.error(`\n  REFUSING TO START: ${err.message}\n`);
  process.exit(1);
}

const line = '='.repeat(72);
console.log(line);
console.log('  Deploy by Command — backend');
console.log(`  Config: ${envFile ? 'loaded .env file' : 'no .env file found (using environment / defaults)'}`);
if (cfg.mode === 'mock') {
  console.log('  MODE: mock — SIMULATED MODE — nothing here touches AWS, SSH or Docker');
} else {
  console.log(`  MODE: aws — REAL AWS in ${cfg.region} (${cfg.instanceType})`);
  console.log('  WARNING: this can create BILLABLE resources in your AWS account.');
  const file = stateFileFor(cfg.stateDir, 'aws');
  try {
    const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if (s?.infra?.instanceId) {
      console.log(`  WARNING: the state file already tracks instance ${s.infra.instanceId}. Terminate it when you are done.`);
    }
  } catch { /* unreadable state is reported by the state store */ }
}
console.log(`  Engine: ${cfg.gemini.apiKey ? `Gemini (${cfg.gemini.model}) with rule fallback` : 'rules only (GEMINI_API_KEY not set)'}`);
if (!isLoopback(cfg.host)) console.log(`  WARNING: HOST=${cfg.host} is not loopback. The dashboard has no login; do not expose it.`);
if (cfg.colabTunnel) console.log('  COLAB_TUNNEL=1: access token required on every request; MODE forced to mock.');
console.log(line);

const app = createApp({ config: cfg });
app.listen(cfg.port, cfg.host, () => {
  console.log(`  Listening on http://${cfg.host}:${cfg.port}  (API also under /api)`);
});
