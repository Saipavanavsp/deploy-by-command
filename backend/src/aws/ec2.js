// EC2 resource helpers: key pair, security group, instance, waits, teardown.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../errors.js';

export const PROJECT_TAG = { Key: 'Project', Value: 'deploy-by-command' };

export async function createKeyPair({ clients, keysDir, log }) {
  const { ec2, sdk } = clients;
  const keyName = `deploy-by-command-${Date.now()}`;
  const out = await ec2.send(new sdk.ec2.CreateKeyPairCommand({
    KeyName: keyName,
    KeyType: 'ed25519',
    KeyFormat: 'pem',
    TagSpecifications: [{ ResourceType: 'key-pair', Tags: [PROJECT_TAG] }],
  }));
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(keysDir, `${keyName}.pem`);
  fs.writeFileSync(keyPath, out.KeyMaterial, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* not supported on every filesystem */ }
  log.info(`Created ed25519 key pair ${keyName}; private key saved locally with permissions 600`);
  return { keyName, keyPath };
}

export async function createSecurityGroup({ clients, vpcId, log }) {
  const { ec2, sdk } = clients;
  const out = await ec2.send(new sdk.ec2.CreateSecurityGroupCommand({
    GroupName: `deploy-by-command-${Date.now()}`,
    Description: 'Deploy by Command: SSH from operator IP, HTTP from anywhere',
    VpcId: vpcId,
    TagSpecifications: [{ ResourceType: 'security-group', Tags: [PROJECT_TAG] }],
  }));
  log.info(`Created security group ${out.GroupId}`);
  return out.GroupId;
}

export async function allowIngress({ clients, groupId, port, cidr, description, log }) {
  const { ec2, sdk } = clients;
  await ec2.send(new sdk.ec2.AuthorizeSecurityGroupIngressCommand({
    GroupId: groupId,
    IpPermissions: [{ IpProtocol: 'tcp', FromPort: port, ToPort: port, IpRanges: [{ CidrIp: cidr, Description: description }] }],
  }));
  log.info(`Security group ${groupId}: allow TCP ${port} from ${cidr}`);
}

export async function runInstance({ clients, amiId, instanceType, keyName, groupId, log }) {
  const { ec2, sdk } = clients;
  const out = await ec2.send(new sdk.ec2.RunInstancesCommand({
    ImageId: amiId,
    InstanceType: instanceType,
    KeyName: keyName,
    SecurityGroupIds: [groupId],
    MinCount: 1,
    MaxCount: 1,
    MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled' },
    TagSpecifications: [{ ResourceType: 'instance', Tags: [PROJECT_TAG, { Key: 'Name', Value: 'deploy-by-command' }] }],
  }));
  const id = out.Instances?.[0]?.InstanceId;
  if (!id) throw new Error('RunInstances returned no instance ID');
  log.info(`RunInstances accepted: ${id} (${instanceType}, IMDSv2 required, tag Project=deploy-by-command)`);
  return id;
}

export async function waitRunning({ clients, instanceId, log }) {
  const { ec2, sdk } = clients;
  log.info(`Waiting for ${instanceId} to reach "running"`);
  await sdk.ec2.waitUntilInstanceRunning({ client: ec2, maxWaitTime: 300 }, { InstanceIds: [instanceId] });
  log.info(`${instanceId} is running; waiting for both EC2 status checks`);
  await sdk.ec2.waitUntilInstanceStatusOk({ client: ec2, maxWaitTime: 900 }, { InstanceIds: [instanceId] });
  log.info(`${instanceId}: both status checks passed`);
}

export async function describeInstance({ clients, instanceId }) {
  const { ec2, sdk } = clients;
  const out = await ec2.send(new sdk.ec2.DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const inst = out.Reservations?.[0]?.Instances?.[0];
  return { state: inst?.State?.Name || 'unknown', publicIp: inst?.PublicIpAddress || null };
}

async function deleteSecurityGroup({ clients, groupId, log }) {
  const { ec2, sdk } = clients;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await ec2.send(new sdk.ec2.DeleteSecurityGroupCommand({ GroupId: groupId }));
      log.info(`Deleted security group ${groupId}`);
      return;
    } catch (err) {
      if (err?.name !== 'DependencyViolation' || attempt === 10) throw err;
      await sleep(6000); // network interface still detaching
    }
  }
}

async function deleteKey({ clients, keyName, keyPath, log }) {
  const { ec2, sdk } = clients;
  if (keyName) {
    await ec2.send(new sdk.ec2.DeleteKeyPairCommand({ KeyName: keyName }));
    log.info(`Deleted key pair ${keyName}`);
  }
  if (keyPath && fs.existsSync(keyPath)) {
    fs.unlinkSync(keyPath);
    log.info('Deleted local private key file');
  }
}

// Used when launch fails before an instance exists.
export async function rollback({ clients, groupId, keyName, keyPath, log }) {
  const problems = [];
  if (groupId) {
    try { await deleteSecurityGroup({ clients, groupId, log }); } catch (e) { problems.push(`security group ${groupId}: ${e.message}`); }
  }
  try { await deleteKey({ clients, keyName, keyPath, log }); } catch (e) { problems.push(`key pair ${keyName}: ${e.message}`); }
  if (problems.length) log.error(`Rollback incomplete — delete manually: ${problems.join('; ')}`);
  else log.info('Rollback complete: nothing was left behind');
  return problems.length === 0;
}

// Terminate -> wait terminated -> delete SG -> delete key pair -> delete local key file.
export async function terminateAll({ clients, infra, log }) {
  const { ec2, sdk } = clients;
  if (infra.instanceId) {
    await ec2.send(new sdk.ec2.TerminateInstancesCommand({ InstanceIds: [infra.instanceId] }));
    log.info(`Terminate requested for ${infra.instanceId}; waiting until terminated`);
    await sdk.ec2.waitUntilInstanceTerminated({ client: ec2, maxWaitTime: 900 }, { InstanceIds: [infra.instanceId] });
    log.info(`${infra.instanceId} terminated`);
  }
  if (infra.securityGroupId) await deleteSecurityGroup({ clients, groupId: infra.securityGroupId, log });
  await deleteKey({ clients, keyName: infra.keyName, keyPath: infra.keyPath, log });
}
