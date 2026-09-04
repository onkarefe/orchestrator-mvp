import env from '../config/env.js';
import {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_REASONS,
  LINE_ITEM_ROUTING_STATES,
} from '../constants/lineItemRouting.js';
import {
  isConfiguratorSkuRequired,
  validateConfiguratorLineItem,
} from './PreflightValidationService.js';

function normalizeSku(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function isAccessorySku(
  sku,
  accessorySkus = env.ACCESSORY_SKUS
) {
  const normalizedSku = normalizeSku(sku);

  if (!normalizedSku) {
    return false;
  }

  return (Array.isArray(accessorySkus) ? accessorySkus : []).some(
    (configuredSku) => normalizeSku(configuredSku) === normalizedSku
  );
}

export function classifyShopifyLineItem(
  lineItem,
  {
    configuratorSkuPrefixes = env.CONFIGURATOR_REQUIRED_SKU_PREFIXES,
    accessorySkus = env.ACCESSORY_SKUS,
    validationOptions,
  } = {}
) {
  const sku = normalizeSku(lineItem?.sku);

  // Wallpaper takes precedence over every other route. A broken item under
  // the trusted wallpaper SKU contract must never fall through to accessory.
  if (isConfiguratorSkuRequired(sku, configuratorSkuPrefixes)) {
    const validation = validateConfiguratorLineItem(lineItem, {
      ...validationOptions,
      configuratorSkuPrefixes,
    });

    return {
      classification: LINE_ITEM_CLASSIFICATIONS.WALLPAPER,
      routingState: validation.ok
        ? LINE_ITEM_ROUTING_STATES.PRODUCTION_READY
        : LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED,
      routingReason: validation.ok
        ? null
        : validation.errors.join(', ') || validation.reason,
      validation,
    };
  }

  if (isAccessorySku(sku, accessorySkus)) {
    return {
      classification: LINE_ITEM_CLASSIFICATIONS.ACCESSORY,
      routingState: LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED,
      routingReason: LINE_ITEM_ROUTING_REASONS.ACCESSORY_XML_UNRESOLVED,
      validation: null,
    };
  }

  return {
    classification: LINE_ITEM_CLASSIFICATIONS.UNKNOWN,
    routingState: LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED,
    routingReason: LINE_ITEM_ROUTING_REASONS.UNKNOWN_SKU,
    validation: null,
  };
}

export default {
  classifyShopifyLineItem,
  isAccessorySku,
};
