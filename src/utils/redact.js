import env from '../config/env.js';

export const REDACTED_VALUE = '[REDACTED]';
export const CIRCULAR_VALUE = '[Circular]';

const EXACT_SENSITIVE_KEYS = Object.freeze(
  new Set([
    'authorization',
    'cookie',
    'set_cookie',
    'x_shopify_hmac_sha256',
    'x_shopify_access_token',
    'api_key',
    'apikey',
    'access_token',
    'refresh_token',
    'ftp_password',
    'db_password',
  ])
);

const SENSITIVE_KEY_FRAGMENTS = Object.freeze([
  'token',
  'secret',
  'password',
]);

function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/[-\s]+/g, '_');
}

export function isSensitiveKey(key) {
  const normalizedKey = normalizeKey(key);

  return (
    EXACT_SENSITIVE_KEYS.has(normalizedKey) ||
    SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
      normalizedKey.includes(fragment)
    )
  );
}

function errorToObject(error) {
  if (!(error instanceof Error)) {
    return error;
  }

  const result = {
    name: error.name,
    message: error.message,
  };

  if (error.code !== undefined) {
    result.code = error.code;
  }

  if (error.stack) {
    result.stack = error.stack;
  }

  for (const [key, value] of Object.entries(error)) {
    result[key] = value;
  }

  if (error.cause !== undefined) {
    result.cause = error.cause;
  }

  return result;
}

function cloneWithOptionalRedaction(value, { redactSecrets }, seen) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  const normalizedValue = errorToObject(value);

  if (
    normalizedValue === null ||
    normalizedValue === undefined ||
    typeof normalizedValue !== 'object'
  ) {
    return normalizedValue;
  }

  if (normalizedValue instanceof Date) {
    return new Date(normalizedValue.getTime());
  }

  if (seen.has(normalizedValue)) {
    return CIRCULAR_VALUE;
  }

  const result = Array.isArray(normalizedValue) ? [] : {};
  seen.set(normalizedValue, result);

  if (Array.isArray(normalizedValue)) {
    for (const item of normalizedValue) {
      result.push(cloneWithOptionalRedaction(item, { redactSecrets }, seen));
    }

    return result;
  }

  for (const [key, childValue] of Object.entries(normalizedValue)) {
    result[key] =
      redactSecrets && isSensitiveKey(key)
        ? REDACTED_VALUE
        : cloneWithOptionalRedaction(childValue, { redactSecrets }, seen);
  }

  return result;
}

export function redact(value, options = {}) {
  const redactSecrets = options.redactSecrets ?? env.LOG_REDACT_SECRETS;

  return cloneWithOptionalRedaction(
    value,
    { redactSecrets },
    new WeakMap()
  );
}

export function safeErrorForLog(error) {
  return redact(errorToObject(error), { redactSecrets: true });
}

export default {
  REDACTED_VALUE,
  CIRCULAR_VALUE,
  isSensitiveKey,
  redact,
  safeErrorForLog,
};
