import crypto from 'node:crypto';

function bodyToBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) {
    return rawBody;
  }

  if (typeof rawBody === 'string') {
    return Buffer.from(rawBody, 'utf8');
  }

  if (rawBody instanceof Uint8Array) {
    return Buffer.from(rawBody);
  }

  return Buffer.alloc(0);
}

export function computeShopifyWebhookHmac({ rawBody, secret }) {
  if (!secret) {
    return '';
  }

  return crypto
    .createHmac('sha256', secret)
    .update(bodyToBuffer(rawBody))
    .digest('base64');
}

export function verifyShopifyWebhookHmac({ rawBody, hmacHeader, secret }) {
  if (!secret || !hmacHeader) {
    return false;
  }

  const expectedHmac = computeShopifyWebhookHmac({ rawBody, secret });
  const receivedHmac = String(hmacHeader).trim();
  const expectedBuffer = Buffer.from(expectedHmac, 'utf8');
  const receivedBuffer = Buffer.from(receivedHmac, 'utf8');

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export default {
  computeShopifyWebhookHmac,
  verifyShopifyWebhookHmac,
};
