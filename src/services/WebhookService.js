import os from 'node:os';

import {
  claimWebhook,
  createWebhook,
  findWebhookByDeliveryId,
  findWebhookById,
  findOriginalWebhookByShopifyOrderId,
  listWebhooks,
  updateClaimedWebhookDuplicate,
  updateClaimedWebhookStatus,
} from '../models/WebhookModel.js';
import env from '../config/env.js';
import { WEBHOOK_PROCESSING_STATUSES } from '../constants/statuses.js';
import { logError, logInfo } from './LogService.js';
import { createOrderAndJobsFromShopifyPayload } from './OrderService.js';

export async function recordWebhook(data) {
  const webhook = await createWebhook({
    provider: data.provider,
    topic: data.topic,
    shopifyOrderId: data.shopifyOrderId,
    deliveryId: data.deliveryId,
    status: data.status,
    processingStatus: data.processingStatus,
    hmacValid: data.hmacValid,
    attemptCount: data.attemptCount,
    maxAttempts: data.maxAttempts ?? env.SHOPIFY_WEBHOOK_MAX_ATTEMPTS,
    lockedAt: data.lockedAt,
    lockedBy: data.lockedBy,
    duplicateOfId: data.duplicateOfId,
    headersJson: data.headersJson,
    rawPayloadJson: data.rawPayloadJson,
    errorMessage: data.errorMessage,
  });

  await logInfo({
    scopeType: 'system',
    step: 'webhook.recorded',
    message: 'Webhook recorded',
    detailsJson: {
      webhookId: webhook.id,
      provider: webhook.provider,
      topic: webhook.topic,
      shopifyOrderId: webhook.shopify_order_id,
      deliveryId: webhook.delivery_id,
      processingStatus: webhook.processing_status,
      duplicateOfId: webhook.duplicate_of_id,
    },
  });

  return webhook;
}

export function getWebhookWorkerId(suffix = 'webhook') {
  return `${os.hostname()}-${process.pid}-${suffix}`.slice(0, 191);
}

export async function claimWebhookProcessing(
  id,
  {
    workerId = getWebhookWorkerId(),
    maxAttempts = env.SHOPIFY_WEBHOOK_MAX_ATTEMPTS,
    staleLockMinutes = env.SHOPIFY_WEBHOOK_STALE_LOCK_MINUTES,
  } = {}
) {
  return claimWebhook(id, { workerId, maxAttempts, staleLockMinutes });
}

export async function markWebhookProcessed(id, { workerId } = {}) {
  const result = await updateClaimedWebhookStatus(id, {
    workerId,
    status: WEBHOOK_PROCESSING_STATUSES.PROCESSED,
    processingStatus: WEBHOOK_PROCESSING_STATUSES.PROCESSED,
  });

  if (!result.updated) {
    throw new Error('webhook_processing_claim_lost');
  }

  return result.webhook;
}

export async function markWebhookFailed(
  id,
  errorMessage,
  { workerId } = {}
) {
  const result = await updateClaimedWebhookStatus(id, {
    workerId,
    status: WEBHOOK_PROCESSING_STATUSES.FAILED,
    processingStatus: WEBHOOK_PROCESSING_STATUSES.FAILED,
    errorMessage,
  });

  await logError({
    scopeType: 'system',
    step: 'webhook.failed',
    message: 'Webhook failed',
    detailsJson: {
      webhookId: id,
      errorMessage,
      claimUpdated: result.updated,
    },
  });

  return result.webhook;
}

export async function markWebhookDuplicate(
  id,
  duplicateOfId = null,
  errorMessage = 'Duplicate Shopify order webhook',
  { workerId } = {}
) {
  const result = await updateClaimedWebhookDuplicate(id, {
    workerId,
    duplicateOfId,
    errorMessage,
  });

  if (!result.updated) {
    throw new Error('webhook_processing_claim_lost');
  }

  const webhook = result.webhook;

  await logInfo({
    scopeType: 'system',
    step: 'webhook.duplicate',
    message: 'Webhook marked duplicate',
    detailsJson: {
      webhookId: id,
      duplicateOfId,
      shopifyOrderId: webhook.shopify_order_id,
      deliveryId: webhook.delivery_id,
    },
  });

  return webhook;
}

export async function processWebhookOrder(
  webhookId,
  { workerId = getWebhookWorkerId() } = {}
) {
  const webhook = await findWebhookById(webhookId);

  if (!webhook) {
    throw new Error('Webhook not found');
  }

  if (
    webhook.processing_status !== WEBHOOK_PROCESSING_STATUSES.PROCESSING ||
    webhook.locked_by !== workerId
  ) {
    throw new Error('webhook_processing_claim_not_owned');
  }

  const orderResult = await createOrderAndJobsFromShopifyPayload(
    webhook.raw_payload_json
  );

  if (orderResult.duplicate) {
    const originalWebhook = await findOriginalWebhookByShopifyOrderId(
      webhook.shopify_order_id,
      webhook.id
    );
    const duplicateWebhook = await markWebhookDuplicate(
      webhookId,
      originalWebhook?.id ?? null,
      'Duplicate Shopify order webhook',
      { workerId }
    );

    return {
      webhook: duplicateWebhook,
      duplicateOfId: originalWebhook?.id ?? null,
      ...orderResult,
    };
  }

  const processedWebhook = await markWebhookProcessed(webhookId, {
    workerId,
  });

  return {
    webhook: processedWebhook,
    ...orderResult,
  };
}

export function getWebhookByDeliveryId(deliveryId) {
  return findWebhookByDeliveryId(deliveryId);
}

export function getWebhook(id) {
  return findWebhookById(id);
}

export function getWebhooks(filters) {
  return listWebhooks(filters);
}

export default {
  recordWebhook,
  claimWebhookProcessing,
  getWebhookWorkerId,
  markWebhookProcessed,
  markWebhookFailed,
  markWebhookDuplicate,
  processWebhookOrder,
  getWebhookByDeliveryId,
  getWebhook,
  getWebhooks,
};
