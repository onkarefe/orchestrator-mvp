import assert from 'node:assert/strict';

import { validateServerStartupEnv } from '../src/config/startupValidation.js';
import {
  buildNexoShopifyTaskIdempotencyKey,
  getNexoDeliveryIdentity,
  getNexoOrderStatus,
  getNexoStatusSequenceIssue,
  validateNexoCallbackPayload,
} from '../src/services/NexoCallbackAdapter.js';
import { REDACTED_VALUE, redact } from '../src/utils/redact.js';

const basePayload = {
  timestamp: '2026-07-15 12:00:00',
  job_id: 123456,
  reference: 'WANDINI-S7248237232408',
};

const expectedMappings = {
  accepted: 'factory_received',
  ready_to_print: 'production_started',
  printed: 'production_completed',
};

for (const [status, expectedOrderStatus] of Object.entries(expectedMappings)) {
  const validation = validateNexoCallbackPayload({
    ...basePayload,
    status,
  });

  assert.equal(validation.ok, true);
  assert.equal(validation.normalized.nexoJobId, '123456');
  assert.equal(getNexoOrderStatus(status), expectedOrderStatus);
}

const shipped = validateNexoCallbackPayload({
  ...basePayload,
  status: 'shipped',
  parcel_service: 'UPS',
  tracking_numbers: [
    { number: '1ZABC123456789', url: 'https://example.test/track/one' },
    { number: '1ZDEF987654321', url: 'https://example.test/track/two' },
    { number: '1ZABC123456789', url: 'https://example.test/track/one' },
  ],
});

assert.equal(shipped.ok, true);
assert.equal(getNexoOrderStatus('shipped'), 'shipped');
assert.deepEqual(shipped.normalized.trackingNumbers, [
  { number: '1ZABC123456789', url: 'https://example.test/track/one' },
  { number: '1ZDEF987654321', url: 'https://example.test/track/two' },
]);

const invalidTrackingUrl = validateNexoCallbackPayload({
  ...basePayload,
  status: 'shipped',
  tracking_numbers: [{ number: '1ZABC123456789', url: null }],
});

assert.equal(invalidTrackingUrl.ok, false);
assert.ok(
  invalidTrackingUrl.errors.includes('tracking_numbers_0_url_must_be_string')
);

const unknownStatus = validateNexoCallbackPayload({
  ...basePayload,
  status: 'unknown_status',
});

assert.equal(unknownStatus.ok, false);
assert.ok(unknownStatus.errors.includes('unsupported_nexo_status'));
assert.equal(getNexoOrderStatus('cancelled'), 'manual_review');
assert.equal(getNexoOrderStatus('error'), 'manual_review');
assert.equal(getNexoStatusSequenceIssue(null, 'accepted'), null);
assert.equal(
  getNexoStatusSequenceIssue('accepted', 'printed'),
  'nexo_status_out_of_order'
);

const missingReference = validateNexoCallbackPayload({
  timestamp: basePayload.timestamp,
  job_id: basePayload.job_id,
  status: 'accepted',
});

assert.equal(missingReference.ok, false);
assert.ok(missingReference.errors.includes('reference_required'));

const legacyJobReference = validateNexoCallbackPayload({
  ...basePayload,
  reference: 'WANDINI-S7248237232408-J24',
  status: 'accepted',
});
assert.equal(legacyJobReference.ok, false);
assert.ok(legacyJobReference.errors.includes('reference_invalid_format'));

const firstEventKey = getNexoDeliveryIdentity({
  headers: {},
  normalized: shipped.normalized,
}).deliveryId;
const reorderedShipped = validateNexoCallbackPayload({
  ...basePayload,
  status: 'shipped',
  parcel_service: 'UPS',
  tracking_numbers: [
    { number: '1ZDEF987654321', url: 'https://example.test/track/two' },
    { number: '1ZABC123456789', url: 'https://example.test/track/one' },
  ],
});
const secondEventKey = getNexoDeliveryIdentity({
  headers: {},
  normalized: reorderedShipped.normalized,
}).deliveryId;

assert.equal(firstEventKey, secondEventKey);
assert.match(firstEventKey, /^nexo-event:[a-f0-9]{64}$/);

const shippedTaskKey = buildNexoShopifyTaskIdempotencyKey({
  orderFactoryPackageId: 24,
  reference: basePayload.reference,
  taskType: 'order_shipped',
});
const sameTrackingTaskKey = buildNexoShopifyTaskIdempotencyKey({
  orderFactoryPackageId: 24,
  reference: basePayload.reference,
  taskType: 'order_shipped',
});

assert.equal(shippedTaskKey, sameTrackingTaskKey);

const firstHeaderKey = getNexoDeliveryIdentity({
  headers: { 'x-nexo-callback-id': 'delivery-123' },
  normalized: shipped.normalized,
}).deliveryId;
const alternateHeaderKey = getNexoDeliveryIdentity({
  headers: { 'x-nexo-event-id': 'delivery-123' },
  normalized: shipped.normalized,
}).deliveryId;

assert.equal(firstHeaderKey, alternateHeaderKey);

const redactedHeaders = redact({
  'x-nexo-api-key': 'secret-one',
  'x-nexo-callback-api-key': 'secret-two',
  authorization: 'Bearer secret-three',
});

assert.equal(redactedHeaders['x-nexo-api-key'], REDACTED_VALUE);
assert.equal(redactedHeaders['x-nexo-callback-api-key'], REDACTED_VALUE);
assert.equal(redactedHeaders.authorization, REDACTED_VALUE);

const startupBase = {
  WALLPAPER_SKUS: ['20-140.1-3'],
  SHOPIFY_WEBHOOK_HMAC_REQUIRED: false,
  SHOPIFY_SHOP_DOMAIN: 'shop.myshopify.com',
  FACTORY_CALLBACK_ENABLED: false,
  NEXO_CALLBACK_AUTH_ENABLED: true,
  NEXO_CALLBACK_API_KEY: '',
};

assert.equal(
  validateServerStartupEnv({
    ...startupBase,
    NEXO_CALLBACK_ENABLED: false,
  }),
  true
);
assert.throws(
  () =>
    validateServerStartupEnv({
      ...startupBase,
      NEXO_CALLBACK_ENABLED: true,
    }),
  /NEXO_CALLBACK_API_KEY/
);

console.log('nexo adapter smoke ok');
