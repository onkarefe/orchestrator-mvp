import env from './env.js';
import {
  isSupportedFtpProtocol,
  normalizeFtpProtocol,
  normalizeFtpRemoteDir,
  normalizeFtpTempSuffix,
} from './ftpUpload.js';
import {
  normalizeShopifyAdminApiVersion,
  normalizeShopifyShopDomain,
  parseShopifyWriteOrderAllowlist,
} from './shopifyAdmin.js';

function hasConfiguredSecret(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateFtpUploadStartupEnv(config = env) {
  const errors = [];

  if (!config.FTP_UPLOAD_ENABLED) {
    return true;
  }

  const protocol = normalizeFtpProtocol(config.FTP_PROTOCOL);
  if (!isSupportedFtpProtocol(protocol)) {
    errors.push(
      protocol === 'sftp'
        ? 'unsupported_protocol: FTP_PROTOCOL=sftp is not supported'
        : 'unsupported_protocol: FTP_PROTOCOL must be ftp or ftps'
    );
  }

  if (!hasConfiguredSecret(config.FTP_HOST)) {
    errors.push('FTP_HOST is required when FTP_UPLOAD_ENABLED=true');
  }

  if (!hasConfiguredSecret(config.FTP_USERNAME)) {
    errors.push('FTP_USERNAME is required when FTP_UPLOAD_ENABLED=true');
  }

  if (!hasConfiguredSecret(config.FTP_PASSWORD)) {
    errors.push('FTP_PASSWORD is required when FTP_UPLOAD_ENABLED=true');
  }

  if (!normalizeFtpRemoteDir(config.FTP_REMOTE_DIR)) {
    errors.push(
      'FTP_REMOTE_DIR must be a non-empty safe FTP directory when FTP_UPLOAD_ENABLED=true'
    );
  }

  if (String(config.FTP_UPLOAD_MODE ?? '').trim().toLowerCase() !== 'files') {
    errors.push(
      'FTP_UPLOAD_MODE=files is required when FTP_UPLOAD_ENABLED=true'
    );
  }

  if (!normalizeFtpTempSuffix(config.FTP_TEMP_SUFFIX)) {
    errors.push(
      'FTP_TEMP_SUFFIX must be a non-empty filename suffix without path separators'
    );
  }

  if (config.FTP_PASSIVE !== true) {
    errors.push(
      'FTP_PASSIVE=true is required because active FTP mode is not supported'
    );
  }

  if (errors.length) {
    const error = new Error(
      `Unsafe FTP upload configuration: ${errors.join('; ')}`
    );
    error.code = 'UNSAFE_FTP_UPLOAD_CONFIGURATION';
    error.validationErrors = errors;
    throw error;
  }

  return true;
}

export function validateWallpaperSkuStartupEnv(config = env) {
  const wallpaperSkus = Array.isArray(config.WALLPAPER_SKUS)
    ? config.WALLPAPER_SKUS.filter(
        (sku) => typeof sku === 'string' && sku.trim().length > 0
      )
    : [];

  if (wallpaperSkus.length === 0) {
    const error = new Error(
      'Unsafe wallpaper configuration: WALLPAPER_SKUS must contain at least one exact SKU'
    );
    error.code = 'UNSAFE_WALLPAPER_SKU_CONFIGURATION';
    error.validationErrors = [
      'WALLPAPER_SKUS must contain at least one exact SKU',
    ];
    throw error;
  }

  return true;
}

export function validateShopifyWebhookStartupEnv(config = env) {
  const errors = [];

  if (
    config.SHOPIFY_WEBHOOK_HMAC_REQUIRED &&
    !hasConfiguredSecret(config.SHOPIFY_WEBHOOK_SECRET)
  ) {
    errors.push(
      'SHOPIFY_WEBHOOK_SECRET is required when SHOPIFY_WEBHOOK_HMAC_REQUIRED=true'
    );
  }

  if (!normalizeShopifyShopDomain(config.SHOPIFY_SHOP_DOMAIN)) {
    errors.push(
      'A valid SHOPIFY_SHOP_DOMAIN ending in .myshopify.com is required for Shopify webhook source validation'
    );
  }

  if (errors.length) {
    const error = new Error(
      `Unsafe Shopify webhook configuration: ${errors.join('; ')}`
    );
    error.code = 'UNSAFE_SHOPIFY_WEBHOOK_CONFIGURATION';
    error.validationErrors = errors;
    throw error;
  }

  return true;
}

export function validateServerStartupEnv(config = env) {
  const errors = [];
  const allowlist = parseShopifyWriteOrderAllowlist(
    config.SHOPIFY_WRITE_ORDER_ALLOWLIST
  );
  const invalidAllowlistEntries = [
    ...allowlist.invalidEntries,
    ...(config.SHOPIFY_WRITE_ORDER_ALLOWLIST_INVALID_ENTRIES ?? []),
  ];

  try {
    validateWallpaperSkuStartupEnv(config);
  } catch (error) {
    errors.push(...(error.validationErrors ?? [error.message]));
  }

  try {
    validateShopifyWebhookStartupEnv(config);
  } catch (error) {
    errors.push(...(error.validationErrors ?? [error.message]));
  }

  if (
    config.FACTORY_CALLBACK_ENABLED &&
    config.FACTORY_CALLBACK_AUTH_ENABLED &&
    !hasConfiguredSecret(config.FACTORY_CALLBACK_API_KEY)
  ) {
    errors.push(
      'FACTORY_CALLBACK_API_KEY is required when the factory callback endpoint and authentication are enabled'
    );
  }

  if (
    config.NEXO_CALLBACK_ENABLED &&
    config.NEXO_CALLBACK_AUTH_ENABLED &&
    !hasConfiguredSecret(config.NEXO_CALLBACK_API_KEY)
  ) {
    errors.push(
      'NEXO_CALLBACK_API_KEY is required when the NEXO callback endpoint and authentication are enabled'
    );
  }

  if (config.SHOPIFY_UPDATE_EXECUTOR_ENABLED) {
    if (!normalizeShopifyShopDomain(config.SHOPIFY_SHOP_DOMAIN)) {
      errors.push(
        'A valid SHOPIFY_SHOP_DOMAIN ending in .myshopify.com is required when SHOPIFY_UPDATE_EXECUTOR_ENABLED=true'
      );
    }

    if (!normalizeShopifyAdminApiVersion(config.SHOPIFY_ADMIN_API_VERSION)) {
      errors.push(
        'A valid SHOPIFY_ADMIN_API_VERSION in YYYY-MM format is required when SHOPIFY_UPDATE_EXECUTOR_ENABLED=true'
      );
    }

    if (!hasConfiguredSecret(config.SHOPIFY_CLIENT_ID)) {
      errors.push(
        'SHOPIFY_CLIENT_ID is required when SHOPIFY_UPDATE_EXECUTOR_ENABLED=true'
      );
    }

    if (!hasConfiguredSecret(config.SHOPIFY_CLIENT_SECRET)) {
      errors.push(
        'SHOPIFY_CLIENT_SECRET is required when SHOPIFY_UPDATE_EXECUTOR_ENABLED=true'
      );
    }
  }

  if (config.SHOPIFY_WRITE_ENABLED) {
    if (config.SHOPIFY_UPDATE_EXECUTOR_ENABLED !== true) {
      errors.push(
        'SHOPIFY_UPDATE_EXECUTOR_ENABLED=true is required when SHOPIFY_WRITE_ENABLED=true'
      );
    }

    if (invalidAllowlistEntries.length > 0) {
      errors.push(
        'SHOPIFY_WRITE_ORDER_ALLOWLIST must contain only numeric Shopify order IDs when SHOPIFY_WRITE_ENABLED=true'
      );
    }

    if (
      allowlist.orderIds.length === 0 &&
      config.SHOPIFY_WRITE_ALLOW_ALL_ORDERS !== true
    ) {
      errors.push(
        'SHOPIFY_WRITE_ORDER_ALLOWLIST must contain at least one numeric Shopify order ID unless SHOPIFY_WRITE_ALLOW_ALL_ORDERS=true'
      );
    }

    if (
      allowlist.orderIds.length > 0 &&
      config.SHOPIFY_WRITE_ALLOW_ALL_ORDERS === true
    ) {
      errors.push(
        'SHOPIFY_WRITE_ALLOW_ALL_ORDERS=true and SHOPIFY_WRITE_ORDER_ALLOWLIST are mutually exclusive'
      );
    }
  }

  try {
    validateFtpUploadStartupEnv(config);
  } catch (error) {
    errors.push(...(error.validationErrors ?? [error.message]));
  }

  if (errors.length) {
    const error = new Error(`Unsafe startup configuration: ${errors.join('; ')}`);
    error.code = 'UNSAFE_STARTUP_CONFIGURATION';
    error.validationErrors = errors;
    throw error;
  }

  return true;
}

export function getSafeStartupConfigSummary(config = env) {
  return {
    adminAccessEnabled: Boolean(config.ADMIN_ACCESS_ENABLED),
    shopifyWebhookHmacRequired: Boolean(
      config.SHOPIFY_WEBHOOK_HMAC_REQUIRED
    ),
    shopifyWebhookStoreInvalid: Boolean(config.SHOPIFY_WEBHOOK_STORE_INVALID),
    shopifyWebhookMaxAttempts:
      Number(config.SHOPIFY_WEBHOOK_MAX_ATTEMPTS) || 0,
    shopifyWebhookStaleLockMinutes:
      Number(config.SHOPIFY_WEBHOOK_STALE_LOCK_MINUTES) || 0,
    factoryCallbackEnabled: Boolean(config.FACTORY_CALLBACK_ENABLED),
    factoryCallbackAuthEnabled: Boolean(config.FACTORY_CALLBACK_AUTH_ENABLED),
    nexoCallbackEnabled: Boolean(config.NEXO_CALLBACK_ENABLED),
    nexoCallbackAuthEnabled: Boolean(config.NEXO_CALLBACK_AUTH_ENABLED),
    ftpUploadEnabled: Boolean(config.FTP_UPLOAD_ENABLED),
    ftpProtocolSupported: isSupportedFtpProtocol(config.FTP_PROTOCOL),
    ftpSecure: Boolean(
      config.FTP_SECURE || normalizeFtpProtocol(config.FTP_PROTOCOL) === 'ftps'
    ),
    ftpPassive: Boolean(config.FTP_PASSIVE),
    ftpHostConfigured: Boolean(hasConfiguredSecret(config.FTP_HOST)),
    ftpCredentialsConfigured: Boolean(
      hasConfiguredSecret(config.FTP_USERNAME) &&
        hasConfiguredSecret(config.FTP_PASSWORD)
    ),
    ftpRemoteDirConfigured: Boolean(
      normalizeFtpRemoteDir(config.FTP_REMOTE_DIR)
    ),
    ftpUploadTaskMaxAttempts:
      Number(config.FTP_UPLOAD_TASK_MAX_ATTEMPTS) || 0,
    shopifyWriteEnabled: Boolean(config.SHOPIFY_WRITE_ENABLED),
    shopifyWriteAllowAllOrders:
      config.SHOPIFY_WRITE_ALLOW_ALL_ORDERS === true,
    shopifyUpdateExecutorEnabled: Boolean(
      config.SHOPIFY_UPDATE_EXECUTOR_ENABLED
    ),
    shopifyAdminCredentialsConfigured: Boolean(
      hasConfiguredSecret(config.SHOPIFY_CLIENT_ID) &&
        hasConfiguredSecret(config.SHOPIFY_CLIENT_SECRET)
    ),
    shopifyShopDomainConfigured: Boolean(
      normalizeShopifyShopDomain(config.SHOPIFY_SHOP_DOMAIN)
    ),
    shopifyWriteOrderAllowlistCount: parseShopifyWriteOrderAllowlist(
      config.SHOPIFY_WRITE_ORDER_ALLOWLIST
    ).orderIds.length,
    shopifyFulfillmentNotifyCustomer: Boolean(
      config.SHOPIFY_FULFILLMENT_NOTIFY_CUSTOMER
    ),
    shopifyUpdateTaskBatchSize:
      Number(config.SHOPIFY_UPDATE_TASK_BATCH_SIZE) || 0,
    shopifyUpdateTaskMaxAttempts:
      Number(config.SHOPIFY_UPDATE_TASK_MAX_ATTEMPTS) || 0,
    wallpaperSkuCount: config.WALLPAPER_SKUS?.length ?? 0,
    accessorySkuCount: config.ACCESSORY_SKUS?.length ?? 0,
    configuratorMaxOutputWidthMm: config.CONFIGURATOR_MAX_OUTPUT_WIDTH_MM,
    configuratorMaxOutputHeightMm: config.CONFIGURATOR_MAX_OUTPUT_HEIGHT_MM,
    configuratorMaxOutputAreaM2: config.CONFIGURATOR_MAX_OUTPUT_AREA_M2,
  };
}

export default {
  getSafeStartupConfigSummary,
  validateFtpUploadStartupEnv,
  validateServerStartupEnv,
  validateShopifyWebhookStartupEnv,
  validateWallpaperSkuStartupEnv,
};
