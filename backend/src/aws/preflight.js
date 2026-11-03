// Pre-flight: every check must pass before anything is created.
export const AL2023_PARAM = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64';

export function awsClientOptions(cfg) {
  const opts = { region: cfg.region };
  if (cfg.awsProfile) opts.profile = cfg.awsProfile;
  return opts;
}

export async function createAwsClients(cfg) {
  const [ec2sdk, stssdk, ssmsdk] = await Promise.all([
    import('@aws-sdk/client-ec2'),
    import('@aws-sdk/client-sts'),
    import('@aws-sdk/client-ssm'),
  ]);
  const o = awsClientOptions(cfg);
  return {
    sdk: { ec2: ec2sdk, sts: stssdk, ssm: ssmsdk },
    ec2: new ec2sdk.EC2Client(o),
    sts: new stssdk.STSClient(o),
    ssm: new ssmsdk.SSMClient(o),
  };
}

async function check(checks, name, fn, log) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
    log.info(`Pre-flight ${name}: OK — ${detail}`);
  } catch (err) {
    const detail = err?.message || String(err);
    checks.push({ name, ok: false, detail });
    log.error(`Pre-flight ${name}: FAILED — ${detail}`);
  }
}

export async function preflight({ clients, cfg, log }) {
  const { sdk, ec2, sts, ssm } = clients;
  const checks = [];
  let amiId = null;
  let vpcId = null;

  await check(checks, 'identity', async () => {
    const id = await sts.send(new sdk.sts.GetCallerIdentityCommand({}));
    const acct = String(id.Account || '');
    return `credentials valid for account ****${acct.slice(-4)}`;
  }, log);

  await check(checks, 'instance type', async () => {
    const out = await ec2.send(new sdk.ec2.DescribeInstanceTypeOfferingsCommand({
      LocationType: 'region',
      Filters: [{ Name: 'instance-type', Values: [cfg.instanceType] }],
    }));
    if (!out.InstanceTypeOfferings?.length) throw new Error(`${cfg.instanceType} is not offered in ${cfg.region}`);
    return `${cfg.instanceType} is offered in ${cfg.region}`;
  }, log);

  await check(checks, 'AMI', async () => {
    const out = await ssm.send(new sdk.ssm.GetParameterCommand({ Name: AL2023_PARAM }));
    amiId = out.Parameter?.Value;
    if (!amiId) throw new Error('AL2023 AMI parameter returned no value');
    return `latest Amazon Linux 2023 AMI is ${amiId}`;
  }, log);

  await check(checks, 'default VPC', async () => {
    const out = await ec2.send(new sdk.ec2.DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }));
    vpcId = out.Vpcs?.[0]?.VpcId;
    if (!vpcId) throw new Error(`no default VPC in ${cfg.region}`);
    return `default VPC ${vpcId}`;
  }, log);

  await check(checks, 'dry run', async () => {
    if (!amiId) throw new Error('skipped: no AMI');
    try {
      await ec2.send(new sdk.ec2.RunInstancesCommand({
        DryRun: true, ImageId: amiId, InstanceType: cfg.instanceType, MinCount: 1, MaxCount: 1,
      }));
    } catch (err) {
      if (err?.name === 'DryRunOperation' || err?.Code === 'DryRunOperation') return 'RunInstances permitted (DryRunOperation)';
      throw err;
    }
    throw new Error('dry run unexpectedly succeeded without DryRunOperation');
  }, log);

  return { ok: checks.every((c) => c.ok), checks, amiId, vpcId };
}
