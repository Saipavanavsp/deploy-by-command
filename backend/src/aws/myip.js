// Auto-detect the operator's public IP so SSH is opened to "<ip>/32" only.

export async function myPublicIp({ fetch: fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Could not detect your public IP (HTTP ${res.status}). Set SSH_CIDR instead.`);
  const ip = (await res.text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('Public IP lookup returned an unexpected answer. Set SSH_CIDR instead.');
  return ip;
}

export async function myPublicIpCidr(opts) {
  return `${await myPublicIp(opts)}/32`;
}
