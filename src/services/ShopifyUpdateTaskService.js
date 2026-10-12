import { isDeepStrictEqual } from 'node:util';
import env from '../config/env.js';
import { isDuplicateKeyError } from '../db/errors.js';
import {
  FACTORY_CALLBACK_PROCESSING_STATUSES,
  SHOPIFY_UPDATE_TASK_STATUSES,
} from '../constants/statuses.js';
import {
  createShopifyUpdateTask,
  findShopifyUpdateTaskByFactoryCallbackId,
  findShopifyUpdateTaskByIdempotencyKey,
} from '../models/ShopifyUpdateTaskModel.js';
import { redact } from '../utils/redact.js';
import { logInfo } from './LogService.js';
import { buildNexoShopifyTaskIdempotencyKey } from './NexoCallbackAdapter.js';

export const SHOPIFY_UPDATE_TASK_TYPES = Object.freeze({
  ORDER_PRODUCED: 'order_produced',
  ORDER_SHIPPED: 'order_shipped',
  ORDER_FAILED_MANUAL_REVIEW: 'order_failed_manual_review',
});

const FACTORY_STATUS_TO_TASK_TYPE = Object.freeze({
  produced: SHOPIFY_UPDATE_TASK_TYPES.ORDER_PRODUCED,
  shipped: SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED,
  failed: SHOPIFY_UPDATE_TASK_TYPES.ORDER_FAILED_MANUAL_REVIEW,
});

const CALLBACK_STATUSES_ALLOWED_FOR_TASKS = new Set([
  FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED,
  FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
]);

function scalarToString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'bigint'
  ) {
    return null;
  }

  const normalized = String(value).trim();

  return normalized || null;
}

function getFirstScalar(source, keys) {
  if (!source || typeof source !== 'object') {
    return null;
  }

  for (const key of keys) {
    const value = scalarToString(source[key]);

    if (value) {
      return value;
    }
  }

  return null;
}

function extractTrackingDetails(payload = {}) {
  const trackingSources = [
    payload,
    payload.tracking,
    payload.shipment,
    payload.shipping,
  ].filter(Boolean);
  const details = {};

  for (const source of trackingSources) {
    details.trackingNumber =
      details.trackingNumber ??
      getFirstScalar(source, [
        'tracking_number',
        'trackingNumber',
        'tracking_no',
        'trackingNo',
      ]);
    details.trackingUrl =
      details.trackingUrl ??
      getFirstScalar(source, [
        'tracking_url',
        'trackingUrl',
        'tracking_link',
        'trackingLink',
      ]);
    details.trackingCompany =
      details.trackingCompany ??
      getFirstScalar(source, [
        'tracking_company',
        'trackingCompany',
        'carrier',
        'shipping_carrier',
        'shippingCarrier',
      ]);
  }

  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => Boolean(value))
  );
}

export function getShopifyUpdateTaskTypeForFactoryStatus(factoryStatus) {
  return FACTORY_STATUS_TO_TASK_TYPE[factoryStatus] ?? null;
}

export function buildShopifyUpdateTaskDraft({
  order,
  factoryCallback,
  factoryStatus,
  factoryPayload = {},
  shopifyWriteEnabled = env.SHOPIFY_WRITE_ENABLED,
} = {}) {
  const taskType = getShopifyUpdateTaskTypeForFactoryStatus(factoryStatus);

  if (!taskType || !order || !factoryCallback?.id) {
    return null;
  }

  if (
    factoryCallback.processing_status &&
    !CALLBACK_STATUSES_ALLOWED_FOR_TASKS.has(factoryCallback.processing_status)
  ) {
    return null;
  }

  const idempotencyKey = `factory_callback:${factoryCallback.id}:${taskType}`;

  const payload = {
    source: 'factory_callback_simulation',
    taskType,
    idempotencyKey,
    factoryCallbackId: String(factoryCallback.id),
    factoryCallbackStatus: factoryCallback.processing_status ?? null,
    factoryStatus,
    orderId: order.id,
    shopifyOrderId: order.shopify_order_id ?? null,
    orderStatus: order.status,
    dryRun: true,
    shopifyWriteEnabled: Boolean(shopifyWriteEnabled),
    actualShopifyWriteImplemented: false,
    writeSuppressed: true,
    writeSuppressedReason: shopifyWriteEnabled
      ? 'shopify_write_not_implemented'
      : 'shopify_write_disabled',
  };

  if (factoryStatus === 'shipped') {
    payload.tracking = extractTrackingDetails(factoryPayload);
  }

  if (factoryStatus === 'failed') {
    payload.manualReviewReason = 'factory_callback_failed';
  }

  return {
    orderId: order.id,
    shopifyOrderId: order.shopify_order_id ?? null,
    taskType,
    idempotencyKey,
    sourceType: 'factory_callback',
    sourceId: String(factoryCallback.id),
    status: SHOPIFY_UPDATE_TASK_STATUSES.PENDING,
    dryRun: true,
    maxAttempts: env.SHOPIFY_UPDATE_TASK_MAX_ATTEMPTS,
    payloadJson: redact(payload),
  };
}

export async function ensureShopifyUpdateTaskDryRun({
  order,
  factoryCallback,
  factoryStatus,
  factoryPayload = {},
  db = undefined,
  logCreation = true,
} = {}) {
  const draft = buildShopifyUpdateTaskDraft({
    order,
    factoryCallback,
    factoryStatus,
    factoryPayload,
  });

  if (!draft) {
    return {
      task: null,
      created: false,
      reason: 'shopify_update_task_not_applicable',
    };
  }

  const existingTask =
    (await findShopifyUpdateTaskByIdempotencyKey(
      draft.idempotencyKey,
      db
    )) ??
    (await findShopifyUpdateTaskByFactoryCallbackId(factoryCallback.id, db));

  if (existingTask) {
    return {
      task: existingTask,
      created: false,
      reason: 'shopify_update_task_already_exists',
    };
  }

  let task = null;

  try {
    task = await createShopifyUpdateTask(draft, db);
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    task = await findShopifyUpdateTaskByIdempotencyKey(
      draft.idempotencyKey,
      db
    );

    if (!task) {
      throw error;
    }

    return {
      task,
      created: false,
      reason: 'shopify_update_task_already_exists',
    };
  }

  if (logCreation) {
    await logInfo({
      scopeType: 'order',
      orderId: task.order_id,
      step: 'shopify_update_task.created',
      message: 'Dry-run Shopify update task created',
      detailsJson: {
        taskId: task.id,
        taskType: task.task_type,
        factoryCallbackId: factoryCallback.id,
        factoryStatus,
        dryRun: task.dry_run,
        shopifyWriteEnabled: env.SHOPIFY_WRITE_ENABLED,
        actualShopifyWriteImplemented: false,
      },
    });
  }

  return {
    task,
    created: true,
    reason: 'shopify_update_task_created',
  };
}

export function buildNexoShopifyUpdateTaskDraft({
  order,
  orderPackage,
  factoryCallback,
  nexoCallback,
} = {}) {
  const taskType =
    nexoCallback?.status === 'shipped'
      ? SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED
      : null;

  if (!taskType || !order || !orderPackage || !factoryCallback?.id) {
    return null;
  }

  const idempotencyKey = buildNexoShopifyTaskIdempotencyKey({
    orderFactoryPackageId: orderPackage.id,
    reference: nexoCallback.reference,
    taskType,
  });
  const payload = {
    source: 'nexo_callback',
    taskType,
    idempotencyKey,
    factoryCallbackId: String(factoryCallback.id),
    factoryCallbackStatus: factoryCallback.processing_status ?? null,
    nexoStatus: nexoCallback.status,
    reference: nexoCallback.reference,
    factoryReference: orderPackage.order_number,
    nexoExternalId: nexoCallback.nexoJobId,
    timestamp: nexoCallback.timestamp,
    orderFactoryPackageId: orderPackage.id,
    orderId: order.id,
    shopifyOrderId: order.shopify_order_id ?? null,
    orderStatus: order.status,
    dryRun: false,
    writeSuppressed: false,
  };

  if (taskType === SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED) {
    payload.parcel_service = nexoCallback.parcelService ?? null;
    payload.trackingNumbers = nexoCallback.trackingNumbers.map(
      ({ number, url }) => ({ number, url })
    );
  }

  return {
    orderId: order.id,
    shopifyOrderId: order.shopify_order_id ?? null,
    taskType,
    idempotencyKey,
    sourceType: 'nexo_callback',
    sourceId: String(factoryCallback.id),
    status: SHOPIFY_UPDATE_TASK_STATUSES.PENDING,
    dryRun: false,
    maxAttempts: env.SHOPIFY_UPDATE_TASK_MAX_ATTEMPTS,
    payloadJson: redact(payload),
  };
}

function canonicalTrackingNumbers(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized = [];

  for (const item of value) {
    if (!item || typeof item !== 'object' || item.number === undefined) {
      return null;
    }

    normalized.push({
      number: String(item.number),
      url: item.url ?? null,
    });
  }

  return normalized.sort((left, right) => {
      if (left.number !== right.number) {
        return left.number < right.number ? -1 : 1;
      }

      const leftUrl = String(left.url ?? '');
      const rightUrl = String(right.url ?? '');
      return leftUrl === rightUrl ? 0 : leftUrl < rightUrl ? -1 : 1;
    });
}

function invalidPositionShipment(reason) {
  const error = new Error(`nexo_position_shipment_${reason}`);
  error.code = 'NEXO_POSITION_SHIPMENT_INVALID';
  throw error;
}

function positionShipmentId(value) {
  if ((typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) &&
      (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
    invalidPositionShipment('identity_invalid');
  }
  return String(value);
}

function positionTracking(value) {
  let entries = value;
  if (typeof entries === 'string') {
    try { entries = JSON.parse(entries); } catch { invalidPositionShipment('tracking_invalid'); }
  }
  if (!Array.isArray(entries) || entries.length === 0) invalidPositionShipment('tracking_missing');
  const byNumber = new Map();
  for (const entry of entries) {
    if (!entry || !['string', 'number'].includes(typeof entry.number) ||
        (typeof entry.number === 'number' && !Number.isSafeInteger(entry.number))) {
      invalidPositionShipment('tracking_invalid');
    }
    const number = String(entry.number).trim();
    if (!number || number.length > 191) invalidPositionShipment('tracking_invalid');
    if (entry.url != null && typeof entry.url !== 'string') invalidPositionShipment('tracking_url_invalid');
    const url = entry.url?.trim() || null;
    if (url) {
      try {
        if (url.length > 2048 || !['http:', 'https:'].includes(new URL(url).protocol)) throw new Error();
      } catch { invalidPositionShipment('tracking_url_invalid'); }
    }
    if (byNumber.has(number) && byNumber.get(number).url !== url) invalidPositionShipment('tracking_conflict');
    byNumber.set(number, { number, url });
  }
  return canonicalTrackingNumbers([...byNumber.values()]);
}

export function buildNexoPositionShipment({ order, orderPackage, lineItems } = {}) {
  const orderId = positionShipmentId(order?.id);
  const shopifyOrderId = positionShipmentId(order?.shopify_order_id);
  positionShipmentId(orderPackage?.id);
  if (String(orderPackage?.order_id) !== orderId ||
      String(orderPackage?.shopify_order_id) !== shopifyOrderId ||
      orderPackage?.order_number !== `WANDINI-S${shopifyOrderId}`) invalidPositionShipment('identity_invalid');
  if (order.factory_order_id != null || orderPackage.nexo_order_id != null) invalidPositionShipment('mixed_identity');
  if (!Array.isArray(lineItems) || lineItems.length === 0) invalidPositionShipment('positions_missing');
  const ids = new Set();
  const sourcePositions = new Set();
  const shopifyLineIds = new Set();
  const jobIds = new Set();
  const carriers = new Set();
  const positions = lineItems.map(line => {
    const orderLineItemId = positionShipmentId(line?.id);
    const shopifyLineItemId = positionShipmentId(line?.shopify_line_item_id);
    if (String(line.order_id) !== orderId || String(line.shopify_order_id) !== shopifyOrderId ||
        !Number.isSafeInteger(line.source_position) || line.source_position < 0 ||
        ids.has(orderLineItemId) || sourcePositions.has(line.source_position) || shopifyLineIds.has(shopifyLineItemId)) {
      invalidPositionShipment('identity_invalid');
    }
    if (line.nexo_status !== 'shipped') invalidPositionShipment('positions_not_shipped');
    if (typeof line.nexo_job_id !== 'string' || !line.nexo_job_id.trim() ||
        line.nexo_job_id !== line.nexo_job_id.trim() || line.nexo_job_id.length > 191 || jobIds.has(line.nexo_job_id)) {
      invalidPositionShipment('external_id_invalid');
    }
    const carrier = line.nexo_parcel_service;
    if (carrier !== null && (typeof carrier !== 'string' || !carrier.trim() ||
        carrier !== carrier.trim() || carrier.length > 191)) invalidPositionShipment('carrier_invalid');
    ids.add(orderLineItemId);
    sourcePositions.add(line.source_position);
    shopifyLineIds.add(shopifyLineItemId);
    jobIds.add(line.nexo_job_id);
    carriers.add(carrier);
    return {
      orderLineItemId, shopifyLineItemId, sourcePosition: line.source_position,
      reference: `WANDINI-S${shopifyOrderId}-J${orderLineItemId}`,
      nexoJobId: line.nexo_job_id, nexoStatus: 'shipped',
      trackingNumbers: positionTracking(line.nexo_tracking_json), parcel_service: carrier,
    };
  }).sort((left, right) => left.sourcePosition - right.sourcePosition);
  if (carriers.size !== 1) invalidPositionShipment('carrier_conflict');
  const trackingNumbers = positionTracking(positions.flatMap(position => position.trackingNumbers));
  if (trackingNumbers.length > 50) invalidPositionShipment('tracking_limit_exceeded');
  const urlCount = trackingNumbers.filter(entry => entry.url !== null).length;
  if (urlCount !== 0 && urlCount !== trackingNumbers.length) invalidPositionShipment('tracking_urls_partially_missing');
  return { shipmentScope: 'position_aggregate', positions, trackingNumbers, parcel_service: positions[0].parcel_service };
}

export function matchesNexoPositionShipment(payload, shipment) {
  return payload?.shipmentScope === 'position_aggregate' &&
    !['nexoExternalId', 'nexo_external_id', 'nexoOrderId', 'nexo_order_id', 'factoryOrderId', 'factory_order_id', 'jobId', 'job_id']
      .some(key => Object.hasOwn(payload, key)) &&
    isDeepStrictEqual(payload.positions, shipment.positions) &&
    isDeepStrictEqual(payload.trackingNumbers, shipment.trackingNumbers) &&
    payload.parcel_service === shipment.parcel_service;
}

export function buildNexoPositionShopifyUpdateTaskDraft({ order, orderPackage, factoryCallback, positionLineItems } = {}) {
  const shipment = buildNexoPositionShipment({ order, orderPackage, lineItems: positionLineItems });
  if (order.status !== 'shipped' || order.factory_status !== 'shipped' ||
      orderPackage.factory_status !== 'shipped' || orderPackage.status !== 'ready' || !factoryCallback?.id) {
    invalidPositionShipment('aggregate_not_shipped');
  }
  const taskType = SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED;
  const idempotencyKey = buildNexoShopifyTaskIdempotencyKey({
    orderFactoryPackageId: orderPackage.id, reference: orderPackage.order_number, taskType,
  });
  return {
    orderId: order.id, shopifyOrderId: order.shopify_order_id, taskType, idempotencyKey,
    sourceType: 'nexo_callback', sourceId: String(factoryCallback.id),
    status: SHOPIFY_UPDATE_TASK_STATUSES.PENDING, dryRun: false,
    maxAttempts: env.SHOPIFY_UPDATE_TASK_MAX_ATTEMPTS,
    payloadJson: redact({
      source: 'nexo_callback', taskType, idempotencyKey,
      factoryCallbackId: String(factoryCallback.id), factoryCallbackStatus: factoryCallback.processing_status ?? null,
      nexoStatus: 'shipped', reference: orderPackage.order_number, factoryReference: orderPackage.order_number,
      orderFactoryPackageId: orderPackage.id, orderId: order.id, shopifyOrderId: order.shopify_order_id,
      orderStatus: order.status, dryRun: false, writeSuppressed: false, ...shipment,
    }),
  };
}

function assertCompatibleNexoTask(existingTask, draft) {
  const payload = existingTask?.payload_json ?? {};
  const expectedPayload = draft.payloadJson ?? {};
  const positionAggregate = expectedPayload.shipmentScope === 'position_aggregate';
  const modeCompatible = positionAggregate
    ? matchesNexoPositionShipment(payload, expectedPayload) &&
      payload.factoryCallbackId != null && String(existingTask.source_id) === String(payload.factoryCallbackId) &&
      existingTask.idempotency_key === draft.idempotencyKey && payload.idempotencyKey === draft.idempotencyKey &&
      String(payload.orderId) === String(draft.orderId) && String(payload.shopifyOrderId) === String(draft.shopifyOrderId) &&
      payload.nexoStatus === 'shipped' && payload.taskType === draft.taskType
    : payload.shipmentScope === undefined && payload.positions === undefined &&
      String(payload.nexoExternalId) === String(expectedPayload.nexoExternalId);
  const compatible = Boolean(
    existingTask && modeCompatible &&
      existingTask.dry_run === false &&
      existingTask.task_type === draft.taskType &&
      existingTask.source_type === draft.sourceType &&
      String(existingTask.order_id) === String(draft.orderId) &&
      String(existingTask.shopify_order_id ?? '') ===
        String(draft.shopifyOrderId ?? '') &&
      payload.source === 'nexo_callback' &&
      payload.dryRun === false &&
      payload.writeSuppressed === false &&
      String(payload.orderFactoryPackageId) ===
        String(expectedPayload.orderFactoryPackageId) &&
      payload.reference === expectedPayload.reference &&
      payload.factoryReference === expectedPayload.factoryReference &&
      (draft.taskType !== SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED ||
        (payload.parcel_service === expectedPayload.parcel_service &&
          JSON.stringify(canonicalTrackingNumbers(payload.trackingNumbers)) ===
            JSON.stringify(
              canonicalTrackingNumbers(expectedPayload.trackingNumbers)
            )))
  );

  if (!compatible) {
    const error = new Error(
      'Existing Shopify update task conflicts with NEXO idempotency identity'
    );
    error.code = 'NEXO_SHOPIFY_TASK_IDEMPOTENCY_CONFLICT';
    throw error;
  }

  return existingTask;
}

export async function ensureNexoShopifyUpdateTask({
  order,
  orderPackage,
  factoryCallback,
  nexoCallback,
  positionLineItems,
  db = undefined,
  runtime = {},
} = {}) {
  const findByIdempotencyKey =
    runtime.findShopifyUpdateTaskByIdempotencyKey ??
    findShopifyUpdateTaskByIdempotencyKey;
  const createTask =
    runtime.createShopifyUpdateTask ?? createShopifyUpdateTask;
  const draft = positionLineItems !== undefined
    ? buildNexoPositionShopifyUpdateTaskDraft({ order, orderPackage, factoryCallback, positionLineItems })
    : buildNexoShopifyUpdateTaskDraft({
    order,
    orderPackage,
    factoryCallback,
    nexoCallback,
  });

  if (!draft) {
    return {
      task: null,
      created: false,
      reason: 'shopify_update_task_not_applicable',
    };
  }

  const existingTask = await findByIdempotencyKey(
    draft.idempotencyKey,
    db,
    // A callback may have waited for the order lock after its transaction's
    // first read. Use a current read to see the preceding callback's task.
    { forUpdate: positionLineItems !== undefined }
  );

  if (existingTask) {
    assertCompatibleNexoTask(existingTask, draft);

    return {
      task: existingTask,
      created: false,
      reason: 'shopify_update_task_already_exists',
    };
  }

  try {
    const task = await createTask(draft, db);

    return {
      task,
      created: true,
      reason: 'shopify_update_task_created',
    };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const task = await findByIdempotencyKey(
      draft.idempotencyKey,
      db,
      { forUpdate: positionLineItems !== undefined }
    );

    if (!task) {
      throw error;
    }

    assertCompatibleNexoTask(task, draft);

    return {
      task,
      created: false,
      reason: 'shopify_update_task_already_exists',
    };
  }
}

export default {
  SHOPIFY_UPDATE_TASK_TYPES,
  buildNexoPositionShipment,
  matchesNexoPositionShipment,
  buildNexoPositionShopifyUpdateTaskDraft,
  buildNexoShopifyUpdateTaskDraft,
  buildShopifyUpdateTaskDraft,
  ensureNexoShopifyUpdateTask,
  ensureShopifyUpdateTaskDryRun,
  getShopifyUpdateTaskTypeForFactoryStatus,
};
