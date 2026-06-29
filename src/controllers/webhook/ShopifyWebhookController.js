import env from '../../config/env.js';
import {
  markWebhookFailed,
  processWebhookOrder,
  recordWebhook,
} from '../../services/WebhookService.js';
import { logWarning } from '../../services/LogService.js';
import { verifyShopifyWebhookHmac } from '../../utils/shopifyHmac.js';

const REDACTED_HEADER_VALUE = '[REDACTED]';
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-shopify-hmac-sha256',
  'x-shopify-access-token',
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

function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [
      key,
      SENSITIVE_HEADER_NAMES.has(key.toLowerCase())
        ? REDACTED_HEADER_VALUE
        : value,
    ])
  );
}

function getShopifyHmacHeader(req) {
  return req.get('x-shopify-hmac-sha256');
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
      status: 'failed',
      hmacValid,
      headersJson: redactHeaders(req.headers),
      rawPayloadJson: payload,
      errorMessage,
    });
  } catch (error) {
    console.error('Rejected Shopify webhook recording failed:', {
      name: error.name,
      message: error.message,
    });
    return null;
  }
}

export async function recordOrdersPaidWebhook(req, res) {
  let webhook = null;
  const rawBody = getRawBody(req);
  const hmacHeader = getShopifyHmacHeader(req);
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

  try {
    webhook = await recordWebhook({
      provider: 'shopify',
      topic: 'orders/paid',
      shopifyOrderId: payload?.id ?? null,
      hmacValid: hmacWasChecked ? hmacValid : null,
      headersJson: redactHeaders(req.headers),
      rawPayloadJson: payload,
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
