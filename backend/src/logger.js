// In-memory ring buffer of log lines with ids, timestamps and levels.
// Every line is redacted before it is stored, so secrets never reach /logs.
import { redact } from './errors.js';

export function createLogger({ max = 2000, secrets = () => [], echo = false } = {}) {
  const entries = [];
  let nextId = 1;

  function log(level, msg) {
    const entry = { id: nextId++, ts: new Date().toISOString(), level, msg: redact(msg, secrets()) };
    entries.push(entry);
    if (entries.length > max) entries.splice(0, entries.length - max);
    if (echo) console.log(`${entry.ts} ${level.padEnd(5)} ${entry.msg}`);
    return entry;
  }

  const logger = {
    log,
    info: (m) => log('INFO', m),
    warn: (m) => log('WARN', m),
    error: (m) => log('ERROR', m),
    since: (id = 0) => entries.filter((e) => e.id > id),
    lastId: () => nextId - 1,
    all: () => entries.slice(),
    // Prefix every message (used by the mock provider for [SIMULATED]).
    tagged(prefix) {
      return {
        info: (m) => log('INFO', `${prefix} ${m}`),
        warn: (m) => log('WARN', `${prefix} ${m}`),
        error: (m) => log('ERROR', `${prefix} ${m}`),
      };
    },
  };
  return logger;
}
