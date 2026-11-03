// Environment loading, MODE, the two real-AWS locks and SSH CIDR validation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = path.resolve(here, '..');
export const ROOT_DIR = path.resolve(BACKEND_DIR, '..');

export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

export function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^["'].*["']$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/(^|\s+)#.*$/, '').trim(); // strip trailing comment (also "KEY=  # note")
    out[key] = value;
  }
  return out;
}

// Loads a .env file without overriding variables already set in the process.
export function loadEnvFile(file, env = process.env) {
  if (!file || !fs.existsSync(file)) return false;
  const values = parseEnvText(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(values)) if (env[k] === undefined) env[k] = v;
  return true;
}

// ENV_FILE lets secrets live outside the project folder.
export function loadDotEnv(env = process.env) {
  const candidates = env.ENV_FILE
    ? [path.resolve(env.ENV_FILE)]
    : [path.join(ROOT_DIR, '.env'), path.join(BACKEND_DIR, '.env')];
  for (const file of candidates) if (loadEnvFile(file, env)) return file;
  return null;
}

export function validateSshCidr(cidr) {
  if (cidr === undefined || cidr === null || String(cidr).trim() === '') return '';
  const v = String(cidr).trim();
  if (v === '0.0.0.0/0' || v === '::/0') {
    throw new AppError(
      'UNSAFE_SSH_CIDR',
      'SSH_CIDR 0.0.0.0/0 would open SSH to the whole internet and is not allowed. Leave SSH_CIDR empty to auto-detect your public IP (/32), or give a narrow range.',
      400,
    );
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(v);
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) {
    throw new AppError('INVALID_SSH_CIDR', `SSH_CIDR "${v}" is not a valid IPv4 CIDR such as 203.0.113.7/32.`, 400);
  }
  if (Number(m[5]) === 0) {
    throw new AppError('UNSAFE_SSH_CIDR', 'An SSH_CIDR with prefix /0 opens SSH to the whole internet and is not allowed.', 400);
  }
  return v;
}

function merge(base, overrides) {
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? { ...base[k], ...v } : v;
  }
  return out;
}

export function loadConfig(env = process.env, overrides = {}) {
  const mode = String(env.MODE || 'mock').trim().toLowerCase();
  if (!['mock', 'aws'].includes(mode)) {
    throw new AppError('INVALID_CONFIG', `MODE must be "mock" or "aws" (got "${mode}").`, 400);
  }
  const base = {
    mode,
    allowRealAws: String(env.ALLOW_REAL_AWS || 'no').trim().toLowerCase() === 'yes',
    region: env.AWS_REGION || 'ap-south-1',
    awsProfile: env.AWS_PROFILE || '',
    instanceType: env.INSTANCE_TYPE || 't3.micro',
    sshCidr: validateSshCidr(env.SSH_CIDR),
    gemini: {
      apiKey: env.GEMINI_API_KEY || '',
      model: env.GEMINI_MODEL || 'gemini-flash-latest',
      url: GEMINI_URL,
      maxAttempts: 3,
      retryDelayMs: 1200,
      timeoutMs: 20000,
    },
    cloudflare: {
      apiToken: env.CLOUDFLARE_API_TOKEN || '',
      accountId: env.CLOUDFLARE_ACCOUNT_ID || '',
      projectName: env.CF_PROJECT_NAME || 'deploy-by-command',
      verifyAttempts: 6,
      verifyDelayMs: 5000,
    },
    port: Number(env.PORT || 4000),
    host: env.HOST || '127.0.0.1',
    corsOrigins: String(env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',').map((s) => s.trim()).filter(Boolean),
    stateDir: env.STATE_DIR || path.join(BACKEND_DIR, 'state'),
    keysDir: env.KEYS_DIR || path.join(BACKEND_DIR, 'keys'),
    rootDir: ROOT_DIR,
    appDir: path.join(ROOT_DIR, 'sample-app'),
    staticSiteDir: path.join(ROOT_DIR, 'sample-app', 'public'),
    frontendDist: path.join(ROOT_DIR, 'frontend', 'dist'),
    mock: {
      delayMs: env.MOCK_DELAY_MS !== undefined ? Number(env.MOCK_DELAY_MS) : 700,
      failStep: env.MOCK_FAIL_STEP || '',
    },
    aws: {
      sshAttempts: 12,
      sshDelayMs: 5000,
      publicCheckAttempts: 15,
      publicCheckDelayMs: 4000,
    },
    colabTunnel: env.COLAB_TUNNEL === '1',
    accessToken: env.ACCESS_TOKEN || '',
    rateLimitPerMinute: 240,
    bodyLimit: '10kb',
    secretValues: [env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN, env.AWS_ACCESS_KEY_ID].filter(Boolean),
  };
  const cfg = merge(base, overrides);
  if (cfg.colabTunnel) {
    if (cfg.mode !== 'mock') {
      throw new AppError('COLAB_TUNNEL_REQUIRES_MOCK', 'COLAB_TUNNEL=1 is only allowed with MODE=mock, because the dashboard has no login.', 409);
    }
    if (!cfg.accessToken || cfg.accessToken.length < 16) {
      throw new AppError('ACCESS_TOKEN_REQUIRED', 'COLAB_TUNNEL=1 needs ACCESS_TOKEN (at least 16 random characters).', 400);
    }
  }
  return cfg;
}

// Real AWS needs BOTH MODE=aws and ALLOW_REAL_AWS=yes.
export function assertRealModeAllowed(cfg) {
  if (cfg.mode === 'aws' && !cfg.allowRealAws) {
    throw new AppError(
      'REAL_MODE_LOCKED',
      'MODE=aws is set but ALLOW_REAL_AWS is not "yes". Real AWS needs both locks (MODE=aws and ALLOW_REAL_AWS=yes). Refusing to start in real mode.',
      409,
    );
  }
}

export function secretsOf(cfg) {
  return [cfg.gemini?.apiKey, cfg.cloudflare?.apiToken, cfg.accessToken, ...(cfg.secretValues || [])]
    .filter((s) => s && String(s).length >= 4);
}

export function isLoopback(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host));
}
