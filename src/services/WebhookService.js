import {
  createWebhook,
  findWebhookByDeliveryId,
  findWebhookById,
  listWebhooks,
  updateWebhookStatus,
} from '../models/WebhookModel.js';
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

export async function markWebhookProcessed(id) {
  return updateWebhookStatus(
    id,
    WEBHOOK_PROCESSING_STATUSES.PROCESSED,
    null,
    WEBHOOK_PROCESSING_STATUSES.PROCESSED
  );
}

export async function markWebhookFailed(id, errorMessage) {
  const webhook = await updateWebhookStatus(
    id,
    WEBHOOK_PROCESSING_STATUSES.FAILED,
    errorMessage,
    WEBHOOK_PROCESSING_STATUSES.FAILED
  );

  await logError({
    scopeType: 'system',
    step: 'webhook.failed',
    message: 'Webhook failed',
    detailsJson: {
      webhookId: id,
      errorMessage,
    },
  });

  return webhook;
}

export async function processWebhookOrder(webhookId) {
  const webhook = await findWebhookById(webhookId);

  if (!webhook) {
    throw new Error('Webhook not found');
  }

  const orderResult = await createOrderAndJobsFromShopifyPayload(
    webhook.raw_payload_json
  );
  const processedWebhook = await markWebhookProcessed(webhookId);

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
  markWebhookProcessed,
  markWebhookFailed,
  processWebhookOrder,
  getWebhookByDeliveryId,
  getWebhook,
  getWebhooks,
};
