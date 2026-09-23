import env from '../config/env.js';
import {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_REASONS,
  LINE_ITEM_ROUTING_STATES,
} from '../constants/lineItemRouting.js';
import {
  isWallpaperSku,
  validateConfiguratorLineItem,
} from './PreflightValidationService.js';
import { resolveConfiguratorProperties } from './ConfiguratorPropertyResolver.js';

function normalizeSku(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function classifyShopifyLineItem(
  lineItem,
  {
    wallpaperSkus = env.WALLPAPER_SKUS,
    validationOptions,
  } = {}
) {
  const sku = normalizeSku(lineItem?.sku);
  const { hasMarker } = resolveConfiguratorProperties(lineItem?.properties);

  // Wallpaper takes precedence over every other route. A broken item under
  // the trusted wallpaper SKU contract must never fall through to accessory.
  if (isWallpaperSku(sku, wallpaperSkus)) {
    const validation = validateConfiguratorLineItem(lineItem, {
      ...validationOptions,
      wallpaperSkus,
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

  if (sku && !hasMarker) {
    const validQuantity =
      Number.isSafeInteger(lineItem?.quantity) && lineItem.quantity > 0;
    return {
      classification: LINE_ITEM_CLASSIFICATIONS.ACCESSORY,
      routingState: validQuantity
        ? LINE_ITEM_ROUTING_STATES.PRODUCTION_READY
        : LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED,
      routingReason: validQuantity
        ? null
        : LINE_ITEM_ROUTING_REASONS.INVALID_ACCESSORY_QUANTITY,
      validation: null,
    };
  }

  return {
    classification: LINE_ITEM_CLASSIFICATIONS.UNKNOWN,
    routingState: LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED,
    routingReason: sku
      ? LINE_ITEM_ROUTING_REASONS.CONFIGURATOR_SKU_MISMATCH
      : LINE_ITEM_ROUTING_REASONS.MISSING_SKU,
    validation: null,
  };
}

export default {
  classifyShopifyLineItem,
};
