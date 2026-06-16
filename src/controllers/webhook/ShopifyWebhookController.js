import { recordWebhook } from '../../services/WebhookService.js';

export async function recordOrdersPaidWebhook(req, res) {
  try {
    const webhook = await recordWebhook({
      provider: 'shopify',
      topic: 'orders/paid',
      shopifyOrderId: req.body?.id ?? null,
      hmacValid: null,
      headersJson: req.headers,
      rawPayloadJson: req.body,
    });

    res.status(200).json({
      ok: true,
      status: 'recorded',
      webhookId: webhook.id,
    });
  } catch (error) {
    console.error('Shopify webhook recording failed:', error);

    res.status(500).json({
      ok: false,
      error: 'webhook_record_failed',
    });
  }
}

export default {
  recordOrdersPaidWebhook,
};
