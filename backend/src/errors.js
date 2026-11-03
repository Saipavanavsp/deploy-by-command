// Shared error type and credential redaction.

export class AppError extends Error {
  constructor(code, message, status = 400, cause) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

// Replace every known secret and anything that looks like a credential.
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) {
    if (secret && String(secret).length >= 4) s = s.split(String(secret)).join('[REDACTED]');
  }
  s = s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]'); // Google API keys
  s = s.replace(/([?&](?:key|api_key|token|access_token)=)[^&\s"']+/gi, '$1[REDACTED]');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1[REDACTED]');
  s = s.replace(/(aws_secret_access_key\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
  return s;
}

export function causeOf(err) {
  if (!err) return null;
  const c = err.cause;
  if (!c) return err.code || err.name || null;
  return typeof c === 'string' ? c : c.message || c.code || String(c);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
