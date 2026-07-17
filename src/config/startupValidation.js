import env from './env.js';

function hasConfiguredSecret(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateServerStartupEnv(config = env) {
  const errors = [];

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
