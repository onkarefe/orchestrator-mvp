import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { FACTORY_CALLBACK_PROCESSING_STATUSES } from '../src/constants/statuses.js';
import { receiveNexoCallback } from '../src/services/NexoCallbackService.js';
import { ensureNexoShopifyUpdateTask } from '../src/services/ShopifyUpdateTaskService.js';

const config = {
  NEXO_CALLBACK_AUTH_ENABLED: true,
  NEXO_CALLBACK_API_KEY: 'order-callback-secret',
};
const headers = { 'x-nexo-api-key': config.NEXO_CALLBACK_API_KEY };

function payload({
  shopifyOrderId = '7248237232408',
  nexoExternalId = '123456',
  status = 'accepted',
  sequence = 1,
  trackingNumbers,
}) {
  const result = {
    timestamp: `2026-09-04 12:00:${String(sequence).padStart(2, '0')}`,
    job_id: nexoExternalId,
    reference: `WANDINI-S${shopifyOrderId}`,
    status,
  };

  if (trackingNumbers !== undefined) {
    result.parcel_service = 'UPS';
    result.tracking_numbers = trackingNumbers;
  }

  return result;
}

function createHarness() {
  const state = {
    order: {
      id: 41,
      shopify_order_id: '7248237232408',
      status: 'completed',
      factory_status: null,
      factory_order_id: null,
      manual_review_reason: null,
    },
    orderPackage: {
      id: 91,
      order_id: 41,
      shopify_order_id: '7248237232408',
      artifact_id: 81,
      order_number: 'WANDINI-S7248237232408',
      status: 'ready',
      nexo_order_id: null,
      factory_status: null,
    },
    artifact: {
      id: 81,
      order_id: 41,
      job_id: null,
      type: 'factory_package',
      status: 'available',
      validation_status: 'passed',
    },
    uploadTask: {
      id: 71,
      order_id: 41,
      job_id: null,
      artifact_id: 81,
      order_factory_package_id: 91,
      shopify_order_id: '7248237232408',
      factory_reference: 'WANDINI-S7248237232408',
      status: 'uploaded',
    },
    callbacks: [],
    shopifyTasks: [],
    logs: [],
    nextCallbackId: 1,
    nextTaskId: 1,
  };
  let transactionTail = Promise.resolve();

  function connection() {
    let releaseLock;

    return {
      async beginTransaction() {
        const previous = transactionTail;
        transactionTail = new Promise((resolve) => {
          releaseLock = resolve;
        });
        await previous;
      },
      async commit() {
        releaseLock();
      },
      async rollback() {
        releaseLock();
      },
      release() {},
    };
  }

  function normalizeCallback(data) {
    return {
      id: state.nextCallbackId++,
      provider: data.provider,
      order_id: data.orderId ?? null,
      job_id: data.jobId ?? null,
      order_factory_package_id: data.orderFactoryPackageId ?? null,
      factory_reference: data.factoryReference ?? null,
      shopify_order_id: data.shopifyOrderId ?? null,
      factory_order_id: data.factoryOrderId ?? null,
      delivery_id: data.deliveryId ?? null,
      status: data.status ?? null,
      tracking_count: data.trackingCount ?? 0,
      raw_payload_json: data.rawPayloadJson,
      headers_json: data.headersJson,
      auth_valid: data.authValid,
      duplicate_of_id: data.duplicateOfId ?? null,
      processing_status: data.processingStatus,
      error_message: data.errorMessage ?? null,
    };
  }

  const taskRuntime = {
    findShopifyUpdateTaskByIdempotencyKey: async (key) =>
      state.shopifyTasks.find((task) => task.idempotency_key === key) ?? null,
    createShopifyUpdateTask: async (draft) => {
      const task = {
        id: state.nextTaskId++,
        order_id: draft.orderId,
        shopify_order_id: draft.shopifyOrderId,
        task_type: draft.taskType,
        idempotency_key: draft.idempotencyKey,
        source_type: draft.sourceType,
        source_id: draft.sourceId,
        status: draft.status,
        payload_json: draft.payloadJson,
        dry_run: draft.dryRun,
      };
      state.shopifyTasks.push(task);
      return task;
    },
  };

  const runtime = {
    getConnection: async () => connection(),
    createFactoryCallback: async (data) => {
      const callback = normalizeCallback(data);
      state.callbacks.push(callback);
      return callback;
    },
    findOriginalFactoryCallbackByDeliveryId: async (deliveryId) =>
      state.callbacks.find(
        (callback) =>
          callback.delivery_id === deliveryId &&
          ['received', 'processing', 'processed'].includes(
            callback.processing_status
          )
      ) ?? null,
    updateFactoryCallbackProcessingStatus: async (id, data) => {
      const callback = state.callbacks.find((item) => item.id === id);
      callback.processing_status = data.processingStatus;
      callback.error_message = data.errorMessage ?? null;
      callback.order_id = data.orderId ?? callback.order_id;
      callback.order_factory_package_id =
        data.orderFactoryPackageId ?? callback.order_factory_package_id;
      callback.duplicate_of_id =
        data.duplicateOfId ?? callback.duplicate_of_id;
      return { ...callback };
    },
    findOrderByShopifyOrderIdForUpdate: async (shopifyOrderId) =>
      String(shopifyOrderId) === String(state.order.shopify_order_id)
        ? { ...state.order }
        : null,
    findOrderFactoryPackageByShopifyOrderIdForUpdate: async (
      shopifyOrderId
    ) =>
      String(shopifyOrderId) === String(state.orderPackage.shopify_order_id)
        ? [{ ...state.orderPackage }]
        : [],
    findArtifactById: async (id) =>
      String(id) === String(state.artifact.id) ? { ...state.artifact } : null,
    findFactoryUploadTaskByOrderPackageId: async (id) =>
      String(id) === String(state.uploadTask.order_factory_package_id)
        ? { ...state.uploadTask }
        : null,
    findOrderFactoryPackageByNexoOrderIdForUpdate: async (nexoOrderId) =>
      String(nexoOrderId) === String(state.orderPackage.nexo_order_id)
        ? { ...state.orderPackage }
        : null,
    updateOrderFactoryPackageNexoState: async (
      id,
      { nexoOrderId, factoryStatus }
    ) => {
      if (
        String(id) !== String(state.orderPackage.id) ||
        (state.orderPackage.nexo_order_id &&
          String(state.orderPackage.nexo_order_id) !== String(nexoOrderId))
      ) {
        return null;
      }

      state.orderPackage.nexo_order_id =
        state.orderPackage.nexo_order_id ?? String(nexoOrderId);
      state.orderPackage.factory_status = factoryStatus;
      return { ...state.orderPackage };
    },
    updateOrderFactoryState: async (id, data) => {
      assert.equal(String(id), String(state.order.id));
      state.order.factory_order_id =
        state.order.factory_order_id ?? String(data.factoryOrderId);
      state.order.factory_status = data.factoryStatus;

      if (data.status) {
        state.order.status = data.status;
      }

      if (data.manualReviewReason) {
        state.order.manual_review_reason = data.manualReviewReason;
      }

      return { ...state.order };
    },
    findLatestNexoCallbackByPackageAndStatus: async ({
      orderFactoryPackageId,
      nexoOrderId,
      status,
    }) =>
      [...state.callbacks]
        .reverse()
        .find(
          (callback) =>
            String(callback.order_factory_package_id) ===
              String(orderFactoryPackageId) &&
            String(callback.factory_order_id) === String(nexoOrderId) &&
            callback.status === status &&
            ['processed', 'manual_review'].includes(
              callback.processing_status
            )
        ) ?? null,
    ensureNexoShopifyUpdateTask: async (options) =>
      ensureNexoShopifyUpdateTask({
        ...options,
        runtime: taskRuntime,
      }),
    logInfo: async (entry) => state.logs.push(entry),
    logWarning: async (entry) => state.logs.push(entry),
  };

  return { state, runtime };
}

async function receive(harness, callbackPayload) {
  return receiveNexoCallback({
    payload: callbackPayload,
    headers,
    config,
    runtime: harness.runtime,
  });
}

const validHarness = createHarness();
const accepted = await receive(validHarness, payload({ status: 'accepted' }));
assert.equal(accepted.httpStatus, 200);
assert.equal(accepted.body.orderId, validHarness.state.order.id);
assert.equal(
  accepted.body.orderFactoryPackageId,
  validHarness.state.orderPackage.id
);
assert.equal(validHarness.state.callbacks[0].job_id, null);
assert.equal(
  validHarness.state.callbacks[0].order_factory_package_id,
  validHarness.state.orderPackage.id
);
assert.equal(validHarness.state.orderPackage.nexo_order_id, '123456');
assert.equal(validHarness.state.orderPackage.factory_status, 'accepted');
assert.equal(validHarness.state.order.factory_status, 'accepted');

const sameExternalId = await receive(
  validHarness,
  payload({ status: 'ready_to_print', sequence: 2 })
);
assert.equal(sameExternalId.httpStatus, 200);
assert.equal(validHarness.state.orderPackage.nexo_order_id, '123456');

const conflictingExternalId = await receive(
  validHarness,
  payload({
    nexoExternalId: '999999',
    status: 'ready_to_print',
    sequence: 3,
  })
);
assert.equal(conflictingExternalId.httpStatus, 202);
assert.equal(conflictingExternalId.body.error, 'nexo_external_id_mismatch');
assert.equal(validHarness.state.orderPackage.nexo_order_id, '123456');
assert.equal(validHarness.state.orderPackage.factory_status, 'ready_to_print');

const malformedHarness = createHarness();
const legacyReference = await receiveNexoCallback({
  payload: {
    ...payload({ status: 'accepted' }),
    reference: 'WANDINI-S7248237232408-J24',
  },
  headers,
  config,
  runtime: malformedHarness.runtime,
});
assert.equal(legacyReference.httpStatus, 400);
assert.ok(legacyReference.body.errors.includes('reference_invalid_format'));
assert.equal(malformedHarness.state.orderPackage.factory_status, null);

const duplicateHarness = createHarness();
const duplicatePayload = payload({ status: 'accepted' });
const firstDelivery = await receive(duplicateHarness, duplicatePayload);
const duplicateDelivery = await receive(duplicateHarness, duplicatePayload);
assert.equal(firstDelivery.body.duplicate, false);
assert.equal(duplicateDelivery.body.duplicate, true);
assert.equal(duplicateHarness.state.callbacks.length, 1);
assert.equal(duplicateHarness.state.shopifyTasks.length, 0);

const sameStatusHarness = createHarness();
await receive(sameStatusHarness, payload({ status: 'accepted', sequence: 1 }));
const duplicateStatus = await receive(
  sameStatusHarness,
  payload({ status: 'accepted', sequence: 2 })
);
assert.equal(duplicateStatus.body.duplicate, true);
assert.equal(
  sameStatusHarness.state.orderPackage.factory_status,
  'accepted'
);

const sequenceHarness = createHarness();
await receive(sequenceHarness, payload({ status: 'accepted', sequence: 1 }));
await receive(
  sequenceHarness,
  payload({ status: 'ready_to_print', sequence: 2 })
);
await receive(sequenceHarness, payload({ status: 'printed', sequence: 3 }));
assert.equal(sequenceHarness.state.orderPackage.factory_status, 'printed');
assert.equal(sequenceHarness.state.order.status, 'production_completed');
assert.equal(sequenceHarness.state.shopifyTasks.length, 0);

const backward = await receive(
  sequenceHarness,
  payload({ status: 'ready_to_print', sequence: 4 })
);
assert.equal(backward.httpStatus, 202);
assert.equal(backward.body.error, 'nexo_status_out_of_order');
assert.equal(sequenceHarness.state.orderPackage.factory_status, 'printed');
assert.equal(sequenceHarness.state.order.status, 'production_completed');

const shippedTracking = [
  { number: '1ZABC123456789', url: 'https://example.test/track/one' },
];
const shipped = await receive(
  sequenceHarness,
  payload({
    status: 'shipped',
    sequence: 5,
    trackingNumbers: shippedTracking,
  })
);
assert.equal(shipped.httpStatus, 200);
assert.equal(sequenceHarness.state.orderPackage.factory_status, 'shipped');
assert.equal(sequenceHarness.state.order.status, 'shipped');
assert.equal(
  sequenceHarness.state.shopifyTasks.filter(
    (task) => task.task_type === 'order_shipped'
  ).length,
  1
);
assert.equal(sequenceHarness.state.shopifyTasks[0].dry_run, false);
assert.equal(sequenceHarness.state.shopifyTasks[0].payload_json.dryRun, false);
assert.equal(
  sequenceHarness.state.shopifyTasks[0].payload_json.writeSuppressed,
  false
);
assert.equal(
  sequenceHarness.state.shopifyTasks[0].payload_json.orderFactoryPackageId,
  sequenceHarness.state.orderPackage.id
);
assert.equal('jobId' in sequenceHarness.state.shopifyTasks[0].payload_json, false);
assert.equal(shipped.body.shopifyUpdateSuppressed, false);

const shippedDuplicate = await receive(
  sequenceHarness,
  payload({
    status: 'shipped',
    sequence: 6,
    trackingNumbers: shippedTracking,
  })
);
assert.equal(shippedDuplicate.body.duplicate, true);
assert.equal(
  sequenceHarness.state.shopifyTasks.filter(
    (task) => task.task_type === 'order_shipped'
  ).length,
  1
);

const invalidTrackingHarness = createHarness();
const invalidTracking = await receive(
  invalidTrackingHarness,
  payload({ status: 'shipped', trackingNumbers: [] })
);
assert.equal(invalidTracking.httpStatus, 400);
assert.ok(
  invalidTracking.body.errors.includes('tracking_numbers_required_for_shipped')
);
assert.equal(invalidTrackingHarness.state.shopifyTasks.length, 0);
assert.equal(invalidTrackingHarness.state.orderPackage.factory_status, null);

const raceHarness = createHarness();
await receive(raceHarness, payload({ status: 'accepted', sequence: 1 }));
await receive(
  raceHarness,
  payload({ status: 'ready_to_print', sequence: 2 })
);
await receive(raceHarness, payload({ status: 'printed', sequence: 3 }));
const racedShipment = payload({
  status: 'shipped',
  sequence: 4,
  trackingNumbers: shippedTracking,
});
const raceResults = await Promise.all([
  receive(raceHarness, racedShipment),
  receive(raceHarness, racedShipment),
]);
assert.equal(raceResults.filter((result) => result.body.duplicate).length, 1);
assert.equal(raceHarness.state.orderPackage.factory_status, 'shipped');
assert.equal(raceHarness.state.order.factory_status, 'shipped');
assert.equal(raceHarness.state.order.status, 'shipped');
assert.equal(
  raceHarness.state.shopifyTasks.filter(
    (task) => task.task_type === 'order_shipped'
  ).length,
  1
);

const migration = await fs.readFile(
  new URL('../src/db/migrations/009_order_level_nexo_callbacks.sql', import.meta.url),
  'utf8'
);
assert.match(migration, /uq_order_factory_packages_nexo_order_id/);
assert.match(migration, /order_factory_package_id/);
assert.doesNotMatch(migration, /UPDATE jobs/i);

console.log('order-level NEXO callback safety smoke ok');
