import 'dotenv/config';

function booleanFromEnv(name, defaultValue) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function integerFromEnv(name, defaultValue, { min = 0 } = {}) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < min) {
    return defaultValue;
  }

  return parsed;
}

const env = {
  PORT: Number(process.env.PORT || 3000),
  DB_HOST: process.env.DB_HOST || '127.0.0.1',
  DB_PORT: Number(process.env.DB_PORT || 3306),
  DB_USER: process.env.DB_USER || 'root',
  DB_PASSWORD: process.env.DB_PASSWORD ?? '',
  DB_NAME: process.env.DB_NAME || 'orchestrator_mvp',
  MASTER_STORAGE_DIR: process.env.MASTER_STORAGE_DIR || 'storage/masters',
  ADMIN_ACCESS_ENABLED: booleanFromEnv('ADMIN_ACCESS_ENABLED', true),
  ADMIN_ACCESS_TOKEN: process.env.ADMIN_ACCESS_TOKEN ?? '',
  SHOPIFY_WEBHOOK_HMAC_REQUIRED: booleanFromEnv(
    'SHOPIFY_WEBHOOK_HMAC_REQUIRED',
    true
  ),
  SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET ?? '',
  SHOPIFY_WEBHOOK_STORE_INVALID: booleanFromEnv(
    'SHOPIFY_WEBHOOK_STORE_INVALID',
    true
  ),
  FTP_UPLOAD_ENABLED: booleanFromEnv('FTP_UPLOAD_ENABLED', false),
  SHOPIFY_WRITE_ENABLED: booleanFromEnv('SHOPIFY_WRITE_ENABLED', false),
  FACTORY_CALLBACK_ENABLED: booleanFromEnv('FACTORY_CALLBACK_ENABLED', true),
  FACTORY_CALLBACK_AUTH_ENABLED: booleanFromEnv(
    'FACTORY_CALLBACK_AUTH_ENABLED',
    true
  ),
  FACTORY_CALLBACK_API_KEY: process.env.FACTORY_CALLBACK_API_KEY ?? '',
  PROCESSING_MIN_FREE_DISK_MB: integerFromEnv(
    'PROCESSING_MIN_FREE_DISK_MB',
    1024,
    { min: 1 }
  ),
  PROCESSING_MAX_ATTEMPTS: integerFromEnv('PROCESSING_MAX_ATTEMPTS', 3, {
    min: 1,
  }),
  PROCESSING_STALE_LOCK_MINUTES: integerFromEnv(
    'PROCESSING_STALE_LOCK_MINUTES',
    30,
    { min: 1 }
  ),
  TMP_RETENTION_DAYS: integerFromEnv('TMP_RETENTION_DAYS', 7, { min: 0 }),
  ARTIFACT_RETENTION_DAYS: integerFromEnv('ARTIFACT_RETENTION_DAYS', 90, {
    min: 0,
  }),
  LOG_REDACT_SECRETS: booleanFromEnv('LOG_REDACT_SECRETS', true),
};

export default env;
