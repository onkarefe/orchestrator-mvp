export const LINE_ITEM_CLASSIFICATIONS = Object.freeze({
  WALLPAPER: 'WALLPAPER',
  ACCESSORY: 'ACCESSORY',
  UNKNOWN: 'UNKNOWN',
});

export const LINE_ITEM_ROUTING_STATES = Object.freeze({
  PRODUCTION_READY: 'production_ready',
  FACTORY_BLOCKED: 'factory_blocked',
});

export const LINE_ITEM_ROUTING_REASONS = Object.freeze({
  MISSING_SKU: 'missing_sku',
  CONFIGURATOR_SKU_MISMATCH: 'configurator_sku_mismatch',
  INVALID_ACCESSORY_QUANTITY: 'invalid_accessory_quantity',
});

export default {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_STATES,
  LINE_ITEM_ROUTING_REASONS,
};
