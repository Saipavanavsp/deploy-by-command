// All endpoints. The router is mounted at both "/" and "/api".
import express from 'express';
import { interpretCommand } from './interpreter/gemini.js';
import { SUPPORTED_ACTIONS } from './interpreter/intents.js';
import { commandSchema, logsQuerySchema, operationSchema, parse, terminateSchema } from './schemas.js';

export function createRouter({ cfg, workflow, logger, fetch: fetchImpl, sleep }) {
  const r = express.Router();
  const engine = () => (cfg.gemini.apiKey ? 'gemini' : 'rules');

  r.get('/health', (req, res) => {
    res.json({ status: 'ok', mode: cfg.mode, simulated: cfg.mode === 'mock', engine: engine(), busy: workflow.isBusy(), time: new Date().toISOString() });
  });

  // Interpret only. Runs nothing.
  r.post('/command', async (req, res) => {
    const { text } = parse(commandSchema, req.body);
    const out = await interpretCommand(text, cfg, { fetch: fetchImpl, sleep });
    logger.info(`Command "${text.slice(0, 80)}" -> ${out.intent} (engine ${out.engine}, confidence ${out.confidence})${out.intent === 'UNKNOWN' ? ' — no action, nothing was run' : ''}`);
    if (out.warning) logger.warn(out.warning);
    res.json({ ...out, supported: out.intent === 'UNKNOWN' ? SUPPORTED_ACTIONS : undefined });
  });

  const op = (name, schema = operationSchema) => (req, res) => {
    const body = parse(schema, req.body);
    res.status(202).json(workflow.start(name, body));
  };

  r.post('/launch', op('launch'));
  r.post('/configure', op('configure'));
  r.post('/deploy', op('deploy'));
  r.post('/full', op('full'));
  r.get('/status', (req, res) => res.status(202).json(workflow.start('status')));
  r.post('/restart', op('restart'));
  r.post('/terminate', op('terminate', terminateSchema));
  r.post('/cloudflare', op('cloudflare'));

  r.get('/logs', (req, res) => {
    const { since } = parse(logsQuerySchema, req.query);
    res.json({ logs: logger.since(since), lastId: logger.lastId() });
  });

  r.get('/state', (req, res) => {
    res.json({
      ...workflow.publicState(),
      config: {
        region: cfg.region,
        instanceType: cfg.instanceType,
        engine: engine(),
        geminiModel: cfg.gemini.model,
        cloudflareConfigured: Boolean(cfg.cloudflare.apiToken && cfg.cloudflare.accountId),
        sshCidr: cfg.sshCidr ? 'configured' : 'auto-detect (your IP /32)',
      },
    });
  });

  return r;
}
