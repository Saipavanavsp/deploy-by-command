// Thin client for the backend API. Errors carry the backend's plain-English message.
export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the backend. Is it running on 127.0.0.1:4000?', 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new ApiError(data?.error?.code || `HTTP_${res.status}`, data?.error?.message || `Request failed with HTTP ${res.status}.`, res.status);
  }
  return data;
}

export const api = {
  health: () => call('GET', '/health'),
  state: () => call('GET', '/state'),
  logs: (since) => call('GET', `/logs?since=${since}`),
  command: (text) => call('POST', '/command', { text }),
  launch: () => call('POST', '/launch', {}),
  configure: () => call('POST', '/configure', {}),
  deploy: () => call('POST', '/deploy', {}),
  full: () => call('POST', '/full', {}),
  status: () => call('GET', '/status'),
  restart: () => call('POST', '/restart', {}),
  terminate: (confirm) => call('POST', '/terminate', { confirm }),
  cloudflare: () => call('POST', '/cloudflare', {}),
};

// Interpreted operation -> API call.
export const OPERATION_CALLS = {
  launch: api.launch,
  configure: api.configure,
  deploy: api.deploy,
  full: api.full,
  status: api.status,
  restart: api.restart,
};
