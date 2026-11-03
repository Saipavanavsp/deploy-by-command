// Module 2: safe workflow orchestration — one-job lock, preconditions, step status.
import { AppError, causeOf, redact } from './errors.js';
import { emptyState, sanitizeState, STEP_NAMES } from './state.js';
import { secretsOf } from './config.js';

const LABEL = {
  launch: 'LAUNCH', configure: 'CONFIGURE', deploy: 'DEPLOY', full: 'FULL_DEPLOY',
  status: 'STATUS', restart: 'RESTART', terminate: 'TERMINATE', cloudflare: 'CLOUDFLARE',
};
export const OPERATIONS = Object.keys(LABEL);

export function createWorkflow({ cfg, provider, store, logger, publisher }) {
  const state = store.load();
  state.busy = false;
  state.currentOp = null;
  const secrets = () => secretsOf(cfg);
  const simulated = cfg.mode === 'mock';

  const save = () => {
    state.updatedAt = new Date().toISOString();
    store.save(state);
  };
  const hasInstance = () => Boolean(state.infra?.instanceId);
  const result = (op, ok, message, extra = {}) => {
    state.lastResult = { op, ok, message: redact(message, secrets()), at: new Date().toISOString(), ...extra };
  };

  function preconditions(op, opts = {}) {
    const id = state.infra?.instanceId;
    const noInstance = () => new AppError('NO_INSTANCE', 'No server is tracked yet. Launch a server first.', 409);
    switch (op) {
      case 'launch':
        if (hasInstance()) throw new AppError('ALREADY_TRACKED', `A server (${id}) is already tracked. Only one server is allowed; terminate it before launching another.`, 409);
        break;
      case 'configure':
        if (!hasInstance()) throw noInstance();
        break;
      case 'deploy':
        if (!hasInstance()) throw noInstance();
        if (!state.dockerReady) throw new AppError('NOT_CONFIGURED', 'Docker is not ready on the server yet. Run Configure first.', 409);
        break;
      case 'full':
        break;
      case 'status':
        if (!hasInstance()) throw noInstance();
        break;
      case 'restart':
        if (!hasInstance()) throw noInstance();
        if (!state.deployment) throw new AppError('NOT_DEPLOYED', 'Nothing is deployed yet, so there is no container to restart. Run Deploy first.', 409);
        break;
      case 'terminate': {
        if (!hasInstance()) throw noInstance();
        const c = String(opts.confirm ?? '').trim();
        if (c !== 'TERMINATE' && c !== id) {
          throw new AppError('CONFIRMATION_REQUIRED', `Terminate needs typed confirmation: send confirm "TERMINATE" or the instance ID (${id}).`, 400);
        }
        break;
      }
      case 'cloudflare':
        publisher.assertConfigured();
        break;
      default:
        throw new AppError('INVALID_INPUT', `Unknown operation "${op}".`, 400);
    }
  }

  const ctx = () => ({
    cfg,
    log: logger,
    infra: state.infra ? { ...state.infra } : null,
    deployment: state.deployment ? { ...state.deployment } : null,
    track: (partial) => {
      state.infra = { ...(state.infra || {}), ...partial };
      save(); // never lose track of a created resource
    },
    clearInfra: () => {
      state.infra = null;
      save();
    },
  });

  function apply(name, r) {
    const tag = simulated ? ' (simulated)' : '';
    switch (name) {
      case 'launch':
        if (!r.instanceId || !r.publicIp) throw new Error('Provider did not return an instance ID and public IP');
        state.infra = { ...(state.infra || {}), ...r };
        state.dockerReady = false;
        state.deployment = null;
        state.steps.configure = 'pending';
        state.steps.deploy = 'pending';
        result('launch', true, simulated
          ? `LAUNCH: Simulated server ${r.instanceId} is running at ${r.publicIp} — a reserved example address, not real.`
          : `LAUNCH: Server ${r.instanceId} is running at ${r.publicIp}.`);
        break;
      case 'configure':
        if (r.dockerReady !== true) throw new Error('Provider did not confirm Docker is ready');
        state.dockerReady = true;
        state.infra = { ...state.infra, hostKeyFingerprint: r.hostKeyFingerprint || state.infra.hostKeyFingerprint, dockerVersion: r.dockerVersion };
        result('configure', true, `CONFIGURE: Docker is installed and active${tag}.`);
        break;
      case 'deploy':
        if (r.healthy !== true || !r.url) throw new Error('Provider did not confirm a healthy public URL');
        state.deployment = { url: r.url, healthy: true, at: new Date().toISOString() };
        result('deploy', true, simulated
          ? `DEPLOY: Simulated deployment complete. ${r.url} is a reserved example address — not a real website.`
          : `DEPLOY: Deployment complete and verified from the public internet: ${r.url}`, { url: r.url });
        break;
      case 'status': {
        const checks = Array.isArray(r.checks) ? r.checks : [];
        state.lastStatus = { checks, at: new Date().toISOString() };
        const web = checks.find((c) => c.name === 'website');
        if (state.deployment && web) state.deployment.healthy = Boolean(web.ok);
        const failed = checks.filter((c) => !c.ok);
        if (!checks.length || failed.length) {
          throw new Error(`Status: ${failed.map((c) => `${c.name} not OK (${c.detail})`).join('; ') || 'no checks returned'}`);
        }
        result('status', true, `STATUS: instance, container and website are all OK${tag}.`, { checks });
        break;
      }
      case 'restart':
        if (r.healthy !== true) throw new Error('Site did not answer after restart');
        state.deployment = { ...(state.deployment || {}), url: r.url, healthy: true };
        result('restart', true, `RESTART: Container restarted and the site answered${tag}.`, { url: r.url });
        break;
      case 'terminate': {
        if (r.terminated !== true) throw new Error('Provider did not confirm termination');
        const old = state.infra?.instanceId;
        Object.assign(state, { ...emptyState(cfg.mode), cloudflare: state.cloudflare });
        result('terminate', true, `TERMINATE: Server ${old} terminated and its security group, key pair and local key deleted${tag}.`);
        break;
      }
      default:
        break;
    }
  }

  // Pseudocode 1: Step.
  async function step(name) {
    const tracked = STEP_NAMES.includes(name);
    if (tracked) state.steps[name] = 'running';
    save();
    logger.info(`Step ${name}: running`);
    try {
      const r = await provider[name](ctx()); // real result only
      if (!r || typeof r !== 'object') throw new Error(`Provider returned no result for ${name}`);
      apply(name, r);
      if (tracked) state.steps[name] = 'done';
      save();
      logger.info(`Step ${name}: done`);
      return r;
    } catch (err) {
      if (tracked) state.steps[name] = 'failed';
      save();
      logger.error(`Step ${name}: failed`);
      throw err;
    }
  }

  // Pseudocode 1: Execute.
  async function execute(op) {
    try {
      if (op === 'full') {
        if (hasInstance()) logger.info('FULL_DEPLOY: skip launch — a server is already tracked');
        else await step('launch');
        if (state.dockerReady) logger.info('FULL_DEPLOY: skip configure — Docker is already ready');
        else await step('configure');
        await step('deploy');
      } else if (op === 'cloudflare') {
        const r = await publisher.publish();
        state.cloudflare = { url: r.url, verified: r.verified, message: r.message, at: new Date().toISOString() };
        result('cloudflare', r.verified, `CLOUDFLARE: ${r.message}`, { url: r.url, verified: r.verified });
      } else {
        await step(op);
      }
      state.lastOp = { ...state.lastOp, status: state.lastResult?.ok === false ? 'failed' : 'done', endedAt: new Date().toISOString() };
      logger.info(`Operation ${LABEL[op]} finished`);
    } catch (err) {
      const message = redact(err?.message || String(err), secrets());
      state.lastError = { op, message, cause: redact(causeOf(err) || '', secrets()) || null, at: new Date().toISOString() };
      state.lastOp = { ...state.lastOp, status: 'failed', endedAt: new Date().toISOString() };
      result(op, false, `${LABEL[op]}: failed — ${message}`);
      logger.error(`${LABEL[op]} failed: ${message}`);
    } finally {
      state.busy = false;
      state.currentOp = null;
      save();
    }
  }

  let current = Promise.resolve();

  // Pseudocode 1: StartOperation.
  function start(op, opts = {}) {
    if (state.busy) throw new AppError('BUSY', `Another operation (${LABEL[state.currentOp] || state.currentOp}) is still running. Wait for it to finish.`, 409);
    preconditions(op, opts);
    state.busy = true;
    state.currentOp = op;
    state.lastError = null;
    state.lastOp = { name: op, status: 'running', startedAt: new Date().toISOString() };
    logger.info(`Operation ${LABEL[op]} started`);
    current = new Promise((resolve) => setImmediate(() => execute(op).then(resolve, resolve)));
    return { accepted: true, operation: op, label: LABEL[op] };
  }

  function publicState() {
    return {
      ...sanitizeState(state),
      busy: state.busy,
      currentOp: state.currentOp,
      simulated,
    };
  }

  return {
    start,
    publicState,
    isBusy: () => state.busy,
    idle: () => current,
    raw: () => state,
  };
}
