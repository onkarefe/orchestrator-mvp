import assert from 'node:assert/strict';

import { WEBHOOK_PROCESSING_STATUSES } from '../src/constants/statuses.js';
import { handleOrdersPaidWebhook } from '../src/controllers/webhook/ShopifyWebhookController.js';
import { claimWebhook } from '../src/models/WebhookModel.js';

const DELIVERY_ID = 'shopify-delivery-retry-test';
const SHOP_DOMAIN = 'wandini-test.myshopify.com';
const BASE_PAYLOAD = {
  id: 7001,
  financial_status: 'paid',
  shipping_address: {
    name: 'Webhook Customer',
    address1: 'Street 1',
    zip: '12345',
    city: 'Berlin',
    country_code: 'DE',
  },
  line_items: [],
};

function createRequest({
  payload = BASE_PAYLOAD,
  topic = 'orders/paid',
  shopDomain = SHOP_DOMAIN,
  hmac = 'valid-test-hmac',
} = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': hmac,
    'x-shopify-webhook-id': DELIVERY_ID,
    'x-shopify-topic': topic,
    'x-shopify-shop-domain': shopDomain,
  };

  return {
    headers,
    rawBody: Buffer.from(JSON.stringify(payload)),
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

function createResponse() {
  return {
    body: null,
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function successfulOrderResult() {
  return {
    duplicate: false,
    order: { id: 501 },
    jobs: [{ id: 601 }],
    skippedDuplicateJobs: [],
    manualReviewJobs: [],
  };
}

function buildWebhook(status, overrides = {}) {
  return {
    id: 41,
    delivery_id: DELIVERY_ID,
    processing_status: status,
    status,
    hmac_valid: 1,
    attempt_count: 0,
    max_attempts: 3,
    locked_at: null,
    locked_by: null,
    raw_payload_json: BASE_PAYLOAD,
    ...overrides,
  };
}

function createRuntime({
  initialWebhook = null,
  process = async () => successfulOrderResult(),
  hmacValid = true,
} = {}) {
  let webhook = initialWebhook ? { ...initialWebhook } : null;
  const calls = {
    claim: 0,
    failed: 0,
    process: 0,
    record: 0,
    rejected: 0,
  };
  const config = {
    SHOPIFY_WEBHOOK_HMAC_REQUIRED: true,
    SHOPIFY_WEBHOOK_SECRET: 'test-secret',
    SHOPIFY_WEBHOOK_STORE_INVALID: true,
    SHOPIFY_WEBHOOK_MAX_ATTEMPTS: 3,
    SHOPIFY_WEBHOOK_STALE_LOCK_MINUTES: 30,
    SHOPIFY_SHOP_DOMAIN: SHOP_DOMAIN,
  };

  return {
    calls,
    getState: () => (webhook ? { ...webhook } : null),
    runtime: {
      config,
      getWebhookWorkerId: () => 'test-webhook-worker',
      verifyShopifyWebhookHmac: () => hmacValid,
      logWarning: async () => null,
      getWebhookByDeliveryId: async () =>
        webhook &&
        [
          WEBHOOK_PROCESSING_STATUSES.PENDING,
          WEBHOOK_PROCESSING_STATUSES.PROCESSING,
          WEBHOOK_PROCESSING_STATUSES.PROCESSED,
          WEBHOOK_PROCESSING_STATUSES.FAILED,
        ].includes(webhook.processing_status)
          ? { ...webhook }
          : null,
      claimWebhookProcessing: async (id, options) => {
        calls.claim += 1;
        const staleBefore =
          Date.now() - options.staleLockMinutes * 60 * 1000;
        const staleProcessing =
          webhook?.processing_status ===
            WEBHOOK_PROCESSING_STATUSES.PROCESSING &&
          (!webhook.locked_at ||
            new Date(webhook.locked_at).getTime() < staleBefore);
        const eligible =
          webhook &&
          webhook.id === id &&
          ([
            WEBHOOK_PROCESSING_STATUSES.PENDING,
            WEBHOOK_PROCESSING_STATUSES.FAILED,
          ].includes(webhook.processing_status) ||
            staleProcessing) &&
          webhook.attempt_count < webhook.max_attempts;

        if (!eligible) {
          return null;
        }

        webhook = {
          ...webhook,
          status: WEBHOOK_PROCESSING_STATUSES.PROCESSING,
          processing_status: WEBHOOK_PROCESSING_STATUSES.PROCESSING,
          attempt_count: webhook.attempt_count + 1,
          locked_at: new Date(),
          locked_by: options.workerId,
          error_message: null,
        };
        return { ...webhook };
      },
      recordWebhook: async (data) => {
        calls.record += 1;

        if (
          data.processingStatus === WEBHOOK_PROCESSING_STATUSES.REJECTED ||
          data.processingStatus === WEBHOOK_PROCESSING_STATUSES.INVALID_HMAC
        ) {
          calls.rejected += 1;
          return buildWebhook(data.processingStatus, {
            id: 90 + calls.record,
            processing_status: data.processingStatus,
            hmac_valid: data.hmacValid,
          });
        }

        webhook = buildWebhook(WEBHOOK_PROCESSING_STATUSES.PENDING, {
          max_attempts: data.maxAttempts,
          raw_payload_json: data.rawPayloadJson,
        });
        return { ...webhook };
      },
      processWebhookOrder: async (id, { workerId }) => {
        calls.process += 1;
        assert.equal(id, webhook.id);
        assert.equal(webhook.locked_by, workerId);
        const result = await process(id);
        webhook = {
          ...webhook,
          status: WEBHOOK_PROCESSING_STATUSES.PROCESSED,
          processing_status: WEBHOOK_PROCESSING_STATUSES.PROCESSED,
          locked_at: null,
          locked_by: null,
        };
        return result;
      },
      markWebhookFailed: async (id, errorMessage, { workerId }) => {
        calls.failed += 1;
        assert.equal(id, webhook.id);
        assert.equal(workerId, webhook.locked_by);
        webhook = {
          ...webhook,
          status: WEBHOOK_PROCESSING_STATUSES.FAILED,
          processing_status: WEBHOOK_PROCESSING_STATUSES.FAILED,
          error_message: errorMessage,
          locked_at: null,
          locked_by: null,
        };
        return { ...webhook };
      },
    },
  };
}

async function invoke(runtime, request = createRequest()) {
  const response = createResponse();
  await handleOrdersPaidWebhook(request, response, runtime);
  return response;
}

{
  const fixture = createRuntime();
  const response = await invoke(fixture.runtime);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'processed');
  assert.deepEqual(fixture.calls, {
    claim: 1,
    failed: 0,
    process: 1,
    record: 1,
    rejected: 0,
  });
}

{
  const fixture = createRuntime({
    initialWebhook: buildWebhook(WEBHOOK_PROCESSING_STATUSES.PROCESSED),
  });
  const response = await invoke(fixture.runtime);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.duplicate, true);
  assert.equal(fixture.calls.process, 0);
}

for (const status of [
  WEBHOOK_PROCESSING_STATUSES.FAILED,
  WEBHOOK_PROCESSING_STATUSES.PENDING,
]) {
  const fixture = createRuntime({ initialWebhook: buildWebhook(status) });
  const response = await invoke(fixture.runtime);
  assert.equal(response.statusCode, 200);
  assert.equal(fixture.calls.claim, 1);
  assert.equal(fixture.calls.process, 1);
}

{
  const fixture = createRuntime({
    initialWebhook: buildWebhook(WEBHOOK_PROCESSING_STATUSES.PROCESSING, {
      attempt_count: 1,
      locked_at: new Date(Date.now() - 31 * 60 * 1000),
      locked_by: 'crashed-worker',
    }),
  });
  const response = await invoke(fixture.runtime);
  assert.equal(response.statusCode, 200);
  assert.equal(fixture.calls.process, 1);
  assert.equal(fixture.getState().attempt_count, 2);
}

{
  const fixture = createRuntime({
    initialWebhook: buildWebhook(WEBHOOK_PROCESSING_STATUSES.PROCESSING, {
      attempt_count: 0,
      locked_at: null,
      locked_by: null,
    }),
  });
  const response = await invoke(fixture.runtime);
  assert.equal(response.statusCode, 200);
  assert.equal(fixture.calls.process, 1);
  assert.equal(fixture.getState().attempt_count, 1);
}

{
  const fixture = createRuntime({
    initialWebhook: buildWebhook(WEBHOOK_PROCESSING_STATUSES.PROCESSING, {
      attempt_count: 1,
      locked_at: new Date(),
      locked_by: 'active-worker',
    }),
  });
  const response = await invoke(fixture.runtime);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, 'webhook_processing_in_progress');
  assert.equal(fixture.calls.process, 0);
}

{
  let releaseProcessing;
  const gate = new Promise((resolve) => {
    releaseProcessing = resolve;
  });
  const fixture = createRuntime({
    initialWebhook: buildWebhook(WEBHOOK_PROCESSING_STATUSES.PENDING),
    process: async () => {
      await gate;
      return successfulOrderResult();
    },
  });
  const firstResponse = createResponse();
  const secondResponse = createResponse();
  const first = handleOrdersPaidWebhook(
    createRequest(),
    firstResponse,
    fixture.runtime
  );
  await new Promise((resolve) => setImmediate(resolve));
  const second = handleOrdersPaidWebhook(
    createRequest(),
    secondResponse,
    fixture.runtime
  );
  await second;
  assert.equal(secondResponse.statusCode, 409);
  assert.equal(fixture.calls.process, 1);
  releaseProcessing();
  await first;
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(fixture.calls.process, 1);
}

{
  const fixture = createRuntime({
    initialWebhook: buildWebhook(WEBHOOK_PROCESSING_STATUSES.FAILED),
    process: async () => {
      throw new Error('simulated crash-safe failure');
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  let response;

  try {
    response = await invoke(fixture.runtime);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 500);
  assert.equal(fixture.calls.failed, 1);
  assert.equal(
    fixture.getState().processing_status,
    WEBHOOK_PROCESSING_STATUSES.FAILED
  );
}

{
  let firstAttempt = true;
  let createdOrderCount = 0;
  let createdJobCount = 0;
  const fixture = createRuntime({
    initialWebhook: buildWebhook(WEBHOOK_PROCESSING_STATUSES.PENDING),
    process: async () => {
      if (firstAttempt) {
        firstAttempt = false;
        createdOrderCount += 1;
        createdJobCount += 1;
        throw new Error('crash after durable business commit');
      }

      return {
        duplicate: true,
        order: { id: 501 },
        jobs: [],
        skippedDuplicateJobs: [{ id: 601 }],
        manualReviewJobs: [],
      };
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  let firstResponse;

  try {
    firstResponse = await invoke(fixture.runtime);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(firstResponse.statusCode, 500);
  assert.equal(
    fixture.getState().processing_status,
    WEBHOOK_PROCESSING_STATUSES.FAILED
  );
  const retryResponse = await invoke(fixture.runtime);
  assert.equal(retryResponse.statusCode, 200);
  assert.equal(retryResponse.body.status, 'already_processed');
  assert.equal(createdOrderCount, 1);
  assert.equal(createdJobCount, 1);
}

for (const [request, expectedStatus, expectedError] of [
  [
    createRequest({ topic: 'orders/create' }),
    400,
    'invalid_shopify_webhook_topic',
  ],
  [
    createRequest({ shopDomain: 'other-shop.myshopify.com' }),
    403,
    'invalid_shopify_webhook_shop',
  ],
]) {
  const fixture = createRuntime();
  const response = await invoke(fixture.runtime, request);
  assert.equal(response.statusCode, expectedStatus);
  assert.equal(response.body.error, expectedError);
  assert.equal(fixture.calls.process, 0);
  assert.equal(fixture.calls.rejected, 1);
}

{
  const fixture = createRuntime({ hmacValid: false });
  const response = await invoke(
    fixture.runtime,
    createRequest({ topic: 'orders/create' })
  );
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, 'invalid_shopify_webhook_hmac');
  assert.equal(fixture.calls.process, 0);
  assert.equal(fixture.calls.rejected, 1);
}

{
  const fixture = createRuntime();
  const response = await invoke(
    fixture.runtime,
    createRequest({
      payload: { ...BASE_PAYLOAD, financial_status: 'pending' },
    })
  );
  assert.equal(response.statusCode, 422);
  assert.equal(fixture.calls.process, 0);
}

{
  const fixture = createRuntime();
  const response = await invoke(
    fixture.runtime,
    createRequest({
      payload: {
        ...BASE_PAYLOAD,
        financial_status: 'refunded',
        cancelled_at: '2026-09-07T12:00:00Z',
      },
    })
  );
  assert.equal(response.statusCode, 200);
  assert.equal(fixture.calls.process, 1);
}

{
  const row = buildWebhook(WEBHOOK_PROCESSING_STATUSES.PENDING, { id: 88 });
  const executor = {
    async execute(sql, params) {
      if (sql.startsWith('UPDATE webhooks')) {
        const staleBefore = Date.now() - params[9] * 60 * 1000;
        const staleProcessing =
          row.processing_status === params[8] &&
          row.locked_at &&
          new Date(row.locked_at).getTime() < staleBefore;
        const eligible =
          row.id === params[5] &&
          ([params[6], params[7]].includes(row.processing_status) ||
            staleProcessing) &&
          row.attempt_count < Math.min(row.max_attempts, params[10], params[11]);

        if (!eligible) {
          return [{ affectedRows: 0 }];
        }

        row.status = params[0];
        row.processing_status = params[1];
        row.attempt_count += 1;
        row.locked_at = new Date();
        row.locked_by = params[4];
        return [{ affectedRows: 1 }];
      }

      if (sql.startsWith('SELECT * FROM webhooks WHERE id')) {
        return [[{ ...row }]];
      }

      throw new Error('Unexpected SQL in webhook claim test');
    },
  };
  const options = {
    workerId: 'atomic-worker',
    maxAttempts: 3,
    staleLockMinutes: 30,
  };
  const claims = await Promise.all([
    claimWebhook(row.id, options, executor),
    claimWebhook(row.id, options, executor),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(row.attempt_count, 1);
}

console.log('shopify webhook durable claim safety smoke ok');
