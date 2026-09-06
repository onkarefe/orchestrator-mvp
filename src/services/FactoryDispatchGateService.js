import {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_STATES,
} from '../constants/lineItemRouting.js';

export const FACTORY_DISPATCH_BLOCK_REASONS = Object.freeze({
  CLASSIFICATION_INCOMPLETE: 'line_item_classification_incomplete',
  UNKNOWN_LINE_ITEM: 'order_contains_unknown_line_item',
  ACCESSORY_LINE_ITEM: 'order_contains_accessory_line_item',
  BLOCKED_LINE_ITEM: 'order_contains_blocked_line_item',
});

function normalizedIdentity(value) {
  return value === null || value === undefined || String(value).trim() === ''
    ? null
    : String(value).trim();
}

export function evaluateFactoryDispatchGate({ order, lineItems } = {}) {
  const sourceLineItems = order?.raw_payload_json?.line_items;

  if (!Array.isArray(sourceLineItems) || !Array.isArray(lineItems)) {
    return {
      allowed: false,
      reason: FACTORY_DISPATCH_BLOCK_REASONS.CLASSIFICATION_INCOMPLETE,
    };
  }

  if (sourceLineItems.length === 0 || lineItems.length !== sourceLineItems.length) {
    return {
      allowed: false,
      reason: FACTORY_DISPATCH_BLOCK_REASONS.CLASSIFICATION_INCOMPLETE,
    };
  }

  const byPosition = new Map(
    lineItems.map((lineItem) => [Number(lineItem?.source_position), lineItem])
  );

  for (const [sourcePosition, sourceLineItem] of sourceLineItems.entries()) {
    const persistedLineItem = byPosition.get(sourcePosition);

    if (
      !persistedLineItem ||
      String(persistedLineItem.order_id) !== String(order.id) ||
      String(persistedLineItem.shopify_order_id) !==
        String(order.shopify_order_id) ||
      normalizedIdentity(persistedLineItem.shopify_line_item_id) !==
        normalizedIdentity(sourceLineItem?.id)
    ) {
      return {
        allowed: false,
        reason: FACTORY_DISPATCH_BLOCK_REASONS.CLASSIFICATION_INCOMPLETE,
      };
    }
  }

  if (
    lineItems.some(
      (lineItem) =>
        lineItem.classification === LINE_ITEM_CLASSIFICATIONS.UNKNOWN
    )
  ) {
    return {
      allowed: false,
      reason: FACTORY_DISPATCH_BLOCK_REASONS.UNKNOWN_LINE_ITEM,
    };
  }

  if (
    lineItems.some(
      (lineItem) =>
        lineItem.classification === LINE_ITEM_CLASSIFICATIONS.ACCESSORY
    )
  ) {
    return {
      allowed: false,
      reason: FACTORY_DISPATCH_BLOCK_REASONS.ACCESSORY_LINE_ITEM,
    };
  }

  if (
    lineItems.some(
      (lineItem) =>
        lineItem.classification !== LINE_ITEM_CLASSIFICATIONS.WALLPAPER ||
        lineItem.routing_state !== LINE_ITEM_ROUTING_STATES.PRODUCTION_READY
    )
  ) {
    return {
      allowed: false,
      reason: FACTORY_DISPATCH_BLOCK_REASONS.BLOCKED_LINE_ITEM,
    };
  }

  return { allowed: true, reason: null };
}

export default {
  FACTORY_DISPATCH_BLOCK_REASONS,
  evaluateFactoryDispatchGate,
};
