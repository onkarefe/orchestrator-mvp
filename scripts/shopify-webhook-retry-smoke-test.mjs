import assert from 'node:assert/strict';

import { WEBHOOK_PROCESSING_STATUSES } from '../src/constants/statuses.js';
import { handleOrdersPaidWebhook } from '../src/controllers/webhook/ShopifyWebhookController.js';
import {
  claimFailedWebhook,
  findWebhookByDeliveryId,
} from '../src/models/WebhookModel.js';

const DELIVERY_ID = 'shopify-delivery-retry-test';
const PAYLOAD = { id: 7001, line_items: [] };

function createRequest() {
  const headers = {
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': 'valid-test-hmac',
    'x-shopify-webhook-id': DELIVERY_ID,
  };

  return {
    headers,
    rawBody: Buffer.from(JSON.stringify(PAYLOAD)),
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

function createRuntime({ initialStatus, process }) {
  let webhook = {
    id: 41,
    delivery_id: DELIVERY_ID,
    processing_status: initialStatus,
    raw_payload_json: PAYLOAD,
  };
  const calls = { claim: 0, failed: 0, process: 0, record: 0 };

  return {
    calls,
    getState: () => ({ ...webhook }),
    runtime: {
      config: {
        SHOPIFY_WEBHOOK_HMAC_REQUIRED: true,
        SHOPIFY_WEBHOOK_SECRET: 'test-secret',
        SHOPIFY_WEBHOOK_STORE_INVALID: true,
      },
      verifyShopifyWebhookHmac: () => true,
      logWarning: async () => null,
      getWebhookByDeliveryId: async () => ({ ...webhook }),
      claimFailedWebhookRetry: async (id) => {
        calls.claim += 1;

        if (
          id !== webhook.id ||
          webhook.processing_status !== WEBHOOK_PROCESSING_STATUSES.FAILED
        ) {
          return null;
        }

        webhook = {
          ...webhook,
          status: WEBHOOK_PROCESSING_STATUSES.PROCESSING,
          processing_status: WEBHOOK_PROCESSING_STATUSES.PROCESSING,
          error_message: null,
        };
        return { ...webhook };
      },
      recordWebhook: async () => {
        calls.record += 1;
        throw new Error('Existing delivery must not create another webhook row');
      },
      processWebhookOrder: async (id) => {
        calls.process += 1;
        const result = await process(id);
        webhook = {
          ...webhook,
          status: WEBHOOK_PROCESSING_STATUSES.PROCESSED,
          processing_status: WEBHOOK_PROCESSING_STATUSES.PROCESSED,
        };
        return result;
      },
      markWebhookFailed: async (id, errorMessage) => {
        calls.failed += 1;
        assert.equal(id, webhook.id);
        webhook = {
          ...webhook,
          status: WEBHOOK_PROCESSING_STATUSES.FAILED,
          processing_status: WEBHOOK_PROCESSING_STATUSES.FAILED,
          error_message: errorMessage,
        };
        return { ...webhook };
      },
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

async function invoke(runtime) {
  const response = createResponse();
  await handleOrdersPaidWebhook(createRequest(), response, runtime);
  return response;
}

{
  const fixture = createRuntime({
    initialStatus: WEBHOOK_PROCESSING_STATUSES.PROCESSED,
    process: async () => successfulOrderResult(),
  });
  const response = await invoke(fixture.runtime);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.duplicate, true);
  assert.equal(fixture.calls.claim, 0);
  assert.equal(fixture.calls.process, 0);
  assert.equal(fixture.calls.record, 0);
}

{
  const fixture = createRuntime({
    initialStatus: WEBHOOK_PROCESSING_STATUSES.PROCESSING,
    process: async () => successfulOrderResult(),
  });
  const response = await invoke(fixture.runtime);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.duplicate, true);
  assert.equal(fixture.calls.claim, 0);
  assert.equal(fixture.calls.process, 0);
}

{
  const fixture = createRuntime({
    initialStatus: WEBHOOK_PROCESSING_STATUSES.FAILED,
    process: async () => successfulOrderResult(),
  });
  const response = await invoke(fixture.runtime);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'processed');
  assert.equal(fixture.calls.claim, 1);
  assert.equal(fixture.calls.process, 1);
  assert.equal(fixture.calls.record, 0);
  assert.equal(
    fixture.getState().processing_status,
    WEBHOOK_PROCESSING_STATUSES.PROCESSED
  );
}

{
  const fixture = createRuntime({
    initialStatus: WEBHOOK_PROCESSING_STATUSES.FAILED,
    process: async () => {
      throw new Error('retry processing failed');
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
  assert.equal(response.body.error, 'webhook_processing_failed');
  assert.equal(fixture.calls.claim, 1);
  assert.equal(fixture.calls.process, 1);
  assert.equal(fixture.calls.failed, 1);
  assert.equal(
    fixture.getState().processing_status,
    WEBHOOK_PROCESSING_STATUSES.FAILED
  );
}

{
  let releaseProcessing;
  const processingGate = new Promise((resolve) => {
    releaseProcessing = resolve;
  });
  const fixture = createRuntime({
    initialStatus: WEBHOOK_PROCESSING_STATUSES.FAILED,
    process: async () => {
      await processingGate;
      return successfulOrderResult();
    },
  });
  const firstResponse = createResponse();
  const secondResponse = createResponse();
  const firstRetry = handleOrdersPaidWebhook(
    createRequest(),
    firstResponse,
    fixture.runtime
  );
  const secondRetry = handleOrdersPaidWebhook(
    createRequest(),
    secondResponse,
    fixture.runtime
  );

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.calls.claim, 2);
  assert.equal(fixture.calls.process, 1);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(secondResponse.body.duplicate, true);

  releaseProcessing();
  await Promise.all([firstRetry, secondRetry]);

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(fixture.calls.process, 1);
  assert.equal(
    fixture.getState().processing_status,
    WEBHOOK_PROCESSING_STATUSES.PROCESSED
  );
}

{
  const failedRow = {
    id: 77,
    delivery_id: DELIVERY_ID,
    processing_status: WEBHOOK_PROCESSING_STATUSES.FAILED,
  };
  const executor = {
    async execute(sql, params) {
      assert.ok(sql.includes('processing_status IN (?, ?, ?, ?, ?)'));
      assert.ok(params.includes(WEBHOOK_PROCESSING_STATUSES.FAILED));
      return [[failedRow]];
    },
  };

  const found = await findWebhookByDeliveryId(DELIVERY_ID, executor);
  assert.equal(found.processing_status, WEBHOOK_PROCESSING_STATUSES.FAILED);
}

{
  const row = {
    id: 88,
    status: WEBHOOK_PROCESSING_STATUSES.FAILED,
    processing_status: WEBHOOK_PROCESSING_STATUSES.FAILED,
    error_message: 'first failure',
    processed_at: null,
  };
  const executor = {
    async execute(sql, params) {
      if (sql.startsWith('UPDATE webhooks')) {
        const [status, processingStatus, id, expectedStatus] = params;

        if (row.id !== id || row.processing_status !== expectedStatus) {
          return [{ affectedRows: 0 }];
        }

        row.status = status;
        row.processing_status = processingStatus;
        row.error_message = null;
        row.processed_at = null;
        return [{ affectedRows: 1 }];
      }

      if (sql.startsWith('SELECT * FROM webhooks WHERE id')) {
        return [[{ ...row }]];
      }

      throw new Error('Unexpected SQL in retry claim test');
    },
  };

  const claims = await Promise.all([
    claimFailedWebhook(row.id, executor),
    claimFailedWebhook(row.id, executor),
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(row.processing_status, WEBHOOK_PROCESSING_STATUSES.PROCESSING);
}

console.log('shopify webhook retry safety smoke ok');
