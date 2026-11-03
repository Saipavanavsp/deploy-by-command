// Simulated provider: same interface as AWS, touches nothing real.
// Every log line is tagged [SIMULATED]; IPs come from 198.51.100.0/24 (documentation range).
import crypto from 'node:crypto';
import { sleep as defaultSleep } from '../errors.js';

const hex = (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

export function createMockProvider({ cfg, sleep = defaultSleep }) {
  const delay = (factor = 1) => sleep(Math.max(0, Math.round(cfg.mock.delayMs * factor)));
  const maybeFail = (step) => {
    if (cfg.mock.failStep === step) {
      throw new Error(`Injected failure in step "${step}" (MOCK_FAIL_STEP=${step})`);
    }
  };
  const sim = (ctx) => (ctx.log.tagged ? ctx.log.tagged('[SIMULATED]') : {
    info: (m) => ctx.log.info(`[SIMULATED] ${m}`),
    warn: (m) => ctx.log.warn(`[SIMULATED] ${m}`),
    error: (m) => ctx.log.error(`[SIMULATED] ${m}`),
  });

  return {
    name: 'mock',
    simulated: true,

    async launch(ctx) {
      const log = sim(ctx);
      log.info('Pre-flight: identity, instance type, AL2023 AMI, default VPC, dry run — all simulated OK');
      await delay();
      maybeFail('launch');
      const keyName = `deploy-by-command-sim-${hex(6)}`;
      const securityGroupId = `sg-0sim${hex(12)}`;
      log.info(`Created key pair ${keyName} and security group ${securityGroupId} (SSH from your /32, HTTP from anywhere)`);
      const instanceId = `i-0sim${hex(12)}`;
      ctx.track({ instanceId, securityGroupId, keyName, simulated: true });
      log.info(`Instance ${instanceId} launched (${cfg.instanceType}, Amazon Linux 2023, IMDSv2 required)`);
      await delay();
      log.info('Instance is running; both status checks passed');
      const publicIp = `198.51.100.${2 + crypto.randomInt(252)}`;
      log.info(`Public IP ${publicIp} (reserved example address, not real)`);
      return { instanceId, publicIp, securityGroupId, keyName, region: cfg.region, instanceType: cfg.instanceType, simulated: true };
    },

    async configure(ctx) {
      const log = sim(ctx);
      log.info(`Connecting over SSH to ec2-user@${ctx.infra.publicIp}`);
      await delay(0.5);
      const hostKeyFingerprint = `SHA256:${crypto.randomBytes(32).toString('base64').replace(/=+$/, '')}`;
      if (!ctx.infra.hostKeyFingerprint) log.info(`Host key fingerprint ${hostKeyFingerprint} — pinned`);
      log.info('$ sudo dnf -y update');
      log.info('$ sudo dnf -y install docker');
      await delay(0.5);
      maybeFail('configure');
      log.info('$ sudo systemctl enable --now docker');
      log.info('$ systemctl is-active docker -> active');
      log.info('$ sudo docker info -> Server Version 25.0.x');
      return { dockerReady: true, hostKeyFingerprint: ctx.infra.hostKeyFingerprint || hostKeyFingerprint, dockerVersion: '25.0 (simulated)' };
    },

    async deploy(ctx) {
      const log = sim(ctx);
      log.info('Packaging sample-app as tar.gz and uploading over SFTP');
      await delay(0.5);
      log.info('$ docker build -t sample-app .');
      log.info('$ docker rm -f sample-app');
      log.info('$ docker run -d -p 80:3000 --restart unless-stopped --name sample-app sample-app');
      await delay(0.5);
      maybeFail('deploy');
      log.info('Container sample-app is running; internal health check passed');
      const url = `http://${ctx.infra.publicIp}`;
      log.info(`Public health check ${url}/health -> 200 (simulated; this address is not real)`);
      return { url, healthy: true };
    },

    async status(ctx) {
      const log = sim(ctx);
      await delay(0.3);
      maybeFail('status');
      const deployed = Boolean(ctx.deployment);
      const checks = [
        { name: 'instance', ok: true, detail: `${ctx.infra.instanceId} is running (simulated)` },
        { name: 'container', ok: deployed, detail: deployed ? 'sample-app is running (simulated)' : 'sample-app is not deployed' },
        { name: 'website', ok: deployed, detail: deployed ? `http://${ctx.infra.publicIp}/health -> 200 (simulated, not a real address)` : 'no website deployed' },
      ];
      for (const c of checks) log.info(`Status ${c.name}: ${c.ok ? 'OK' : 'NOT OK'} — ${c.detail}`);
      return { checks };
    },

    async restart(ctx) {
      const log = sim(ctx);
      log.info('$ docker restart sample-app');
      await delay(0.5);
      maybeFail('restart');
      const url = `http://${ctx.infra.publicIp}`;
      log.info(`Public health check ${url}/health -> 200 (simulated)`);
      return { url, healthy: true };
    },

    async terminate(ctx) {
      const log = sim(ctx);
      log.info(`Terminating ${ctx.infra.instanceId}`);
      await delay(0.5);
      maybeFail('terminate');
      log.info('Instance terminated; security group, key pair and local key file deleted');
      return { terminated: true };
    },
  };
}
