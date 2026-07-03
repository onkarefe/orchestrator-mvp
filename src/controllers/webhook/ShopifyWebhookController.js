import env from '../../config/env.js';
import { WEBHOOK_PROCESSING_STATUSES } from '../../constants/statuses.js';
import {
  getWebhookByDeliveryId,
  markWebhookFailed,
  processWebhookOrder,
  recordWebhook,
} from '../../services/WebhookService.js';
import { logWarning } from '../../services/LogService.js';
import { redact, safeErrorForLog } from '../../utils/redact.js';
import { verifyShopifyWebhookHmac } from '../../utils/shopifyHmac.js';

function getRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === 'string') {
    return Buffer.from(req.body, 'utf8');
  }

  return Buffer.alloc(0);
}

function parseRawJson(rawBody) {
  const text = rawBody.toString('utf8');

  if (!text.trim()) {
    return {};
  }

  return JSON.parse(text);
}

function getShopifyHmacHeader(req) {
  return req.get('x-shopify-hmac-sha256');
}

function getShopifyDeliveryId(req) {
  const deliveryId = req.get('x-shopify-webhook-id');

  return deliveryId ? String(deliveryId).trim() || null : null;
}

async function recordRejectedWebhook({
  req,
  rawBody,
  hmacValid,
  errorMessage,
}) {
  if (!env.SHOPIFY_WEBHOOK_STORE_INVALID) {
    return null;
  }

  let payload = null;

  try {
    payload = parseRawJson(rawBody);
  } catch {
    payload = null;
  }

  try {
    return await recordWebhook({
      provider: 'shopify',
      topic: 'orders/paid',
      shopifyOrderId: payload?.id ?? null,
      deliveryId: getShopifyDeliveryId(req),
      status: WEBHOOK_PROCESSING_STATUSES.FAILED,
      processingStatus:
        hmacValid === false
          ? WEBHOOK_PROCESSING_STATUSES.INVALID_HMAC
          : WEBHOOK_PROCESSING_STATUSES.FAILED,
      hmacValid,
      headersJson: redact(req.headers),
      rawPayloadJson: payload,
      errorMessage,
    });
  } catch (error) {
    console.error(
      'Rejected Shopify webhook recording failed:',
      safeErrorForLog(error)
    );
    return null;
  }
}

export async function recordOrdersPaidWebhook(req, res) {
  let webhook = null;
  const rawBody = getRawBody(req);
  const hmacHeader = getShopifyHmacHeader(req);
  const deliveryId = getShopifyDeliveryId(req);
  const hmacWasChecked = Boolean(env.SHOPIFY_WEBHOOK_SECRET && hmacHeader);
  const hmacValid = verifyShopifyWebhookHmac({
    rawBody,
    hmacHeader,
    secret: env.SHOPIFY_WEBHOOK_SECRET,
  });

  if (env.SHOPIFY_WEBHOOK_HMAC_REQUIRED && !hmacValid) {
    await recordRejectedWebhook({
      req,
      rawBody,
      hmacValid: false,
      errorMessage: 'Invalid Shopify webhook HMAC',
    });

    res.status(401).json({
      ok: false,
      error: 'invalid_shopify_webhook_hmac',
    });
    return;
  }

  if (!env.SHOPIFY_WEBHOOK_HMAC_REQUIRED) {
    await logWarning({
      scopeType: 'system',
      step: 'webhook.hmac_not_enforced',
      message: 'Shopify webhook HMAC enforcement is disabled',
      detailsJson: {
        hasHmacHeader: Boolean(hmacHeader),
        hasWebhookSecret: Boolean(env.SHOPIFY_WEBHOOK_SECRET),
        hmacValid: hmacWasChecked ? hmacValid : null,
      },
    });
  }

  let payload = null;

  try {
    payload = parseRawJson(rawBody);
  } catch {
    await recordRejectedWebhook({
      req,
      rawBody,
      hmacValid: hmacWasChecked ? hmacValid : null,
      errorMessage: 'Invalid JSON payload',
    });

    res.status(400).json({
      ok: false,
      error: 'invalid_json_payload',
    });
    return;
  }

  if (deliveryId) {
    let originalWebhook = null;

    try {
      originalWebhook = await getWebhookByDeliveryId(deliveryId);
    } catch (error) {
      console.error(
        'Shopify webhook duplicate lookup failed:',
        safeErrorForLog(error)
      );

      res.status(500).json({
        ok: false,
        error: 'webhook_duplicate_lookup_failed',
      });
      return;
    }

    if (originalWebhook) {
      let duplicateWebhook = null;

      try {
        duplicateWebhook = await recordWebhook({
          provider: 'shopify',
          topic: 'orders/paid',
          shopifyOrderId: payload?.id ?? null,
          deliveryId,
          status: 'received',
          processingStatus: WEBHOOK_PROCESSING_STATUSES.DUPLICATE,
          hmacValid: hmacWasChecked ? hmacValid : null,
          duplicateOfId: originalWebhook.id,
          headersJson: redact(req.headers),
          rawPayloadJson: payload,
          errorMessage: 'Duplicate Shopify webhook delivery',
        });
      } catch (error) {
        console.error(
          'Duplicate Shopify webhook recording failed:',
          safeErrorForLog(error)
        );
      }

      res.status(200).json({
        ok: true,
        status: WEBHOOK_PROCESSING_STATUSES.DUPLICATE,
        duplicate: true,
        webhookId: duplicateWebhook?.id ?? null,
        duplicateOfId: originalWebhook.id,
        orderId: null,
        jobCount: 0,
      });
      return;
    }
  }

  try {
    webhook = await recordWebhook({
      provider: 'shopify',
      topic: 'orders/paid',
      shopifyOrderId: payload?.id ?? null,
      deliveryId,
      status: 'received',
      processingStatus: WEBHOOK_PROCESSING_STATUSES.PENDING,
      hmacValid: hmacWasChecked ? hmacValid : null,
      headersJson: redact(req.headers),
      rawPayloadJson: payload,
    });
  } catch (error) {
    console.error('Shopify webhook recording failed:', safeErrorForLog(error));

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
      status: result.duplicate ? 'already_processed' : 'processed',
      duplicate: Boolean(result.duplicate),
      webhookId: webhook.id,
      orderId: result.order.id,
      jobCount: result.jobs.length,
      skippedDuplicateJobCount: result.skippedDuplicateJobs?.length ?? 0,
      manualReviewJobCount: result.manualReviewJobs?.length ?? 0,
    });
  } catch (error) {
    console.error('Shopify webhook processing failed:', safeErrorForLog(error));

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
