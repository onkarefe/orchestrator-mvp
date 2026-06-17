import {
  createWebhook,
  findWebhookById,
  listWebhooks,
  updateWebhookStatus,
} from '../models/WebhookModel.js';
import { logError, logInfo } from './LogService.js';
import { createOrderAndJobsFromShopifyPayload } from './OrderService.js';

export async function recordWebhook(data) {
  const webhook = await createWebhook({
    provider: data.provider,
    topic: data.topic,
    shopifyOrderId: data.shopifyOrderId,
    hmacValid: data.hmacValid,
    headersJson: data.headersJson,
    rawPayloadJson: data.rawPayloadJson,
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
    },
  });

  return webhook;
}

export async function markWebhookProcessed(id) {
  return updateWebhookStatus(id, 'processed');
}

export async function markWebhookFailed(id, errorMessage) {
  const webhook = await updateWebhookStatus(id, 'failed', errorMessage);

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

  const { order, jobs } = await createOrderAndJobsFromShopifyPayload(webhook.raw_payload_json);
  const processedWebhook = await markWebhookProcessed(webhookId);

  return {
    webhook: processedWebhook,
    order,
    jobs,
  };
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
  getWebhook,
  getWebhooks,
};
