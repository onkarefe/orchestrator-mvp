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
  ACCESSORY_XML_UNRESOLVED: 'accessory_xml_contract_unresolved',
  UNKNOWN_SKU: 'unknown_sku',
});

export default {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_STATES,
  LINE_ITEM_ROUTING_REASONS,
};
