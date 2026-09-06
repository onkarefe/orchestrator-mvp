import env from '../../config/env.js';
import { WEBHOOK_PROCESSING_STATUSES } from '../../constants/statuses.js';
import { isDuplicateKeyError } from '../../db/errors.js';
import {
  claimFailedWebhookRetry,
  getWebhookByDeliveryId,
  markWebhookFailed,
  processShopifyLifecycleWebhook,
  processWebhookOrder,
  recordWebhook,
} from '../../services/WebhookService.js';
import { getShopifyOrderIdForLifecycleEvent } from '../../services/ShopifyLifecycleService.js';
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

function sendDuplicateDeliveryResponse(res, originalWebhook) {
  res.status(200).json({
    ok: true,
    status: WEBHOOK_PROCESSING_STATUSES.DUPLICATE,
    duplicate: true,
    webhookId: originalWebhook.id,
    duplicateOfId: originalWebhook.id,
    orderId: null,
    jobCount: 0,
  });
}

async function recordRejectedWebhook({
  req,
  rawBody,
  hmacValid,
  errorMessage,
  topic,
  getShopifyOrderId,
  runtime,
}) {
  if (!runtime.config.SHOPIFY_WEBHOOK_STORE_INVALID) {
    return null;
  }

  let payload = null;

  try {
    payload = parseRawJson(rawBody);
  } catch {
    payload = null;
  }

  try {
    return await runtime.recordWebhook({
      provider: 'shopify',
      topic,
      shopifyOrderId: getShopifyOrderId(payload),
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

const defaultRuntime = Object.freeze({
  claimFailedWebhookRetry,
  config: env,
  getWebhookByDeliveryId,
  logWarning,
  markWebhookFailed,
  processWebhookOrder,
  processShopifyLifecycleWebhook,
  recordWebhook,
  verifyShopifyWebhookHmac,
});

export async function handleOrdersPaidWebhook(
  req,
  res,
  runtime = defaultRuntime,
  {
    topic = 'orders/paid',
    getShopifyOrderId = (payload) => payload?.id ?? null,
    processWebhook = runtime.processWebhookOrder,
  } = {}
) {
  let webhook = null;
  const rawBody = getRawBody(req);
  const hmacHeader = getShopifyHmacHeader(req);
  const deliveryId = getShopifyDeliveryId(req);
  const hmacWasChecked = Boolean(
    runtime.config.SHOPIFY_WEBHOOK_SECRET && hmacHeader
  );
  const hmacValid = runtime.verifyShopifyWebhookHmac({
    rawBody,
    hmacHeader,
    secret: runtime.config.SHOPIFY_WEBHOOK_SECRET,
  });

  if (runtime.config.SHOPIFY_WEBHOOK_HMAC_REQUIRED && !hmacValid) {
    await recordRejectedWebhook({
      req,
      rawBody,
      hmacValid: false,
      errorMessage: 'Invalid Shopify webhook HMAC',
      topic,
      getShopifyOrderId,
      runtime,
    });

    res.status(401).json({
      ok: false,
      error: 'invalid_shopify_webhook_hmac',
    });
    return;
  }

  if (!runtime.config.SHOPIFY_WEBHOOK_HMAC_REQUIRED) {
    await runtime.logWarning({
      scopeType: 'system',
      step: 'webhook.hmac_not_enforced',
      message: 'Shopify webhook HMAC enforcement is disabled',
      detailsJson: {
        hasHmacHeader: Boolean(hmacHeader),
        hasWebhookSecret: Boolean(runtime.config.SHOPIFY_WEBHOOK_SECRET),
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
      topic,
      getShopifyOrderId,
      runtime,
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
      originalWebhook = await runtime.getWebhookByDeliveryId(deliveryId);
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
      if (
        originalWebhook.processing_status ===
        WEBHOOK_PROCESSING_STATUSES.FAILED
      ) {
        try {
          webhook = await runtime.claimFailedWebhookRetry(originalWebhook.id);
        } catch (error) {
          if (!isDuplicateKeyError(error)) {
            console.error(
              'Shopify webhook retry claim failed:',
              safeErrorForLog(error)
            );

            res.status(500).json({
              ok: false,
              error: 'webhook_retry_claim_failed',
            });
            return;
          }
        }

        if (!webhook) {
          try {
            const claimedByOtherRequest =
              await runtime.getWebhookByDeliveryId(deliveryId);

            if (claimedByOtherRequest) {
              sendDuplicateDeliveryResponse(res, claimedByOtherRequest);
              return;
            }
          } catch (error) {
            console.error(
              'Concurrent Shopify webhook retry lookup failed:',
              safeErrorForLog(error)
            );
          }

          res.status(500).json({
            ok: false,
            error: 'webhook_retry_claim_failed',
          });
          return;
        }
      } else {
        sendDuplicateDeliveryResponse(res, originalWebhook);
        return;
      }
    }
  }

  if (!webhook) {
    try {
      webhook = await runtime.recordWebhook({
        provider: 'shopify',
        topic,
        shopifyOrderId: getShopifyOrderId(payload),
        deliveryId,
        status: 'received',
        processingStatus: WEBHOOK_PROCESSING_STATUSES.PENDING,
        hmacValid: hmacWasChecked ? hmacValid : null,
        headersJson: redact(req.headers),
        rawPayloadJson: payload,
      });
    } catch (error) {
      if (deliveryId && isDuplicateKeyError(error)) {
        try {
          const originalWebhook =
            await runtime.getWebhookByDeliveryId(deliveryId);

          if (originalWebhook) {
            sendDuplicateDeliveryResponse(res, originalWebhook);
            return;
          }
        } catch (lookupError) {
          console.error(
            'Concurrent Shopify webhook duplicate lookup failed:',
            safeErrorForLog(lookupError)
          );
        }
      }

      console.error('Shopify webhook recording failed:', safeErrorForLog(error));

      res.status(500).json({
        ok: false,
        error: 'webhook_record_failed',
      });
      return;
    }
  }

  try {
    const result = await processWebhook(webhook.id);

    if (topic !== 'orders/paid') {
      res.status(200).json({
        ok: true,
        status: 'processed',
        webhookId: webhook.id,
        orderId: result.order?.id ?? null,
        disposition: result.disposition,
      });
      return;
    }

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

    await runtime.markWebhookFailed(webhook.id, error.message);

    res.status(500).json({
      ok: false,
      error: 'webhook_processing_failed',
      webhookId: webhook.id,
    });
  }
}

export function recordOrdersPaidWebhook(req, res) {
  return handleOrdersPaidWebhook(req, res);
}

export function handleShopifyLifecycleWebhook(
  req,
  res,
  topic,
  runtime = defaultRuntime
) {
  return handleOrdersPaidWebhook(req, res, runtime, {
    topic,
    getShopifyOrderId: (payload) =>
      getShopifyOrderIdForLifecycleEvent(topic, payload),
    processWebhook: runtime.processShopifyLifecycleWebhook,
  });
}

export function recordOrdersCancelledWebhook(req, res) {
  return handleShopifyLifecycleWebhook(req, res, 'orders/cancelled');
}

export function recordOrdersUpdatedWebhook(req, res) {
  return handleShopifyLifecycleWebhook(req, res, 'orders/updated');
}

export function recordRefundsCreateWebhook(req, res) {
  return handleShopifyLifecycleWebhook(req, res, 'refunds/create');
}

export default {
  recordOrdersPaidWebhook,
  recordOrdersCancelledWebhook,
  recordOrdersUpdatedWebhook,
  recordRefundsCreateWebhook,
};
