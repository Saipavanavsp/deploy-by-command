// Provider interface shared by the mock and AWS providers.
//
// Every method receives a context:
//   ctx.infra      snapshot of the tracked infrastructure (or null)
//   ctx.log        logger ({info, warn, error})
//   ctx.track(p)   merge p into state.infra and save to disk immediately
//   ctx.clearInfra() forget partially created infrastructure after a rollback
//
// Return values (only real provider results are ever saved):
//   launch    -> { instanceId, publicIp, securityGroupId, keyName, region, instanceType, simulated }
//   configure -> { dockerReady: true, hostKeyFingerprint, dockerVersion }
//   deploy    -> { url, healthy: true }
//   status    -> { checks: [{ name, ok, detail }] }
//   restart   -> { url, healthy: true }
//   terminate -> { terminated: true }
// A method throws on failure; it never reports success it did not observe.

export const PROVIDER_METHODS = ['launch', 'configure', 'deploy', 'status', 'restart', 'terminate'];

export function assertProvider(provider) {
  for (const m of PROVIDER_METHODS) {
    if (typeof provider?.[m] !== 'function') throw new Error(`Provider is missing method "${m}"`);
  }
  return provider;
}
