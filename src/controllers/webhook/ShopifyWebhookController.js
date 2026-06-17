import {
  markWebhookFailed,
  processWebhookOrder,
  recordWebhook,
} from '../../services/WebhookService.js';

export async function recordOrdersPaidWebhook(req, res) {
  let webhook = null;

  try {
    webhook = await recordWebhook({
      provider: 'shopify',
      topic: 'orders/paid',
      shopifyOrderId: req.body?.id ?? null,
      hmacValid: null,
      headersJson: req.headers,
      rawPayloadJson: req.body,
    });
  } catch (error) {
    console.error('Shopify webhook recording failed:', error);

    res.status(500).json({
      ok: false,
      error: 'webhook_record_failed',
    });
    return;
  }

  try {
    const result = await processWebhookOrder(webhook.id);

    res.status(200).json({
      ok: true,
      status: 'processed',
      webhookId: webhook.id,
      orderId: result.order.id,
      jobCount: result.jobs.length,
    });
  } catch (error) {
    console.error('Shopify webhook processing failed:', error);

    await markWebhookFailed(webhook.id, error.message);

    res.status(500).json({
      ok: false,
      error: 'webhook_processing_failed',
      webhookId: webhook.id,
    });
  }
}

export default {
  recordOrdersPaidWebhook,
};
