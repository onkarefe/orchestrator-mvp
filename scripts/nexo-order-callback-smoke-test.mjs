import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

import { FACTORY_CALLBACK_PROCESSING_STATUSES } from '../src/constants/statuses.js';
import { receiveNexoCallback, replayNexoCallback, readNexoCallbackPackage } from '../src/services/NexoCallbackService.js';
import { artifactsDir } from '../src/config/paths.js';
import { ensureNexoShopifyUpdateTask } from '../src/services/ShopifyUpdateTaskService.js';

import { recoverNexoCallbacks } from '../src/services/PipelineRecoveryService.js';
import { listRecoverableNexoCallbackIds } from '../src/models/FactoryCallbackModel.js';

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

function createHarness({ positionLevel = false, count = positionLevel ? 2 : 1 } = {}) {
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
  state.lineItems = Array.from({ length: count }, (_, index) => ({
    id: 30 + index * 12, order_id: state.order.id, shopify_order_id: state.order.shopify_order_id,
    shopify_line_item_id: String(501 + index), source_position: index,
    sku: index === 0 ? '20-140.1-3' : '283-388.0', quantity: 1,
    classification: index === 0 ? 'WALLPAPER' : 'ACCESSORY',
    nexo_job_id: null, nexo_status: null, nexo_parcel_service: null, nexo_tracking_json: null,
  }));
  state.evidence = {
    manifest: {
      order: { id: state.order.id, shopify_order_id: state.order.shopify_order_id, order_number: state.orderPackage.order_number },
      validation: { ok: true, validationStatus: 'passed' },
      contents: { position_count: count, positions: state.lineItems.map(line => ({
        source_position: line.source_position, shopify_line_item_id: line.shopify_line_item_id,
        sku: line.sku, quantity: line.quantity,
      })) },
    },
    xml: `<root><order><order_number>${state.orderPackage.order_number}</order_number></order><positions>${state.lineItems.map(line =>
      `<position>${positionLevel ? `<reference>${state.orderPackage.order_number}-J${line.id}</reference>` : ''}<sku>${line.sku}</sku></position>`
    ).join('')}</positions></root>`,
  };
  let transactionTail = Promise.resolve();
  let activeConnection = null;

  function connection() {
    let releaseLock;
    let snapshot;

    return {
      async beginTransaction() {
        const previous = transactionTail;
        transactionTail = new Promise((resolve) => {
          releaseLock = resolve;
        });
        await previous;
        activeConnection = this;
        snapshot = structuredClone(state);
      },
      async commit() {
        activeConnection = null;
        releaseLock();
      },
      async rollback() {
        Object.assign(state, snapshot);
        activeConnection = null;
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
      order_line_item_id: data.orderLineItemId ?? null,
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
    createShopifyUpdateTask: async (draft, db) => {
      assert.ok(activeConnection, 'Shipment task must be created before callback commit');
      assert.equal(db, activeConnection);
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
    readNexoCallbackPackage: async () => structuredClone(state.evidence),
    listOrderLineItemsByOrderIdForUpdate: async () => structuredClone(state.lineItems),
    findOrderLineItemByNexoJobId: async id => structuredClone(
      state.lineItems.find(line => line.nexo_job_id === id) ?? null
    ),
    updateOrderLineItemNexoState: async (id, data) => {
      const line = state.lineItems.find(item => item.id === id);
      assert.equal(data.orderId, line.order_id);
      if (line.nexo_job_id && line.nexo_job_id !== data.nexoJobId) return false;
      Object.assign(line, {
        nexo_job_id: data.nexoJobId, nexo_status: data.status,
        nexo_parcel_service: data.parcelService ?? null, nexo_tracking_json: data.trackingNumbers ?? null,
      });
      return true;
    },
    updateOrderFactoryPackageAggregateStatus: async (id, status) => {
      assert.equal(id, state.orderPackage.id);
      state.orderPackage.factory_status = status;
      return { ...state.orderPackage };
    },
    getConnection: async () => connection(),
    holdNexoReplayTaskConflict: async (id) => {
      const callback = state.callbacks.find((item) => item.id === id);
      assert.equal(callback.processing_status, 'manual_review');
      callback.error_message = 'nexo_shopify_task_idempotency_conflict';
      return true;
    },
    findFactoryCallbackByIdForUpdate: async (id) =>
      state.callbacks.find((callback) => callback.id === id),
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
      callback.order_line_item_id = data.orderLineItemId ?? callback.order_line_item_id;
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
      if (data.factoryOrderId != null) state.order.factory_order_id =
        state.order.factory_order_id ?? String(data.factoryOrderId);
      if (data.factoryStatus !== undefined) state.order.factory_status = data.factoryStatus;

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
assert.equal(legacyReference.httpStatus, 202);
assert.equal(legacyReference.body.error, 'nexo_position_reference_not_dispatched');
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


const early = createHarness();
early.state.uploadTask.status = 'uploading';
const earlyPayload = payload({ status: 'accepted' });
const held = await receive(early, earlyPayload);
assert.equal(held.body.error, 'order_factory_package_not_dispatched');
assert.equal(early.state.callbacks[0].auth_valid, true);
early.state.uploadTask.status = 'uploaded';
const recovered = await recoverNexoCallbacks({
  config: { WORKER_RECOVERY_BATCH_SIZE: 5 },
  runtime: {
    listRecoverableNexoCallbackIds: async ({ limit }) => {
      assert.equal(limit, 5);
      return [held.body.callbackId];
    },
    replayNexoCallback: (id) => replayNexoCallback(id, { runtime: early.runtime }),
    logError: async () => assert.fail('Replay failed'),
  },
});
assert.equal(recovered.recovered, 1);
assert.equal(early.state.callbacks.length, 1);
assert.equal(early.state.callbacks[0].processing_status, 'processed');
assert.equal(early.state.orderPackage.factory_status, 'accepted');
assert.equal((await replayNexoCallback(held.body.callbackId, {
  runtime: early.runtime,
})).body.skipped, true);
assert.equal((await receive(early, earlyPayload)).body.duplicate, true);

const missingPackage = createHarness();
const findPackages = missingPackage.runtime.findOrderFactoryPackageByShopifyOrderIdForUpdate;
missingPackage.runtime.findOrderFactoryPackageByShopifyOrderIdForUpdate = async () => [];
const noPackage = await receive(missingPackage, earlyPayload);
assert.equal(noPackage.body.error, 'nexo_order_factory_package_not_found');
missingPackage.runtime.findOrderFactoryPackageByShopifyOrderIdForUpdate = findPackages;
assert.equal((await replayNexoCallback(noPackage.body.callbackId, {
  runtime: missingPackage.runtime,
})).body.processingStatus, 'processed');

for (const scenario of ['sequence', 'identity', 'auth', 'payload']) {
  const harness = createHarness();
  harness.state.uploadTask.status = 'uploading';
  const event = payload({ status: scenario === 'sequence' ? 'printed' : 'accepted' });
  const held = await receive(harness, event);
  harness.state.uploadTask.status = 'uploaded';
  if (scenario === 'identity') harness.state.uploadTask.artifact_id = 999;
  if (scenario === 'auth') harness.state.callbacks[0].auth_valid = false;
  if (scenario === 'payload') harness.state.callbacks[0].raw_payload_json = {
    ...event, job_id: 'different-external-id',
  };
  const result = await replayNexoCallback(held.body.callbackId, { runtime: harness.runtime });
  assert.equal(harness.state.orderPackage.factory_status, null);
  assert.equal(harness.state.callbacks[0].processing_status, 'manual_review');
  if (scenario === 'sequence') assert.equal(result.body.error, 'nexo_status_out_of_order');
  if (scenario === 'identity') assert.equal(result.body.error, 'order_factory_upload_identity_mismatch');
  if (scenario === 'auth') assert.equal(result.body.skipped, true);
  if (scenario === 'payload') assert.equal(result.body.error, 'nexo_replay_payload_identity_mismatch');
}

const concurrentReplay = createHarness();
concurrentReplay.state.uploadTask.status = 'uploading';
const concurrentlyHeld = await receive(concurrentReplay, earlyPayload);
concurrentReplay.state.uploadTask.status = 'uploaded';
const replayResults = await Promise.all([1, 2].map(() => replayNexoCallback(
  concurrentlyHeld.body.callbackId, { runtime: concurrentReplay.runtime }
)));
assert.equal(replayResults.filter((result) => result.body.processingStatus === 'processed').length, 1);
assert.equal(replayResults.filter((result) => result.body.skipped).length, 1);
assert.equal(concurrentReplay.state.callbacks.length, 1);

const conflictReplay = createHarness();
conflictReplay.state.uploadTask.status = 'uploading';
const conflictHeld = await receive(conflictReplay, earlyPayload);
conflictReplay.state.uploadTask.status = 'uploaded';
conflictReplay.runtime.ensureNexoShopifyUpdateTask = async () => {
  throw Object.assign(new Error('conflicting task'), {
    code: 'NEXO_SHOPIFY_TASK_IDEMPOTENCY_CONFLICT',
  });
};
assert.equal((await replayNexoCallback(conflictHeld.body.callbackId, {
  runtime: conflictReplay.runtime,
})).body.error, 'nexo_shopify_task_idempotency_conflict');
assert.equal(conflictReplay.state.orderPackage.factory_status, null);
assert.equal((await replayNexoCallback(conflictHeld.body.callbackId, {
  runtime: conflictReplay.runtime,
})).body.skipped, true);

const deliveredBeforeReplay = createHarness();
deliveredBeforeReplay.state.uploadTask.status = 'uploading';
const earlier = await receive(deliveredBeforeReplay, earlyPayload);
deliveredBeforeReplay.state.uploadTask.status = 'uploaded';
await receive(deliveredBeforeReplay, earlyPayload);
assert.equal((await replayNexoCallback(earlier.body.callbackId, {
  runtime: deliveredBeforeReplay.runtime,
})).body.duplicate, true);
assert.equal(deliveredBeforeReplay.state.callbacks[0].processing_status, 'duplicate');

await listRecoverableNexoCallbackIds({
  limit: 5, db: { async query(sql, params) {
    assert.match(sql, /c.auth_valid = 1/);
    assert.match(sql, /c.processing_status = 'manual_review'/);
    assert.match(sql, /t.status = 'uploaded'/);
    assert.match(sql, /ORDER BY c.id ASC LIMIT \?/);
    assert.deepEqual(params, [
      'nexo_order_factory_package_not_found', 'order_factory_package_not_dispatched', 5,
    ]);
    return [[]];
  }},
});
// A new shipped delivery may skip both intermediate statuses.
const jumpHarness = createHarness();
await receive(jumpHarness, payload({ status: 'accepted', sequence: 1 }));

// Historical sequence rejections stay held even though that jump is now legal.
const historicalPayload = payload({
  status: 'shipped', sequence: 2, trackingNumbers: shippedTracking,
});
const historicalCallback = await jumpHarness.runtime.createFactoryCallback({
  provider: 'nexo',
  orderId: jumpHarness.state.order.id,
  orderFactoryPackageId: jumpHarness.state.orderPackage.id,
  factoryReference: historicalPayload.reference,
  shopifyOrderId: jumpHarness.state.order.shopify_order_id,
  factoryOrderId: String(historicalPayload.job_id),
  status: 'shipped',
  rawPayloadJson: historicalPayload,
  authValid: true,
  processingStatus: 'manual_review',
  errorMessage: 'nexo_status_out_of_order',
});
assert.equal((await replayNexoCallback(historicalCallback.id, {
  runtime: jumpHarness.runtime,
})).body.skipped, true);
assert.equal(historicalCallback.processing_status, 'manual_review');
assert.equal(jumpHarness.state.orderPackage.factory_status, 'accepted');
assert.equal(jumpHarness.state.shopifyTasks.length, 0);

const jumpPayload = payload({
  status: 'shipped', sequence: 3, trackingNumbers: shippedTracking,
});
const jumpResult = await receive(jumpHarness, jumpPayload);
assert.equal(jumpResult.httpStatus, 200);
assert.equal(jumpResult.body.processingStatus, 'processed');
assert.equal(jumpResult.body.shopifyUpdateTaskCreated, true);
assert.equal(jumpHarness.state.orderPackage.factory_status, 'shipped');
assert.equal(jumpHarness.state.order.status, 'shipped');
assert.equal(jumpHarness.state.shopifyTasks.length, 1);
assert.equal(jumpHarness.state.shopifyTasks[0].task_type, 'order_shipped');

assert.equal((await receive(jumpHarness, jumpPayload)).body.duplicate, true);
assert.equal((await receive(jumpHarness, payload({
  status: 'shipped', sequence: 4, trackingNumbers: shippedTracking,
}))).body.duplicate, true);
assert.equal(jumpHarness.state.shopifyTasks.length, 1);
assert.equal(jumpHarness.state.shopifyTasks[0].id, jumpResult.body.shopifyUpdateTaskId);

// A held order cannot be revived, including same-status shipped replay.
for (const priorStatus of [null, 'shipped']) {
  const held = createHarness();
  held.state.order.status = 'SECURITY_HOLD';
  held.state.orderPackage.factory_status = priorStatus;
  const outcome = await receive(held, payload({ status: 'shipped', trackingNumbers: shippedTracking }));
  assert.equal(outcome.body.error, 'checkout_security_hold');
  assert.equal(held.state.order.status, 'SECURITY_HOLD');
  assert.equal(held.state.orderPackage.factory_status, priorStatus);
  assert.equal(held.state.shopifyTasks.length, 0);
}
function positionPayload(id, options = {}) {
  return { ...payload({ nexoExternalId: String(10808370 + id), ...options }),
    reference: `WANDINI-S7248237232408-J${id}` };
}
function productionState(harness) {
  const { order, orderPackage, lineItems, shopifyTasks } = harness.state;
  return structuredClone({ order, orderPackage, lineItems, shopifyTasks });
}
const positions = createHarness({ positionLevel: true });
const initialPrinted = await receive(positions, positionPayload(30, { status: 'printed' }));
assert.equal(initialPrinted.httpStatus, 200);
assert.equal(positions.state.lineItems[0].nexo_status, 'printed');
assert.equal(positions.state.lineItems[1].nexo_status, null);
assert.equal(positions.state.order.status, 'completed');
assert.equal(positions.state.order.factory_status, null);
assert.equal(positions.state.callbacks[0].order_line_item_id, 30);
assert.equal(positions.state.callbacks[0].job_id, null);
assert.equal(positions.state.callbacks[0].headers_json['x-nexo-api-key'], '[REDACTED]');
assert.equal((await receive(positions, positionPayload(42))).httpStatus, 200);
assert.equal(positions.state.order.status, 'factory_received');
assert.equal(positions.state.orderPackage.factory_status, 'accepted');
assert.equal(new Set(positions.state.lineItems.map(line => line.nexo_job_id)).size, 2);
await receive(positions, positionPayload(42, { status: 'ready_to_print', sequence: 2 }));
assert.equal(positions.state.order.status, 'production_started');
assert.equal(positions.state.order.factory_status, 'ready_to_print');
await receive(positions, positionPayload(42, { status: 'printed', sequence: 3 }));
assert.equal(positions.state.order.status, 'production_completed');

for (const [options, error] of [
  [{ status: 'accepted', sequence: 4 }, 'nexo_status_out_of_order'],
  [{ status: 'printed', nexoExternalId: 'wrong-id', sequence: 5 }, 'nexo_position_external_id_mismatch'],
]) {
  const before = productionState(positions);
  const result = await receive(positions, positionPayload(30, options));
  assert.equal(result.body.error, error);
  assert.equal(result.body.processingStatus, 'manual_review');
  assert.deepEqual(productionState(positions), before);
}
const beforeDuplicate = productionState(positions);
assert.equal((await receive(positions, positionPayload(30, { status: 'printed', sequence: 6 }))).body.duplicate, true);
assert.deepEqual(productionState(positions), beforeDuplicate);
const firstShipment = positionPayload(30, { status: 'shipped', sequence: 7, trackingNumbers: shippedTracking });
assert.equal((await receive(positions, firstShipment)).httpStatus, 200);
assert.equal(positions.state.order.status, 'production_completed');
assert.equal(positions.state.order.factory_status, 'printed');
assert.equal(positions.state.shopifyTasks.length, 0);
assert.deepEqual(positions.state.lineItems[0].nexo_tracking_json, shippedTracking);
assert.equal(positions.state.lineItems[0].nexo_parcel_service, 'UPS');
assert.equal((await receive(positions, firstShipment)).body.duplicate, true);
const lastShipment = positionPayload(42, { status: 'shipped', sequence: 8, trackingNumbers: [{ number: 'ACCESSORY-TRACK', url: 'https://example.test/track/accessory' }] });
const positionRace = await Promise.all([receive(positions, lastShipment), receive(positions, lastShipment)]);
assert.equal(positionRace.filter(result => result.body.duplicate).length, 1);
assert.equal(positions.state.order.status, 'shipped');
assert.equal(positions.state.order.factory_status, 'shipped');
assert.equal(positions.state.orderPackage.factory_status, 'shipped');
assert.equal(positions.state.order.factory_order_id, null);
assert.equal(positions.state.orderPackage.nexo_order_id, null);
assert.equal(positions.state.shopifyTasks.length, 1);
const aggregateTask = positions.state.shopifyTasks[0];
assert.equal(aggregateTask.payload_json.shipmentScope, 'position_aggregate');
assert.equal('nexoExternalId' in aggregateTask.payload_json, false);
assert.equal(aggregateTask.payload_json.reference, positions.state.orderPackage.order_number);
assert.deepEqual(aggregateTask.payload_json.positions.map(position => position.orderLineItemId), ['30', '42']);
assert.deepEqual(aggregateTask.payload_json.trackingNumbers, [
  ...shippedTracking, { number: 'ACCESSORY-TRACK', url: 'https://example.test/track/accessory' },
]);
const shippedState = productionState(positions);
assert.equal((await receive(positions, positionPayload(30, {
  status: 'shipped', sequence: 9, trackingNumbers: shippedTracking,
}))).body.duplicate, true);
const conflict = await receive(positions, positionPayload(30, {
  status: 'shipped', sequence: 10, trackingNumbers: [{ number: 'CONFLICT' }],
}));
assert.equal(conflict.body.error, 'nexo_position_tracking_conflict');
assert.deepEqual(productionState(positions), shippedState);

for (const [changes, expectedError] of [
  [{ parcel_service: 'DHL' }, 'carrier_conflict'],
  [{ parcel_service: null }, 'carrier_conflict'],
  [{ tracking_numbers: [{ number: shippedTracking[0].number, url: 'https://example.test/conflict' }] }, 'tracking_conflict'],
  [{ tracking_numbers: [{ number: shippedTracking[0].number }] }, 'tracking_conflict'],
  [{ tracking_numbers: [{ number: 'OTHER-NUMBER' }] }, 'tracking_urls_partially_missing'],
  [{ tracking_numbers: Array.from({ length: 50 }, (_, index) => ({ number: `N${index}`, url: `https://example.test/${index}` })) }, 'tracking_limit_exceeded'],
]) {
  const harness = createHarness({ positionLevel: true });
  await receive(harness, positionPayload(30, { status: 'shipped', trackingNumbers: shippedTracking }));
  const before = productionState(harness);
  const event = positionPayload(42, { status: 'shipped', trackingNumbers: shippedTracking });
  // Null carrier is represented by an absent callback field; persisted state remains NULL.
  Object.assign(event, changes);
  if (event.parcel_service === null) delete event.parcel_service;
  const rejected = await receive(harness, event);
  assert.equal(rejected.body.error, `nexo_position_shipment_${expectedError}`);
  assert.equal(rejected.body.processingStatus, 'manual_review');
  assert.deepEqual(productionState(harness), before);
  assert.equal(harness.state.shopifyTasks.length, 0);
}
const taskFailure = createHarness({ positionLevel: true });
await receive(taskFailure, positionPayload(30, { status: 'shipped', trackingNumbers: shippedTracking }));
const beforeTaskFailure = productionState(taskFailure);
const taskEnsurer = taskFailure.runtime.ensureNexoShopifyUpdateTask;
const finalDelivery = positionPayload(42, { status: 'shipped', trackingNumbers: shippedTracking });
taskFailure.runtime.ensureNexoShopifyUpdateTask = async () => { throw new Error('injected task insert failure'); };
await assert.rejects(receive(taskFailure, finalDelivery), /injected task insert failure/);
assert.deepEqual(productionState(taskFailure), beforeTaskFailure);
assert.equal(taskFailure.state.callbacks.length, 1);
taskFailure.runtime.ensureNexoShopifyUpdateTask = taskEnsurer;
assert.equal((await receive(taskFailure, finalDelivery)).body.shopifyUpdateTaskCreated, true);
assert.equal(taskFailure.state.shopifyTasks.length, 1);
assert.deepEqual(taskFailure.state.shopifyTasks[0].payload_json.trackingNumbers, shippedTracking);
const concurrentFinal = createHarness({ positionLevel: true });
await receive(concurrentFinal, positionPayload(30, { status: 'shipped', trackingNumbers: shippedTracking }));
const finalResults = await Promise.all([2, 3].map(sequence => receive(concurrentFinal,
  positionPayload(42, { status: 'shipped', sequence, trackingNumbers: shippedTracking }))));
assert.equal(finalResults.filter(result => result.body.shopifyUpdateTaskCreated).length, 1);
assert.equal(finalResults.filter(result => result.body.duplicate).length, 1);
assert.equal(concurrentFinal.state.shopifyTasks.length, 1);
for (const existing of [sequenceHarness.state.shopifyTasks[0], { ...aggregateTask,
  payload_json: { ...aggregateTask.payload_json, positions: [] },
}]) {
  const harness = createHarness({ positionLevel: true });
  await receive(harness, positionPayload(30, { status: 'shipped', trackingNumbers: shippedTracking }));
  harness.state.shopifyTasks.push(structuredClone(existing));
  const before = productionState(harness);
  const result = await receive(harness, lastShipment);
  assert.equal(result.body.error, 'nexo_shopify_task_idempotency_conflict');
  assert.deepEqual(productionState(harness), before);
  assert.equal(harness.state.callbacks.at(-1).processing_status, 'manual_review');
}

for (const status of ['accepted', 'ready_to_print', 'printed', 'shipped']) {
  const harness = createHarness({ positionLevel: true, count: 1 });
  const outcome = await receive(harness, positionPayload(30, {
    status, trackingNumbers: status === 'shipped' ? shippedTracking : undefined,
  }));
  assert.equal(outcome.httpStatus, 200);
  assert.equal(harness.state.orderPackage.factory_status, status);
  assert.equal(harness.state.shopifyTasks.length, status === 'shipped' ? 1 : 0);
}
for (const [change, error] of [
  [h => { h.state.lineItems[0].order_id = 999; }, 'nexo_package_position_identity_mismatch'],
  [h => { h.state.lineItems[0].shopify_order_id = '999'; }, 'nexo_package_position_identity_mismatch'],
  [h => { h.state.lineItems[0].shopify_line_item_id = '999'; }, 'nexo_package_position_identity_mismatch'],
  [h => { h.state.lineItems[0].source_position = 9; }, 'nexo_package_position_identity_mismatch'],
  [h => { h.state.evidence.manifest.contents.positions[0] = null; }, 'nexo_package_position_identity_mismatch'],
  [h => { h.state.evidence.xml = h.state.evidence.xml.replace('-J30', '-J999'); }, 'nexo_position_reference_not_dispatched'],
  [h => { h.state.order.status = 'SECURITY_HOLD'; }, 'checkout_security_hold'],
  [h => { h.state.order.status = 'failed'; }, 'order_not_ready_for_nexo_callback'],
  [h => { h.state.order.status = 'shipped'; }, 'unsafe_order_status_transition'],
  [h => { h.runtime.findOrderLineItemByNexoJobId = async () => ({ id: 999 }); }, 'nexo_external_id_already_bound_to_another_position'],
  [h => { h.runtime.updateOrderLineItemNexoState = async () => { throw Object.assign(new Error('unique collision'), { code: 'ER_DUP_ENTRY' }); }; }, 'nexo_external_id_already_bound_to_another_position'],
]) {
  const harness = createHarness({ positionLevel: true });
  change(harness);
  const before = productionState(harness);
  const outcome = await receive(harness, positionPayload(30, { status: 'printed' }));
  assert.equal(outcome.body.error, error);
  assert.equal(outcome.body.processingStatus, 'manual_review');
  assert.deepEqual(productionState(harness), before);
}
const unknownPosition = createHarness({ positionLevel: true });
assert.equal((await receive(unknownPosition, positionPayload(999))).body.error, 'nexo_order_line_item_not_found');
const collision = createHarness({ positionLevel: true });
await receive(collision, positionPayload(30));
assert.equal((await receive(collision, positionPayload(42, {
  nexoExternalId: collision.state.lineItems[0].nexo_job_id,
}))).body.error, 'nexo_external_id_already_bound_to_another_position');
assert.equal(collision.state.lineItems[1].nexo_status, null);

for (const positionLevel of [false, true]) {
  const ambiguous = createHarness({ positionLevel, count: 2 });
  assert.equal((await receive(ambiguous, payload({}))).body.error, 'nexo_legacy_position_identity_ambiguous');
  assert.equal(ambiguous.state.orderPackage.factory_status, null);
}
const simultaneous = createHarness({ positionLevel: true });
const concurrentPositions = await Promise.all([30, 42].map(id =>
  receive(simultaneous, positionPayload(id, { status: 'printed' }))));
assert.ok(concurrentPositions.every(result => result.httpStatus === 200));
assert.equal(simultaneous.state.order.status, 'production_completed');
assert.equal(simultaneous.state.shopifyTasks.length, 0);
const ahead = createHarness({ positionLevel: true });
ahead.state.order.status = 'ready_for_shipping';
await receive(ahead, positionPayload(30));
await receive(ahead, positionPayload(42));
assert.equal(ahead.state.order.status, 'ready_for_shipping');
assert.equal(ahead.state.order.factory_status, 'accepted');

for (const status of ['cancelled', 'error']) {
  const exception = createHarness({ positionLevel: true });
  assert.equal((await receive(exception, positionPayload(30, { status }))).httpStatus, 202);
  assert.equal(exception.state.order.status, 'manual_review');
  assert.equal(exception.state.lineItems[0].nexo_status, status);
  const before = productionState(exception);
  assert.equal((await receive(exception, positionPayload(30, { status: 'printed', sequence: 2 }))).body.error, 'nexo_status_after_terminal_status');
  assert.deepEqual(productionState(exception), before);
}
const positionReplay = createHarness({ positionLevel: true });
positionReplay.state.uploadTask.status = 'uploading';
const positionHeld = await receive(positionReplay, positionPayload(30, { status: 'printed' }));
positionReplay.state.uploadTask.status = 'uploaded';
assert.equal((await replayNexoCallback(positionHeld.body.callbackId, { runtime: positionReplay.runtime })).body.processingStatus, 'processed');
assert.equal(positionReplay.state.callbacks.length, 1);
assert.equal(positionReplay.state.callbacks[0].order_line_item_id, 30);
assert.equal(positionReplay.state.shopifyTasks.length, 0);
const rollback = createHarness({ positionLevel: true });
const beforeRollback = productionState(rollback);
rollback.runtime.updateOrderFactoryPackageAggregateStatus = async () => { throw new Error('injected aggregate failure'); };
await assert.rejects(receive(rollback, positionPayload(30)), /injected aggregate failure/);
assert.deepEqual(productionState(rollback), beforeRollback);
assert.equal(rollback.state.callbacks.length, 0);

// Verify dispatched-XML evidence through the real local reader, without DB or FTP.
await fs.mkdir(artifactsDir, { recursive: true });
const fixtureRoot = await fs.mkdtemp(path.join(artifactsDir, '.nexo-position-smoke-'));
try {
  const harness = createHarness({ positionLevel: true, count: 1 });
  const line = harness.state.lineItems[0];
  line.classification = 'ACCESSORY';
  line.sku = '283-388.0';
  harness.state.evidence.manifest.contents.positions[0].sku = line.sku;
  const xml = `<root><order><order_number>${harness.state.orderPackage.order_number}</order_number></order><positions><position>
    <reference>${harness.state.orderPackage.order_number}-J30</reference><sku>${line.sku}</sku>
    <width unit="mm">0</width><height unit="mm">0</height><variants>1</variants>
    <copies_per_variant>1</copies_per_variant><total_price>10.00</total_price><files/>
  </position></positions></root>`;
  const sha = text => crypto.createHash('sha256').update(text).digest('hex');
  const name = `${harness.state.orderPackage.order_number}.xml`;
  const xmlPath = path.join(fixtureRoot, name);
  const manifestPath = path.join(fixtureRoot, 'manifest.json');
  const checksum = sha(xml);
  const contentChecksum = sha(`${name}:${checksum}`);
  const manifest = { ...harness.state.evidence.manifest,
    schema: 'wandini.order-factory-package.v1', version: 1,
    package: { content_checksum_sha256: contentChecksum },
    contents: { ...harness.state.evidence.manifest.contents,
      file_count: 1, pdf_count: 0, xml_file_name: name,
      files: [{ name, source_path: xmlPath, checksum_sha256: checksum, size_bytes: Buffer.byteLength(xml) }],
    },
  };
  await fs.writeFile(xmlPath, xml);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  Object.assign(harness.state.artifact, { manifest_path: manifestPath, checksum });
  Object.assign(harness.state.orderPackage, { manifest_path: manifestPath, content_checksum: contentChecksum });
  harness.runtime.readNexoCallbackPackage = readNexoCallbackPackage;
  assert.equal((await receive(harness, positionPayload(30, { status: 'printed' }))).httpStatus, 200);
  const before = productionState(harness);
  await fs.writeFile(xmlPath, xml.replace('-J30', '-J42'));
  assert.equal((await receive(harness, positionPayload(30, {
    status: 'shipped', sequence: 2, trackingNumbers: shippedTracking,
  }))).body.error, 'nexo_dispatched_package_unverifiable');
  assert.deepEqual(productionState(harness), before);
} finally {
  assert.equal(path.dirname(path.resolve(fixtureRoot)), path.resolve(artifactsDir));
  assert.ok(path.basename(fixtureRoot).startsWith('.nexo-position-smoke-'));
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}

const positionMigration = await fs.readFile(new URL('../src/db/migrations/012_position_level_nexo_callbacks.sql', import.meta.url), 'utf8');
assert.match(positionMigration, /uq_order_line_items_nexo_job_id/);
assert.match(positionMigration, /FOREIGN KEY \(order_line_item_id\) REFERENCES order_line_items \(id\) ON DELETE SET NULL/);
for (const field of ['nexo_job_id', 'nexo_status', 'nexo_parcel_service', 'nexo_tracking_json']) assert.ok(positionMigration.includes(field));
assert.doesNotMatch(positionMigration, /\b(?:UPDATE|DELETE FROM|DROP)\b/i);
console.log('order and position-level NEXO callback safety smoke ok');
