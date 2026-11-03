// Rule-based fallback classifier. Destructive or shell-like text always maps to UNKNOWN.

const DESTRUCTIVE = /\b(delete|remove|destroy|terminate|kill|drop|wipe|sudo|rm|rmdir|shutdown|format|erase|purge|nuke|uninstall|halt|poweroff|reboot|stop|truncate|mkfs|chmod|chown|dd)\b/i;
const SHELL_LIKE = /[;&|`$<>\\]|\brm\s+-|\/\s*$|\.\.\//;

const RESTART = /\b(restart|re-start|bounce)\b/i;
const DEPLOY = /\b(deploy|redeploy|ship|release|publish)\b/i;
const LAUNCH = /\b(launch|provision|spin\s+up|create|start|new)\b/i;
const SERVER = /\b(server|instance|machine|vm|ec2|host)\b/i;
const CONFIGURE = /\b(install|configure|set\s*up|setup|prepare)\b/i;
const DOCKER = /\bdocker\b/i;
const STATUS = /\b(status|health|healthy|alive|running|online|uptime|working)\b/i;
const MY_SITE = /\b(my|the)\s+(web\s*site|website|site|app|application|project)\b/i;
const ONLY_DEPLOY = /\b(only|just|existing|already)\b/i;

export function classifyWithRules(input) {
  const text = String(input ?? '').trim();
  if (!text) return { intent: 'UNKNOWN', confidence: 0, reason: 'Empty command.' };

  if (DESTRUCTIVE.test(text) || SHELL_LIKE.test(text)) {
    return {
      intent: 'UNKNOWN',
      confidence: 0.95,
      reason: 'Destructive or shell-like request. Destructive operations are not reachable from command text.',
    };
  }
  if (RESTART.test(text)) {
    return { intent: 'RESTART', confidence: 0.9, reason: 'Asks to restart the app container.' };
  }
  if (DEPLOY.test(text)) {
    const wantsLaunch = LAUNCH.test(text) && SERVER.test(text);
    if (wantsLaunch) {
      return { intent: 'FULL_DEPLOY', confidence: 0.9, reason: 'Asks to launch a server and deploy, end to end.' };
    }
    if (ONLY_DEPLOY.test(text)) {
      return { intent: 'DEPLOY', confidence: 0.85, reason: 'Asks to deploy only, to an existing server.' };
    }
    if (MY_SITE.test(text)) {
      return { intent: 'FULL_DEPLOY', confidence: 0.85, reason: 'Asks to deploy the website end to end.' };
    }
    return { intent: 'DEPLOY', confidence: 0.7, reason: 'Asks to deploy the app.' };
  }
  if (CONFIGURE.test(text) && DOCKER.test(text)) {
    return { intent: 'CONFIGURE', confidence: 0.9, reason: 'Asks to install or configure Docker.' };
  }
  if (LAUNCH.test(text) && SERVER.test(text)) {
    return { intent: 'LAUNCH', confidence: 0.9, reason: 'Asks to create a server only.' };
  }
  if (STATUS.test(text)) {
    return { intent: 'STATUS', confidence: 0.85, reason: 'Asks about server, container or website status.' };
  }
  return { intent: 'UNKNOWN', confidence: 0.2, reason: 'No rule matched this command, so it was not understood.' };
}
