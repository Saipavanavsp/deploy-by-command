// Dependency-free sample app: "/" home page, "/health", "/info". Listens on 3000.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const PORT = Number(process.env.PORT || 3000);
const indexHtml = fs.readFileSync(path.join(here, 'public', 'index.html'));

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

function send(res, status, body, type) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  switch (pathname) {
    case '/':
    case '/index.html':
      return send(res, 200, indexHtml, 'text/html; charset=utf-8');
    case '/health':
      return sendJson(res, 200, { status: 'ok' });
    case '/info':
      return sendJson(res, 200, {
        name: pkg.name,
        version: pkg.version,
        node: process.version,
        uptime: Math.round(process.uptime()),
        hostname: os.hostname(),
      });
    default:
      return sendJson(res, 404, { error: 'not found' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`sample-app ${pkg.version} listening on port ${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
