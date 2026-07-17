import { SHOPIFY_UPDATE_TASK_STATUSES } from '../constants/statuses.js';
import {
  isShopifyOrderAllowlisted,
  normalizeShopifyNumericId,
  parseShopifyWriteOrderAllowlist,
} from '../config/shopifyAdmin.js';

export const SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS = Object.freeze({
  EXECUTOR_DISABLED: 'shopify_update_executor_disabled',
  WRITE_DISABLED: 'shopify_write_disabled',
  UNSUPPORTED_TASK_TYPE: 'write_blocked_task_type_not_supported',
  TASK_NOT_CLAIMED: 'write_blocked_task_not_claimed',
  TASK_DRY_RUN: 'write_blocked_task_dry_run',
  PAYLOAD_DRY_RUN: 'write_blocked_payload_dry_run',
  PAYLOAD_DRY_RUN_AMBIGUOUS:
    'write_blocked_payload_dry_run_not_explicitly_false',
  PAYLOAD_WRITE_SUPPRESSED: 'write_blocked_payload_write_suppressed',
  PAYLOAD_WRITE_SUPPRESSION_AMBIGUOUS:
    'write_blocked_payload_write_suppression_invalid',
  ALLOWLIST_INVALID: 'write_blocked_order_allowlist_invalid',
  INVALID_ORDER_ID: 'write_blocked_invalid_shopify_order_id',
  ORDER_NOT_ALLOWLISTED: 'write_blocked_order_not_allowlisted',
  FULFILLMENT_ITEMS_NOT_EXPLICIT:
    'write_blocked_fulfillment_items_not_explicit',
});

function getPayloadDryRunValue(payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'dryRun')) {
    return payload.dryRun;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'dry_run')) {
    return payload.dry_run;
  }

  return undefined;
}

function getPayloadWriteSuppressedValue(payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'writeSuppressed')) {
    return payload.writeSuppressed;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'write_suppressed')) {
    return payload.write_suppressed;
  }

  return undefined;
}

export function hasExplicitFulfillmentOrderLineItems(fulfillmentInput) {
  const groups = fulfillmentInput?.lineItemsByFulfillmentOrder;

  if (!Array.isArray(groups) || groups.length === 0) {
    return false;
  }

  return groups.every((group) => {
    if (
      typeof group?.fulfillmentOrderId !== 'string' ||
      !group.fulfillmentOrderId.startsWith('gid://shopify/FulfillmentOrder/') ||
      !Array.isArray(group.fulfillmentOrderLineItems) ||
      group.fulfillmentOrderLineItems.length === 0
    ) {
      return false;
    }

    return group.fulfillmentOrderLineItems.every(
      (item) =>
        typeof item?.id === 'string' &&
        item.id.startsWith('gid://shopify/FulfillmentOrderLineItem/') &&
        Number.isSafeInteger(item.quantity) &&
        item.quantity > 0
    );
  });
}

export function evaluateShopifyExternalWriteGates({
  config,
  task,
  payload = {},
  workerId,
  fulfillmentInput,
} = {}) {
  const reasons = [];
  const normalizedOrderId = normalizeShopifyNumericId(task?.shopify_order_id);
  const payloadDryRun = getPayloadDryRunValue(payload);
  const payloadWriteSuppressed = getPayloadWriteSuppressedValue(payload);
  const allowlist = parseShopifyWriteOrderAllowlist(
    config?.SHOPIFY_WRITE_ORDER_ALLOWLIST
  );
  const invalidAllowlistEntryCount =
    allowlist.invalidEntries.length +
    (config?.SHOPIFY_WRITE_ORDER_ALLOWLIST_INVALID_ENTRIES?.length ?? 0);

  if (!config?.SHOPIFY_UPDATE_EXECUTOR_ENABLED) {
    reasons.push(SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.EXECUTOR_DISABLED);
  }

  if (!config?.SHOPIFY_WRITE_ENABLED) {
    reasons.push(SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.WRITE_DISABLED);
  }

  if (task?.task_type !== 'order_shipped') {
    reasons.push(SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.UNSUPPORTED_TASK_TYPE);
  }

  if (
    !workerId ||
    task?.status !== SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING ||
    task?.locked_by !== workerId ||
    !task?.locked_at
  ) {
    reasons.push(SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.TASK_NOT_CLAIMED);
  }

  if (task?.dry_run !== false) {
    reasons.push(SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.TASK_DRY_RUN);
  }

  if (payloadDryRun === true) {
    reasons.push(SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.PAYLOAD_DRY_RUN);
  } else if (payloadDryRun !== false) {
    reasons.push(
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.PAYLOAD_DRY_RUN_AMBIGUOUS
    );
  }

  if (payloadWriteSuppressed === true) {
    reasons.push(
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.PAYLOAD_WRITE_SUPPRESSED
    );
  } else if (
    payloadWriteSuppressed !== undefined &&
    payloadWriteSuppressed !== false
  ) {
    reasons.push(
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.PAYLOAD_WRITE_SUPPRESSION_AMBIGUOUS
    );
  }

  if (invalidAllowlistEntryCount > 0) {
    reasons.push(SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.ALLOWLIST_INVALID);
  }

  if (!normalizedOrderId) {
    reasons.push(SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.INVALID_ORDER_ID);
  } else if (
    !isShopifyOrderAllowlisted(
      normalizedOrderId,
      config?.SHOPIFY_WRITE_ORDER_ALLOWLIST
    )
  ) {
    reasons.push(SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.ORDER_NOT_ALLOWLISTED);
  }

  if (!hasExplicitFulfillmentOrderLineItems(fulfillmentInput)) {
    reasons.push(
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.FULFILLMENT_ITEMS_NOT_EXPLICIT
    );
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    primaryReason: reasons[0] ?? null,
  };
}

export default {
  SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS,
  evaluateShopifyExternalWriteGates,
  hasExplicitFulfillmentOrderLineItems,
};
