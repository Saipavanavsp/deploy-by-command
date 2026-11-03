// Optional static-site route: publish sample-app/public to Cloudflare Pages via Wrangler.
// The Wrangler runner is injectable so tests can stub it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError, redact, sleep as defaultSleep } from './errors.js';

export function defaultRunWrangler(args, { env, cwd, timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'npx.cmd' : 'npx', ['--yes', 'wrangler', ...args], { env, cwd, shell: isWin });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Choose the right URL: this project's production URL if printed, else this
// project's deployment URL, never documentation or dashboard links.
export function extractPagesUrl(output, projectName) {
  const urls = [...new Set([...String(output).matchAll(/https:\/\/[a-z0-9.-]+\.pages\.dev\b/gi)].map((m) => m[0].toLowerCase()))];
  const project = String(projectName).toLowerCase();
  const exact = `https://${project}.pages.dev`;
  if (urls.includes(exact)) return exact;
  const ofProject = urls.filter((u) => u.endsWith(`.${project}.pages.dev`));
  return ofProject.find((u) => /^https:\/\/[0-9a-f]{6,}\./.test(u)) || ofProject[0] || null;
}

export function createCloudflarePublisher({ cfg, log, runWrangler = defaultRunWrangler, fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep }) {
  const cf = cfg.cloudflare;
  const secrets = () => [cf.apiToken, cf.accountId];
  const clean = (s) => redact(s, secrets());

  function assertConfigured() {
    const missing = [];
    if (!cf.apiToken) missing.push('CLOUDFLARE_API_TOKEN');
    if (!cf.accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
    if (missing.length) {
      throw new AppError(
        'CLOUDFLARE_NOT_CONFIGURED',
        `Cloudflare publishing is not set up: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing. Add ${missing.length > 1 ? 'them' : 'it'} to your .env file (a Pages-edit API token and your account ID) and restart the backend.`,
        400,
      );
    }
  }

  async function verify(url) {
    let last = '';
    for (let i = 1; i <= cf.verifyAttempts; i++) {
      try {
        const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
        if (res.status === 200) return { verified: true, detail: 'HTTP 200' };
        last = `answered HTTP ${res.status}`;
      } catch (err) {
        last = `could not be reached (${err.message})`;
      }
      log.warn(`Cloudflare check ${i}/${cf.verifyAttempts}: ${url} ${last}`);
      if (i < cf.verifyAttempts) await sleep(cf.verifyDelayMs);
    }
    return { verified: false, detail: last };
  }

  async function publish() {
    assertConfigured();
    const env = { ...process.env, CLOUDFLARE_API_TOKEN: cf.apiToken, CLOUDFLARE_ACCOUNT_ID: cf.accountId };
    const cwd = cfg.rootDir;
    const dir = path.relative(cwd, cfg.staticSiteDir).split(path.sep).join('/');

    log.info(`Cloudflare: ensuring Pages project "${cf.projectName}" exists`);
    const create = await runWrangler(['pages', 'project', 'create', cf.projectName, '--production-branch', 'main'], { env, cwd });
    const createOut = `${create.stdout}\n${create.stderr}`;
    if (create.code !== 0 && !/already exists|8000002/i.test(createOut)) {
      log.warn(`Cloudflare: project create returned exit ${create.code}; trying the upload anyway`);
    }

    log.info(`Cloudflare: uploading ${dir} with wrangler pages deploy`);
    const deploy = await runWrangler(['pages', 'deploy', dir, '--project-name', cf.projectName, '--branch', 'main', '--commit-dirty=true'], { env, cwd });
    const out = `${deploy.stdout}\n${deploy.stderr}`;
    if (deploy.code !== 0) {
      const tail = clean(out).split(/\r?\n/).filter((l) => l.trim()).slice(-4).join(' | ');
      throw new AppError('CLOUDFLARE_FAILED', `Wrangler could not upload the site (exit ${deploy.code}). ${tail}`.trim(), 400);
    }
    const url = extractPagesUrl(out, cf.projectName);
    if (!url) {
      throw new AppError('CLOUDFLARE_FAILED', 'Wrangler finished but printed no pages.dev URL for this project, so the site could not be verified.', 400);
    }
    log.info(`Cloudflare: upload finished; checking ${url}`);
    const v = await verify(url);
    const message = v.verified
      ? `Published to Cloudflare Pages and verified: ${url} answered HTTP 200.`
      : `Files were uploaded but could not be verified: ${url} ${v.detail}.`;
    (v.verified ? log.info : log.warn)(`Cloudflare: ${message}`);
    return { url, verified: v.verified, message: clean(message) };
  }

  return { assertConfigured, publish, redactText: clean };
}
