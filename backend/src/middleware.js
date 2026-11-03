// helmet, CORS allowlist, rate limit (240/min -> 429), 10 KB JSON limit, Colab access token.
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { AppError, redact } from './errors.js';
import { secretsOf } from './config.js';

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function isAllowedOrigin(origin, req, cfg) {
  if (!origin) return true; // same-origin GETs, curl, scripts
  if (cfg.corsOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host; // dashboard served by this backend
  } catch {
    return false;
  }
}

// Colab only (COLAB_TUNNEL=1): every request needs the notebook's random token.
function accessTokenGuard(cfg) {
  return (req, res, next) => {
    if (!cfg.colabTunnel) return next();
    // Health stays open for hosting health checks; it reveals only mode/engine.
    if (req.method === 'GET' && (req.path === '/health' || req.path === '/api/health')) return next();
    // A "+" in an unencoded ?token= arrives as a space; restore it (tokens never contain spaces).
    const fromQuery = typeof req.query?.token === 'string' ? req.query.token.replace(/ /g, '+') : '';
    const provided = req.get('x-access-token') || fromQuery || parseCookies(req.headers.cookie).dbc_token || '';
    if (!provided || !safeEqual(provided, cfg.accessToken)) {
      return res.status(401).json({ error: { code: 'ACCESS_TOKEN_REQUIRED', message: 'This dashboard is protected by an access token. Open the full link with ?token=<ACCESS_TOKEN> (from the notebook output, or Render -> Environment).' } });
    }
    if (fromQuery) res.cookie('dbc_token', provided, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
    req.tokenOk = true;
    return next();
  };
}

export function applyMiddleware(app, cfg) {
  app.use(helmet({
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(accessTokenGuard(cfg));
  // Refuse cross-site requests outright (a browser on another site must not drive this API).
  app.use((req, res, next) => {
    if (req.tokenOk || isAllowedOrigin(req.headers.origin, req, cfg)) return next();
    return res.status(403).json({ error: { code: 'FORBIDDEN_ORIGIN', message: 'This origin is not in the CORS allowlist.' } });
  });
  app.use(cors((req, cb) => cb(null, { origin: isAllowedOrigin(req.headers.origin, req, cfg) || Boolean(req.tokenOk), credentials: true })));
  app.use(rateLimit({
    windowMs: 60 * 1000,
    limit: cfg.rateLimitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: `Too many requests: the limit is ${cfg.rateLimitPerMinute} per minute. Try again shortly.` } }),
  }));
  app.use(express.json({ limit: cfg.bodyLimit, strict: true }));
}

export function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No endpoint ${req.method} ${req.path}.` } });
}

export function errorHandler(cfg, logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const secrets = secretsOf(cfg);
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is larger than the 10 KB limit.' } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Request body is not valid JSON.' } });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: redact(err.message, secrets) } });
    }
    logger?.error(`Unexpected error: ${redact(err?.message || String(err), secrets)}`);
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error. See the logs.' } });
  };
}
