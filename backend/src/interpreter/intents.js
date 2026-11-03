// Table I: the 7 approved intents and the plan shown for each.

export const INTENTS = ['LAUNCH', 'CONFIGURE', 'DEPLOY', 'FULL_DEPLOY', 'STATUS', 'RESTART', 'UNKNOWN'];

export const INTENT_INFO = {
  LAUNCH: { meaning: 'Create the cloud server only', operation: 'launch' },
  CONFIGURE: { meaning: 'Install and verify Docker', operation: 'configure' },
  DEPLOY: { meaning: 'Deploy to a configured server', operation: 'deploy' },
  FULL_DEPLOY: { meaning: 'Deploy my website end to end; finished steps skipped', operation: 'full' },
  STATUS: { meaning: 'Check server, container and website', operation: 'status' },
  RESTART: { meaning: 'Restart the container', operation: 'restart' },
  UNKNOWN: { meaning: 'Anything else, unclear or destructive', operation: null },
};

export const PLANS = {
  LAUNCH: [
    'Run pre-flight checks (identity, instance type, AMI, default VPC, dry run)',
    'Create key pair and security group (SSH from your IP only, HTTP from anywhere)',
    'Launch one EC2 instance (Amazon Linux 2023, IMDSv2)',
    'Wait for "running" and both status checks',
  ],
  CONFIGURE: [
    'Connect over SSH as ec2-user and pin the host key',
    'Update packages and install Docker',
    'Enable Docker and verify it is active',
  ],
  DEPLOY: [
    'Package the sample app and upload it over SFTP',
    'Build the Docker image and run the container on port 80',
    'Check health inside the server and from the public internet',
  ],
  FULL_DEPLOY: [
    'Launch a server (skipped if one is already tracked)',
    'Install Docker (skipped if Docker is already ready)',
    'Deploy the app and verify the public URL',
  ],
  STATUS: ['Check instance state on AWS', 'Check the container over SSH', 'Check website health over HTTP'],
  RESTART: ['Restart the sample-app container', 'Re-check public health'],
  UNKNOWN: [],
};

export const SUPPORTED_ACTIONS = INTENTS.filter((i) => i !== 'UNKNOWN').map((intent) => ({
  intent,
  meaning: INTENT_INFO[intent].meaning,
}));

export function planFor(intent) {
  return PLANS[intent] ? PLANS[intent].slice() : [];
}

export function operationFor(intent) {
  return INTENT_INFO[intent]?.operation ?? null;
}
