import env from './env.js';
import {
  normalizeShopifyAdminApiVersion,
  normalizeShopifyShopDomain,
  parseShopifyWriteOrderAllowlist,
} from './shopifyAdmin.js';

function hasConfiguredSecret(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

  if (
    config.SHOPIFY_WEBHOOK_HMAC_REQUIRED &&
    !hasConfiguredSecret(config.SHOPIFY_WEBHOOK_SECRET)
  ) {
    errors.push(
      'SHOPIFY_WEBHOOK_SECRET is required when SHOPIFY_WEBHOOK_HMAC_REQUIRED=true'
    );
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
    if (invalidAllowlistEntries.length > 0) {
      errors.push(
        'SHOPIFY_WRITE_ORDER_ALLOWLIST must contain only numeric Shopify order IDs when SHOPIFY_WRITE_ENABLED=true'
      );
    }

    if (allowlist.orderIds.length === 0) {
      errors.push(
        'SHOPIFY_WRITE_ORDER_ALLOWLIST must contain at least one numeric Shopify order ID when SHOPIFY_WRITE_ENABLED=true'
      );
    }
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
    factoryCallbackEnabled: Boolean(config.FACTORY_CALLBACK_ENABLED),
    factoryCallbackAuthEnabled: Boolean(config.FACTORY_CALLBACK_AUTH_ENABLED),
    nexoCallbackEnabled: Boolean(config.NEXO_CALLBACK_ENABLED),
    nexoCallbackAuthEnabled: Boolean(config.NEXO_CALLBACK_AUTH_ENABLED),
    ftpUploadEnabled: Boolean(config.FTP_UPLOAD_ENABLED),
    shopifyWriteEnabled: Boolean(config.SHOPIFY_WRITE_ENABLED),
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
    configuratorRequiredSkuPrefixCount:
      config.CONFIGURATOR_REQUIRED_SKU_PREFIXES?.length ?? 0,
    configuratorMaxOutputWidthMm: config.CONFIGURATOR_MAX_OUTPUT_WIDTH_MM,
    configuratorMaxOutputHeightMm: config.CONFIGURATOR_MAX_OUTPUT_HEIGHT_MM,
    configuratorMaxOutputAreaM2: config.CONFIGURATOR_MAX_OUTPUT_AREA_M2,
  };
}

export default {
  getSafeStartupConfigSummary,
  validateServerStartupEnv,
};
