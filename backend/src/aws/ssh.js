// SSH/SFTP helpers with host-key pinning (SHA-256 fingerprint).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sleep } from '../errors.js';

export function fingerprint(keyBuffer) {
  return `SHA256:${crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '')}`;
}

async function loadClient() {
  const mod = await import('ssh2');
  return mod.Client || mod.default.Client;
}

function connectOnce(Client, { host, privateKey, pinned }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let seen = null;
    let mismatch = false;
    conn
      .on('ready', () => resolve({ conn, fingerprint: seen }))
      .on('error', (err) => {
        if (mismatch) {
          const e = new Error(`Host key mismatch for ${host}: expected ${pinned}, got ${seen}. Refusing to connect.`);
          e.code = 'HOST_KEY_MISMATCH';
          reject(e);
        } else reject(err);
      })
      .connect({
        host,
        port: 22,
        username: 'ec2-user',
        privateKey,
        readyTimeout: 20000,
        hostVerifier: (key) => {
          seen = fingerprint(key);
          if (pinned && seen !== pinned) {
            mismatch = true;
            return false;
          }
          return true;
        },
      });
  });
}

// Connect with retries; pins the host key on first contact via onFirstContact(fp).
export async function sshConnect({ host, keyPath, pinned, onFirstContact, log, attempts = 12, delayMs = 5000 }) {
  if (!host) throw new Error('No public IP is tracked for this server.');
  if (!keyPath || !fs.existsSync(keyPath)) throw new Error('The private key file for this server is missing.');
  const Client = await loadClient();
  const privateKey = fs.readFileSync(keyPath);
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { conn, fingerprint: fp } = await connectOnce(Client, { host, privateKey, pinned });
      if (!pinned) {
        log.info(`First SSH contact: host key fingerprint ${fp} — pinned in state`);
        await onFirstContact?.(fp);
      }
      log.info(`SSH connected to ec2-user@${host}`);
      return { conn, fingerprint: fp };
    } catch (err) {
      if (err.code === 'HOST_KEY_MISMATCH') {
        log.error(err.message);
        throw err;
      }
      lastErr = err;
      log.warn(`SSH attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(`Could not connect over SSH after ${attempts} attempts (${lastErr?.message}).`);
}

// Runs one hardcoded command; output goes to the log.
export function run(conn, cmd, log, { allowFail = false, maxLines = 40 } = {}) {
  return new Promise((resolve, reject) => {
    log.info(`$ ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => { stdout += d; });
      stream.stderr.on('data', (d) => { stderr += d; });
      stream.on('close', (code) => {
        const lines = `${stdout}${stderr}`.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length > maxLines) log.info(`  (${lines.length - maxLines} earlier output lines omitted)`);
        for (const line of lines.slice(-maxLines)) log.info(`  ${line}`);
        const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
        if (code !== 0 && !allowFail) reject(new Error(`Remote command failed (exit ${code}): ${cmd}`));
        else resolve(result);
      });
    });
  });
}

export function upload(conn, localPath, remotePath, log) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => {
        sftp.end();
        if (e) return reject(e);
        log.info(`Uploaded package over SFTP to ${remotePath}`);
        resolve();
      });
    });
  });
}
