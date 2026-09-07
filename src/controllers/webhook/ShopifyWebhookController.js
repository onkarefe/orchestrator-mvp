import env from '../../config/env.js';
import { normalizeShopifyShopDomain } from '../../config/shopifyAdmin.js';
import { WEBHOOK_PROCESSING_STATUSES } from '../../constants/statuses.js';
import { isDuplicateKeyError } from '../../db/errors.js';
import {
  claimWebhookProcessing,
  getWebhookByDeliveryId,
  getWebhookWorkerId,
  markWebhookFailed,
  processWebhookOrder,
  recordWebhook,
} from '../../services/WebhookService.js';
import { logWarning } from '../../services/LogService.js';
import { redact, safeErrorForLog } from '../../utils/redact.js';
import { verifyShopifyWebhookHmac } from '../../utils/shopifyHmac.js';

const ORDERS_PAID_TOPIC = 'orders/paid';
const EXPLICIT_UNPAID_FINANCIAL_STATUSES = new Set([
  'authorized',
  'partially_paid',
  'pending',
  'unpaid',
  'voided',
]);

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

function getHeader(req, name) {
  const value = req.get(name);

  return value === undefined || value === null ? null : String(value);
}

function getShopifyHmacHeader(req) {
  return getHeader(req, 'x-shopify-hmac-sha256');
}

function getShopifyDeliveryId(req) {
  const deliveryId = getHeader(req, 'x-shopify-webhook-id');

  return deliveryId ? deliveryId.trim() || null : null;
}

function getShopifyTopic(req) {
  return getHeader(req, 'x-shopify-topic');
}

function getShopifyShopDomain(req) {
  return normalizeShopifyShopDomain(getHeader(req, 'x-shopify-shop-domain'));
}

export function hasExplicitPaidEventContradiction(payload) {
  const financialStatus = String(payload?.financial_status ?? '')
    .trim()
    .toLowerCase();

  return EXPLICIT_UNPAID_FINANCIAL_STATUSES.has(financialStatus);
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

function sendClaimUnavailableResponse(res, webhook) {
  const attempts = Number(webhook?.attempt_count ?? 0);
  const maxAttempts = Number(webhook?.max_attempts ?? 0);
  const exhausted =
    Number.isFinite(maxAttempts) && maxAttempts > 0 && attempts >= maxAttempts;

  res.status(exhausted ? 500 : 409).json({
    ok: false,
    error: exhausted
      ? 'webhook_retry_limit_reached'
      : 'webhook_processing_in_progress',
    webhookId: webhook?.id ?? null,
  });
}

async function recordRejectedWebhook({
  req,
  rawBody,
  hmacValid,
  errorMessage,
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
      topic: getShopifyTopic(req),
      shopifyOrderId: payload?.id ?? null,
      deliveryId: getShopifyDeliveryId(req),
      status: WEBHOOK_PROCESSING_STATUSES.FAILED,
      processingStatus:
        hmacValid === false
          ? WEBHOOK_PROCESSING_STATUSES.INVALID_HMAC
          : WEBHOOK_PROCESSING_STATUSES.REJECTED,
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
  claimWebhookProcessing,
  config: env,
  getWebhookByDeliveryId,
  getWebhookWorkerId,
  logWarning,
  markWebhookFailed,
  processWebhookOrder,
  recordWebhook,
  verifyShopifyWebhookHmac,
});

async function claimExistingWebhook(webhook, workerId, runtime) {
  if (
    webhook.processing_status === WEBHOOK_PROCESSING_STATUSES.PROCESSED
  ) {
    return { disposition: 'completed', webhook };
  }

  const claimed = await runtime.claimWebhookProcessing(webhook.id, {
    workerId,
    maxAttempts: runtime.config.SHOPIFY_WEBHOOK_MAX_ATTEMPTS,
    staleLockMinutes: runtime.config.SHOPIFY_WEBHOOK_STALE_LOCK_MINUTES,
  });

  if (claimed) {
    return { disposition: 'claimed', webhook: claimed };
  }

  const current = webhook.delivery_id
    ? await runtime.getWebhookByDeliveryId(webhook.delivery_id)
    : webhook;

  if (
    current?.processing_status === WEBHOOK_PROCESSING_STATUSES.PROCESSED
  ) {
    return { disposition: 'completed', webhook: current };
  }

  return { disposition: 'unavailable', webhook: current ?? webhook };
}

export async function handleOrdersPaidWebhook(
  req,
  res,
  runtime = defaultRuntime
) {
  let webhook = null;
  const rawBody = getRawBody(req);
  const hmacHeader = getShopifyHmacHeader(req);
  const deliveryId = getShopifyDeliveryId(req);
  const workerId = runtime.getWebhookWorkerId('webhook-http');
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
      runtime,
    });
    res.status(401).json({ ok: false, error: 'invalid_shopify_webhook_hmac' });
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

  if (getShopifyTopic(req) !== ORDERS_PAID_TOPIC) {
    await recordRejectedWebhook({
      req,
      rawBody,
      hmacValid: hmacWasChecked ? hmacValid : null,
      errorMessage: 'Unexpected Shopify webhook topic',
      runtime,
    });
    res.status(400).json({ ok: false, error: 'invalid_shopify_webhook_topic' });
    return;
  }

  const expectedShopDomain = normalizeShopifyShopDomain(
    runtime.config.SHOPIFY_SHOP_DOMAIN
  );

  if (!expectedShopDomain) {
    res.status(503).json({
      ok: false,
      error: 'shopify_webhook_shop_not_configured',
    });
    return;
  }

  if (getShopifyShopDomain(req) !== expectedShopDomain) {
    await recordRejectedWebhook({
      req,
      rawBody,
      hmacValid: hmacWasChecked ? hmacValid : null,
      errorMessage: 'Unexpected Shopify webhook shop domain',
      runtime,
    });
    res.status(403).json({ ok: false, error: 'invalid_shopify_webhook_shop' });
    return;
  }

  let payload;

  try {
    payload = parseRawJson(rawBody);
  } catch {
    await recordRejectedWebhook({
      req,
      rawBody,
      hmacValid: hmacWasChecked ? hmacValid : null,
      errorMessage: 'Invalid JSON payload',
      runtime,
    });
    res.status(400).json({ ok: false, error: 'invalid_json_payload' });
    return;
  }

  if (hasExplicitPaidEventContradiction(payload)) {
    await recordRejectedWebhook({
      req,
      rawBody,
      hmacValid: hmacWasChecked ? hmacValid : null,
      errorMessage: 'Shopify paid event has an explicitly unpaid status',
      runtime,
    });
    res.status(422).json({
      ok: false,
      error: 'shopify_paid_event_financial_status_contradiction',
    });
    return;
  }

  if (deliveryId) {
    try {
      const originalWebhook =
        await runtime.getWebhookByDeliveryId(deliveryId);

      if (originalWebhook) {
        const claimResult = await claimExistingWebhook(
          originalWebhook,
          workerId,
          runtime
        );

        if (claimResult.disposition === 'completed') {
          sendDuplicateDeliveryResponse(res, claimResult.webhook);
          return;
        }

        if (claimResult.disposition === 'unavailable') {
          sendClaimUnavailableResponse(res, claimResult.webhook);
          return;
        }

        webhook = claimResult.webhook;
      }
    } catch (error) {
      console.error(
        'Shopify webhook duplicate lookup or claim failed:',
        safeErrorForLog(error)
      );
      res.status(500).json({ ok: false, error: 'webhook_claim_failed' });
      return;
    }
  }

  if (!webhook) {
    try {
      const pendingWebhook = await runtime.recordWebhook({
        provider: 'shopify',
        topic: ORDERS_PAID_TOPIC,
        shopifyOrderId: payload?.id ?? null,
        deliveryId,
        status: 'received',
        processingStatus: WEBHOOK_PROCESSING_STATUSES.PENDING,
        hmacValid: hmacWasChecked ? hmacValid : null,
        maxAttempts: runtime.config.SHOPIFY_WEBHOOK_MAX_ATTEMPTS,
        headersJson: redact(req.headers),
        rawPayloadJson: payload,
      });
      const claimResult = await claimExistingWebhook(
        pendingWebhook,
        workerId,
        runtime
      );

      if (claimResult.disposition !== 'claimed') {
        sendClaimUnavailableResponse(res, claimResult.webhook);
        return;
      }

      webhook = claimResult.webhook;
    } catch (error) {
      if (deliveryId && isDuplicateKeyError(error)) {
        try {
          const originalWebhook =
            await runtime.getWebhookByDeliveryId(deliveryId);

          if (originalWebhook) {
            const claimResult = await claimExistingWebhook(
              originalWebhook,
              workerId,
              runtime
            );

            if (claimResult.disposition === 'completed') {
              sendDuplicateDeliveryResponse(res, claimResult.webhook);
              return;
            }

            if (claimResult.disposition === 'unavailable') {
              sendClaimUnavailableResponse(res, claimResult.webhook);
              return;
            }

            webhook = claimResult.webhook;
          }
        } catch (lookupError) {
          console.error(
            'Concurrent Shopify webhook claim failed:',
            safeErrorForLog(lookupError)
          );
        }
      }

      if (!webhook) {
        console.error(
          'Shopify webhook recording failed:',
          safeErrorForLog(error)
        );
        res.status(500).json({ ok: false, error: 'webhook_record_failed' });
        return;
      }
    }
  }

  try {
    const result = await runtime.processWebhookOrder(webhook.id, {
      workerId,
    });
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

    try {
      await runtime.markWebhookFailed(webhook.id, error.message, { workerId });
    } catch (markError) {
      console.error(
        'Shopify webhook failure disposition failed:',
        safeErrorForLog(markError)
      );
    }

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

export default {
  recordOrdersPaidWebhook,
};
