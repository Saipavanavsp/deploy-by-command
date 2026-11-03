// Per-mode state persistence: state/state-mock.json and state/state-aws.json.
// Simulated state can never load in real mode.
import fs from 'node:fs';
import path from 'node:path';

export const STEP_NAMES = ['launch', 'configure', 'deploy'];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function emptyState(mode) {
  return {
    mode,
    infra: null,
    dockerReady: false,
    deployment: null,
    steps: { launch: 'pending', configure: 'pending', deploy: 'pending' },
    lastOp: null,
    lastResult: null,
    lastError: null,
    lastStatus: null,
    cloudflare: null,
    updatedAt: null,
  };
}

export function stateFileFor(dir, mode) {
  return path.join(dir, `state-${mode}.json`);
}

export function createStateStore({ dir, mode, logger }) {
  const file = stateFileFor(dir, mode);
  return {
    file,
    load() {
      if (!fs.existsSync(file)) return emptyState(mode);
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.mode !== mode) {
          logger?.warn(`State file ${path.basename(file)} belongs to mode "${data.mode}", not "${mode}". Ignoring it.`);
          return emptyState(mode);
        }
        if (mode === 'aws' && data.infra?.simulated) {
          logger?.warn('Simulated infrastructure found in the real-mode state file. Ignoring it.');
          return emptyState(mode);
        }
        const base = emptyState(mode);
        return { ...base, ...data, steps: { ...base.steps, ...(data.steps || {}) } };
      } catch (err) {
        logger?.warn(`State file ${path.basename(file)} could not be read (${err.message}). Starting with empty state.`);
        return emptyState(mode);
      }
    },
    save(state) {
      fs.mkdirSync(dir, { recursive: true });
      // eslint-disable-next-line no-unused-vars
      const { busy, currentOp, ...persist } = state;
      const data = JSON.stringify({ ...persist, mode }, null, 2);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, data);
      // Atomic rename; on Windows (OneDrive sync, antivirus) the target can be
      // locked for a moment, so retry briefly and then fall back to a direct write.
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          fs.renameSync(tmp, file);
          return;
        } catch (err) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
          sleepSync(25 * attempt);
        }
      }
      fs.writeFileSync(file, data);
      fs.rmSync(tmp, { force: true });
    },
  };
}

const PRIVATE_KEYS = new Set(['keyPath', 'keyMaterial', 'privateKey']);

// Removes key paths and any secret-bearing field before state goes to the browser.
export function sanitizeState(state) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) if (!PRIVATE_KEYS.has(k)) out[k] = strip(val);
      return out;
    }
    return v;
  };
  return strip(state);
}
