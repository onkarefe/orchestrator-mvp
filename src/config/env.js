import 'dotenv/config';

import { parseShopifyWriteOrderAllowlist } from './shopifyAdmin.js';

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

function exactTrueBooleanFromEnv(name) {
  return process.env[name] === 'true';
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

function positiveNumberFromEnv(name, defaultValue) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function positiveIntegerFromEnv(name, defaultValue) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim();

  if (!/^[1-9][0-9]*$/.test(normalized)) {
    return defaultValue;
  }

  const parsed = Number(normalized);

  return Number.isSafeInteger(parsed) ? parsed : defaultValue;
}

function csvFromEnv(name, defaultValue = []) {
  const value = process.env[name];

  if (value === undefined || value === null || String(value).trim() === '') {
    return [...defaultValue];
  }

  const values = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return values.length ? values : [...defaultValue];
}

function stringFromEnv(name, defaultValue = '') {
  const value = String(process.env[name] ?? '').trim();

  return value || defaultValue;
}

const shopifyWriteOrderAllowlist = parseShopifyWriteOrderAllowlist(
  process.env.SHOPIFY_WRITE_ORDER_ALLOWLIST
);
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
  ADMIN_COOKIE_SECURE: booleanFromEnv('ADMIN_COOKIE_SECURE', true),
  ADMIN_SESSION_TTL_HOURS: integerFromEnv('ADMIN_SESSION_TTL_HOURS', 12, {
    min: 1,
  }),
  ADMIN_LOGIN_MAX_ATTEMPTS: integerFromEnv('ADMIN_LOGIN_MAX_ATTEMPTS', 5, {
    min: 1,
  }),
  ADMIN_LOGIN_WINDOW_MINUTES: integerFromEnv(
    'ADMIN_LOGIN_WINDOW_MINUTES',
    15,
    { min: 1 }
  ),
  SHOPIFY_WEBHOOK_HMAC_REQUIRED: booleanFromEnv(
    'SHOPIFY_WEBHOOK_HMAC_REQUIRED',
    true
  ),
  SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET ?? '',
  SHOPIFY_WEBHOOK_STORE_INVALID: booleanFromEnv(
    'SHOPIFY_WEBHOOK_STORE_INVALID',
    true
  ),
  WALLPAPER_SKUS: csvFromEnv('WALLPAPER_SKUS', []),
  ACCESSORY_SKUS: csvFromEnv('ACCESSORY_SKUS', []),
  CONFIGURATOR_MAX_OUTPUT_WIDTH_MM: positiveNumberFromEnv(
    'CONFIGURATOR_MAX_OUTPUT_WIDTH_MM',
    20000
  ),
  CONFIGURATOR_MAX_OUTPUT_HEIGHT_MM: positiveNumberFromEnv(
    'CONFIGURATOR_MAX_OUTPUT_HEIGHT_MM',
    5000
  ),
  CONFIGURATOR_MAX_OUTPUT_AREA_M2: positiveNumberFromEnv(
    'CONFIGURATOR_MAX_OUTPUT_AREA_M2',
    100
  ),
  FTP_UPLOAD_ENABLED: booleanFromEnv('FTP_UPLOAD_ENABLED', false),
  FTP_PROTOCOL: stringFromEnv('FTP_PROTOCOL', 'ftp').toLowerCase(),
  FTP_HOST: stringFromEnv('FTP_HOST'),
  FTP_PORT: positiveIntegerFromEnv('FTP_PORT', 21),
  FTP_USERNAME: stringFromEnv('FTP_USERNAME'),
  FTP_PASSWORD: process.env.FTP_PASSWORD ?? '',
  FTP_REMOTE_DIR: stringFromEnv('FTP_REMOTE_DIR'),
  FTP_PASSIVE: booleanFromEnv('FTP_PASSIVE', true),
  FTP_SECURE: booleanFromEnv('FTP_SECURE', false),
  FTP_UPLOAD_MODE: stringFromEnv('FTP_UPLOAD_MODE', 'files').toLowerCase(),
  FTP_TEMP_SUFFIX: stringFromEnv('FTP_TEMP_SUFFIX', '.uploading'),
  FTP_UPLOAD_TASK_MAX_ATTEMPTS: positiveIntegerFromEnv(
    'FTP_UPLOAD_TASK_MAX_ATTEMPTS',
    3
  ),
  FTP_UPLOAD_CONNECT_TIMEOUT_MS: positiveIntegerFromEnv(
    'FTP_UPLOAD_CONNECT_TIMEOUT_MS',
    30000
  ),
  FTP_UPLOAD_TRANSFER_TIMEOUT_MS: positiveIntegerFromEnv(
    'FTP_UPLOAD_TRANSFER_TIMEOUT_MS',
    120000
  ),
  SHOPIFY_SHOP_DOMAIN: process.env.SHOPIFY_SHOP_DOMAIN ?? '',
  SHOPIFY_ADMIN_API_VERSION:
    process.env.SHOPIFY_ADMIN_API_VERSION || '2026-01',
  SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID ?? '',
  SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET ?? '',
  SHOPIFY_WRITE_ENABLED: booleanFromEnv('SHOPIFY_WRITE_ENABLED', false),
  SHOPIFY_WRITE_ALLOW_ALL_ORDERS: exactTrueBooleanFromEnv(
    'SHOPIFY_WRITE_ALLOW_ALL_ORDERS'
  ),
  SHOPIFY_WRITE_ORDER_ALLOWLIST: shopifyWriteOrderAllowlist.orderIds,
  SHOPIFY_WRITE_ORDER_ALLOWLIST_INVALID_ENTRIES:
    shopifyWriteOrderAllowlist.invalidEntries,
  SHOPIFY_FULFILLMENT_NOTIFY_CUSTOMER: booleanFromEnv(
    'SHOPIFY_FULFILLMENT_NOTIFY_CUSTOMER',
    false
  ),
  SHOPIFY_UPDATE_EXECUTOR_ENABLED: booleanFromEnv(
    'SHOPIFY_UPDATE_EXECUTOR_ENABLED',
    false
  ),
  SHOPIFY_UPDATE_TASK_BATCH_SIZE: positiveIntegerFromEnv(
    'SHOPIFY_UPDATE_TASK_BATCH_SIZE',
    5
  ),
  SHOPIFY_UPDATE_TASK_MAX_ATTEMPTS: positiveIntegerFromEnv(
    'SHOPIFY_UPDATE_TASK_MAX_ATTEMPTS',
    3
  ),
  SHOPIFY_UPDATE_POLL_INTERVAL_MS: integerFromEnv(
    'SHOPIFY_UPDATE_POLL_INTERVAL_MS',
    3000,
    { min: 1000 }
  ),
  FACTORY_CALLBACK_ENABLED: booleanFromEnv('FACTORY_CALLBACK_ENABLED', true),
  FACTORY_CALLBACK_AUTH_ENABLED: booleanFromEnv(
    'FACTORY_CALLBACK_AUTH_ENABLED',
    true
  ),
  FACTORY_CALLBACK_API_KEY: process.env.FACTORY_CALLBACK_API_KEY ?? '',
  NEXO_CALLBACK_ENABLED: booleanFromEnv('NEXO_CALLBACK_ENABLED', false),
  NEXO_CALLBACK_AUTH_ENABLED: booleanFromEnv(
    'NEXO_CALLBACK_AUTH_ENABLED',
    true
  ),
  NEXO_CALLBACK_API_KEY: process.env.NEXO_CALLBACK_API_KEY ?? '',
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
  WORKER_RECOVERY_INTERVAL_MS: integerFromEnv(
    'WORKER_RECOVERY_INTERVAL_MS',
    60000,
    { min: 1000 }
  ),
  WORKER_RECOVERY_BATCH_SIZE: integerFromEnv(
    'WORKER_RECOVERY_BATCH_SIZE',
    25,
    { min: 1 }
  ),
  TMP_RETENTION_DAYS: integerFromEnv('TMP_RETENTION_DAYS', 7, { min: 0 }),
  ARTIFACT_RETENTION_DAYS: integerFromEnv('ARTIFACT_RETENTION_DAYS', 90, {
    min: 0,
  }),
  LOG_REDACT_SECRETS: booleanFromEnv('LOG_REDACT_SECRETS', true),
};

export default env;
