// Real provider: EC2 (Module 4) + SSH/Docker (Module 5).
// Only reachable when MODE=aws AND ALLOW_REAL_AWS=yes. SDK and ssh2 are loaded lazily.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSshCidr } from '../config.js';
import { sleep as defaultSleep } from '../errors.js';
import { createAwsClients, preflight } from '../aws/preflight.js';
import {
  allowIngress, createKeyPair, createSecurityGroup, describeInstance, rollback, runInstance, terminateAll, waitRunning,
} from '../aws/ec2.js';
import { run, sshConnect, upload } from '../aws/ssh.js';
import { myPublicIpCidr } from '../aws/myip.js';

const REMOTE_TARBALL = '/home/ec2-user/sample-app.tar.gz';

export function createAwsProvider({ cfg, fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep, clientsFactory = createAwsClients }) {
  let clients = null;
  const getClients = async () => (clients ??= await clientsFactory(cfg));

  async function httpOk(url) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, status: 0, error: err.message };
    }
  }

  async function publicHealth(ip, log) {
    const url = `http://${ip}/health`;
    for (let i = 1; i <= cfg.aws.publicCheckAttempts; i++) {
      const r = await httpOk(url);
      if (r.ok) {
        log.info(`Public health check ${url} -> HTTP ${r.status}`);
        return true;
      }
      log.warn(`Public health check ${i}/${cfg.aws.publicCheckAttempts}: ${r.status ? `HTTP ${r.status}` : r.error}`);
      if (i < cfg.aws.publicCheckAttempts) await sleep(cfg.aws.publicCheckDelayMs);
    }
    return false;
  }

  async function connect(ctx) {
    return sshConnect({
      host: ctx.infra.publicIp,
      keyPath: ctx.infra.keyPath,
      pinned: ctx.infra.hostKeyFingerprint,
      onFirstContact: (fp) => ctx.track({ hostKeyFingerprint: fp }),
      log: ctx.log,
      attempts: cfg.aws.sshAttempts,
      delayMs: cfg.aws.sshDelayMs,
    });
  }

  return {
    name: 'aws',
    simulated: false,

    // Pseudocode 3: LaunchServer.
    async launch(ctx) {
      const { log } = ctx;
      const c = await getClients();
      const checks = await preflight({ clients: c, cfg, log });
      if (!checks.ok) {
        const failed = checks.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join('; ');
        throw new Error(`Pre-flight failed (${failed}). Nothing was created.`);
      }
      const cidr = cfg.sshCidr || (await myPublicIpCidr({ fetch: fetchImpl }));
      validateSshCidr(cidr); // ASSERT cidr != 0.0.0.0/0
      log.info(`SSH will be allowed from ${cidr} only`);

      let id = null;
      let key = null;
      let sg = null;
      try {
        key = await createKeyPair({ clients: c, keysDir: cfg.keysDir, log });
        ctx.track({ keyName: key.keyName, keyPath: key.keyPath, region: cfg.region, simulated: false });
        sg = await createSecurityGroup({ clients: c, vpcId: checks.vpcId, log });
        ctx.track({ securityGroupId: sg });
        await allowIngress({ clients: c, groupId: sg, port: 22, cidr, description: 'SSH from operator', log });
        await allowIngress({ clients: c, groupId: sg, port: 80, cidr: '0.0.0.0/0', description: 'HTTP', log });
        id = await runInstance({ clients: c, amiId: checks.amiId, instanceType: cfg.instanceType, keyName: key.keyName, groupId: sg, log });
        ctx.track({ instanceId: id, amiId: checks.amiId, instanceType: cfg.instanceType, sshCidr: cidr });
        await waitRunning({ clients: c, instanceId: id, log });
        const { publicIp } = await describeInstance({ clients: c, instanceId: id });
        if (!publicIp) throw new Error(`Instance ${id} has no public IP (is auto-assign public IP enabled in the default subnet?)`);
        log.info(`Server ${id} is ready at ${publicIp}`);
        return {
          instanceId: id, publicIp, securityGroupId: sg, keyName: key.keyName, region: cfg.region,
          instanceType: cfg.instanceType, simulated: false,
        };
      } catch (err) {
        if (!id) {
          log.warn('Launch failed before an instance existed; rolling back key pair and security group');
          const clean = await rollback({ clients: c, groupId: sg, keyName: key?.keyName, keyPath: key?.keyPath, log });
          if (clean) ctx.clearInfra();
        } else {
          log.error(`Instance ${id} is tracked in state; use Terminate to remove it.`);
        }
        throw err;
      }
    },

    async configure(ctx) {
      const { log } = ctx;
      const { conn, fingerprint } = await connect(ctx);
      try {
        await run(conn, 'sudo dnf -y update', log);
        await run(conn, 'sudo dnf -y install docker', log);
        await run(conn, 'sudo systemctl enable --now docker', log);
        const active = await run(conn, 'systemctl is-active docker', log, { allowFail: true });
        if (active.stdout.trim() !== 'active') throw new Error(`Docker is not active (systemctl says "${active.stdout.trim() || active.stderr}")`);
        const info = await run(conn, "sudo docker info --format '{{.ServerVersion}}'", log, { allowFail: true });
        if (info.code !== 0) throw new Error('"docker info" did not respond');
        log.info(`Docker ${info.stdout} is active`);
        return { dockerReady: true, hostKeyFingerprint: fingerprint, dockerVersion: info.stdout };
      } finally {
        conn.end();
      }
    },

    // Pseudocode 4: DeployAndVerify.
    async deploy(ctx) {
      const { log } = ctx;
      const tar = await import('tar');
      const tarball = path.join(os.tmpdir(), `sample-app-${Date.now()}.tar.gz`);
      await tar.c({ gzip: true, file: tarball, cwd: cfg.appDir, filter: (p) => !p.includes('node_modules') }, ['.']);
      log.info(`Packaged sample-app (${fs.statSync(tarball).size} bytes)`);
      const { conn } = await connect(ctx);
      try {
        await upload(conn, tarball, REMOTE_TARBALL, log);
        await run(conn, 'rm -rf ~/sample-app && mkdir -p ~/sample-app && tar -xzf ~/sample-app.tar.gz -C ~/sample-app', log);
        await run(conn, 'cd ~/sample-app && sudo docker build -t sample-app .', log);
        await run(conn, 'sudo docker rm -f sample-app', log, { allowFail: true });
        await run(conn, 'sudo docker run -d -p 80:3000 --restart unless-stopped --name sample-app sample-app', log);
        const running = await run(conn, "sudo docker inspect -f '{{.State.Running}}' sample-app", log, { allowFail: true });
        if (running.stdout.trim() !== 'true') throw new Error('container not running');
        let internalOk = false;
        for (let i = 1; i <= 10 && !internalOk; i++) {
          const r = await run(conn, 'curl -fsS http://localhost/health', log, { allowFail: true });
          internalOk = r.code === 0;
          if (!internalOk) await sleep(2000);
        }
        if (!internalOk) throw new Error('internal health check');
      } finally {
        conn.end();
        fs.rmSync(tarball, { force: true });
      }
      if (!(await publicHealth(ctx.infra.publicIp, log))) throw new Error('public URL not reachable');
      return { url: `http://${ctx.infra.publicIp}`, healthy: true };
    },

    async status(ctx) {
      const { log } = ctx;
      const c = await getClients();
      const checks = [];
      let instanceState = 'unknown';
      try {
        instanceState = (await describeInstance({ clients: c, instanceId: ctx.infra.instanceId })).state;
        checks.push({ name: 'instance', ok: instanceState === 'running', detail: `${ctx.infra.instanceId} is ${instanceState}` });
      } catch (err) {
        checks.push({ name: 'instance', ok: false, detail: err.message });
      }
      if (instanceState === 'running') {
        try {
          const { conn } = await connect(ctx);
          try {
            const r = await run(conn, "sudo docker inspect -f '{{.State.Status}}' sample-app", log, { allowFail: true });
            const s = r.code === 0 ? r.stdout.trim() : 'not found';
            checks.push({ name: 'container', ok: s === 'running', detail: `sample-app is ${s}` });
          } finally {
            conn.end();
          }
        } catch (err) {
          checks.push({ name: 'container', ok: false, detail: err.message });
        }
        const h = await httpOk(`http://${ctx.infra.publicIp}/health`);
        checks.push({ name: 'website', ok: h.ok, detail: h.ok ? `http://${ctx.infra.publicIp}/health -> HTTP ${h.status}` : `not healthy (${h.status ? `HTTP ${h.status}` : h.error})` });
      } else {
        checks.push({ name: 'container', ok: false, detail: 'skipped: instance not running' });
        checks.push({ name: 'website', ok: false, detail: 'skipped: instance not running' });
      }
      for (const ch of checks) log.info(`Status ${ch.name}: ${ch.ok ? 'OK' : 'NOT OK'} — ${ch.detail}`);
      return { checks };
    },

    async restart(ctx) {
      const { log } = ctx;
      const { conn } = await connect(ctx);
      try {
        await run(conn, 'sudo docker restart sample-app', log);
      } finally {
        conn.end();
      }
      if (!(await publicHealth(ctx.infra.publicIp, log))) throw new Error('site did not answer after restart');
      return { url: `http://${ctx.infra.publicIp}`, healthy: true };
    },

    async terminate(ctx) {
      const c = await getClients();
      await terminateAll({ clients: c, infra: ctx.infra, log: ctx.log });
      return { terminated: true };
    },
  };
}
