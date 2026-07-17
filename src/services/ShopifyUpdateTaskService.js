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
  job,
  factoryCallback,
  nexoCallback,
  shopifyWriteEnabled = env.SHOPIFY_WRITE_ENABLED,
} = {}) {
  const taskType =
    nexoCallback?.status === 'printed'
      ? SHOPIFY_UPDATE_TASK_TYPES.ORDER_PRODUCED
      : nexoCallback?.status === 'shipped'
        ? SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED
        : null;

  if (!taskType || !order || !job || !factoryCallback?.id) {
    return null;
  }

  const idempotencyKey = buildNexoShopifyTaskIdempotencyKey({
    jobId: job.id,
    reference: nexoCallback.reference,
    taskType,
    trackingNumbers: nexoCallback.trackingNumbers,
  });
  const payload = {
    source: 'nexo_callback',
    taskType,
    idempotencyKey,
    factoryCallbackId: String(factoryCallback.id),
    factoryCallbackStatus: factoryCallback.processing_status ?? null,
    nexoStatus: nexoCallback.status,
    reference: nexoCallback.reference,
    factoryReference: job.factory_reference,
    nexoJobId: nexoCallback.nexoJobId,
    timestamp: nexoCallback.timestamp,
    jobId: job.id,
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
    dryRun: true,
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

function assertCompatibleNexoTask(existingTask, draft) {
  const payload = existingTask?.payload_json ?? {};
  const expectedPayload = draft.payloadJson ?? {};
  const compatible = Boolean(
    existingTask &&
      existingTask.dry_run === true &&
      existingTask.task_type === draft.taskType &&
      existingTask.source_type === draft.sourceType &&
      String(existingTask.order_id) === String(draft.orderId) &&
      String(existingTask.shopify_order_id ?? '') ===
        String(draft.shopifyOrderId ?? '') &&
      payload.source === 'nexo_callback' &&
      payload.dryRun === true &&
      payload.writeSuppressed === true &&
      String(payload.jobId) === String(expectedPayload.jobId) &&
      payload.reference === expectedPayload.reference &&
      payload.factoryReference === expectedPayload.factoryReference &&
      String(payload.nexoJobId) === String(expectedPayload.nexoJobId) &&
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

export async function ensureNexoShopifyUpdateTaskDryRun({
  order,
  job,
  factoryCallback,
  nexoCallback,
  db = undefined,
} = {}) {
  const draft = buildNexoShopifyUpdateTaskDraft({
    order,
    job,
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

  const existingTask = await findShopifyUpdateTaskByIdempotencyKey(
    draft.idempotencyKey,
    db
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
    const task = await createShopifyUpdateTask(draft, db);

    return {
      task,
      created: true,
      reason: 'shopify_update_task_created',
    };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const task = await findShopifyUpdateTaskByIdempotencyKey(
      draft.idempotencyKey,
      db
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
  buildNexoShopifyUpdateTaskDraft,
  buildShopifyUpdateTaskDraft,
  ensureNexoShopifyUpdateTaskDryRun,
  ensureShopifyUpdateTaskDryRun,
  getShopifyUpdateTaskTypeForFactoryStatus,
};
