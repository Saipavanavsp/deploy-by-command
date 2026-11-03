// Express app factory (used by server.js, tests and the benchmark).
import fs from 'node:fs';
import express from 'express';
import { assertRealModeAllowed, loadConfig, secretsOf } from './config.js';
import { createLogger } from './logger.js';
import { createStateStore } from './state.js';
import { createWorkflow } from './workflow.js';
import { createRouter } from './routes.js';
import { applyMiddleware, errorHandler, notFound } from './middleware.js';
import { createMockProvider } from './providers/mock.js';
import { createAwsProvider } from './providers/aws.js';
import { assertProvider } from './providers/provider.js';
import { createCloudflarePublisher } from './cloudflare.js';

export function createApp({ config, provider, logger, fetch: fetchImpl = globalThis.fetch, sleep, runWrangler, serveFrontend = true } = {}) {
  const cfg = config ?? loadConfig();
  assertRealModeAllowed(cfg);
  const log = logger ?? createLogger({ secrets: () => secretsOf(cfg), echo: process.env.LOG_ECHO === '1' });
  const prov = assertProvider(provider ?? (cfg.mode === 'mock'
    ? createMockProvider({ cfg, sleep })
    : createAwsProvider({ cfg, fetch: fetchImpl, sleep })));
  const store = createStateStore({ dir: cfg.stateDir, mode: cfg.mode, logger: log });
  const publisher = createCloudflarePublisher({ cfg, log, runWrangler, fetch: fetchImpl, sleep });
  const workflow = createWorkflow({ cfg, provider: prov, store, logger: log, publisher });

  const app = express();
  app.disable('x-powered-by');
  applyMiddleware(app, cfg);
  const router = createRouter({ cfg, workflow, logger: log, fetch: fetchImpl, sleep });
  app.use('/api', router);
  app.use('/', router);
  if (serveFrontend && fs.existsSync(cfg.frontendDist)) app.use(express.static(cfg.frontendDist));
  app.use(notFound);
  app.use(errorHandler(cfg, log));

  app.locals.cfg = cfg;
  app.locals.workflow = workflow;
  app.locals.logger = log;
  app.locals.store = store;
  return app;
}
