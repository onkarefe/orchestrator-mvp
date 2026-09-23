import {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_STATES,
} from '../constants/lineItemRouting.js';
import { ORDER_STATUSES } from '../constants/statuses.js';
import {
  MANUAL_REVIEW_REASONS,
  validateShopifyShippingAddress,
} from './PreflightValidationService.js';
import { classifyShopifyLineItem } from './LineItemRoutingService.js';

export const FACTORY_DISPATCH_BLOCK_REASONS = Object.freeze({
  CLASSIFICATION_INCOMPLETE: 'line_item_classification_incomplete',
  UNKNOWN_LINE_ITEM: 'order_contains_unknown_line_item',
  BLOCKED_LINE_ITEM: 'order_contains_blocked_line_item',
  ORDER_MANUAL_REVIEW: 'order_requires_manual_review',
  MISSING_SHIPPING_ADDRESS:
    MANUAL_REVIEW_REASONS.MISSING_SHIPPING_ADDRESS,
  INVALID_SHIPPING_ADDRESS:
    MANUAL_REVIEW_REASONS.INVALID_SHIPPING_ADDRESS,
});

function normalizedIdentity(value) {
  return value === null || value === undefined || String(value).trim() === ''
    ? null
    : String(value).trim();
}

export function evaluateFactoryDispatchGate({ order, lineItems } = {}) {
  if (order?.status === ORDER_STATUSES.SECURITY_HOLD) {
    return { allowed: false, reason: 'checkout_security_hold' };
  }
  const shippingValidation = validateShopifyShippingAddress(
    order?.raw_payload_json
  );

  if (!shippingValidation.ok) {
    return {
      allowed: false,
      reason: shippingValidation.reason,
    };
  }

  if (order?.status === ORDER_STATUSES.MANUAL_REVIEW) {
    return {
      allowed: false,
      reason: FACTORY_DISPATCH_BLOCK_REASONS.ORDER_MANUAL_REVIEW,
    };
  }

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
    if (persistedLineItem.classification === LINE_ITEM_CLASSIFICATIONS.ACCESSORY) {
      const routing = classifyShopifyLineItem(sourceLineItem, {
        validationOptions: { checkMasterFileExists: false },
      });
      if (
        routing.classification !== LINE_ITEM_CLASSIFICATIONS.ACCESSORY ||
        routing.routingState !== LINE_ITEM_ROUTING_STATES.PRODUCTION_READY ||
        normalizedIdentity(persistedLineItem.sku) !==
          normalizedIdentity(sourceLineItem?.sku) ||
        Number(persistedLineItem.quantity) !== sourceLineItem?.quantity
      ) {
        return {
          allowed: false,
          reason: FACTORY_DISPATCH_BLOCK_REASONS.BLOCKED_LINE_ITEM,
        };
      }
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
        ![
          LINE_ITEM_CLASSIFICATIONS.WALLPAPER,
          LINE_ITEM_CLASSIFICATIONS.ACCESSORY,
        ].includes(lineItem.classification) ||
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
