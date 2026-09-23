import crypto from 'node:crypto';

import env from '../config/env.js';
import pool from '../db/connection.js';
import { isDuplicateKeyError } from '../db/errors.js';
import {
  FACTORY_CALLBACK_PROCESSING_STATUSES,
  ORDER_STATUSES,
  STATUS_GROUPS,
} from '../constants/statuses.js';
import {
  createFactoryCallback,
  findOriginalFactoryCallbackByDeliveryId,
  updateFactoryCallbackProcessingStatus,
} from '../models/FactoryCallbackModel.js';
import {
  findOrderByFactoryOrderIdForUpdate,
  findOrderByIdForUpdate,
  findOrderByShopifyOrderIdForUpdate,
  updateOrderFactoryState,
} from '../models/OrderModel.js';
import { redact } from '../utils/redact.js';
import { canTransition } from './statusTransition.js';
import { logInfo, logWarning } from './LogService.js';
import { ensureShopifyUpdateTaskDryRun } from './ShopifyUpdateTaskService.js';

const MAX_IDENTIFIER_LENGTH = 191;
const MAX_STATUS_LENGTH = 100;

export const SIMULATED_FACTORY_STATUSES = Object.freeze([
  'received',
  'in_production',
  'produced',
  'shipped',
  'failed',
]);

const SIMULATED_FACTORY_STATUS_SET = new Set(SIMULATED_FACTORY_STATUSES);

const FACTORY_STATUS_TO_ORDER_STATUS = Object.freeze({
  received: ORDER_STATUSES.FACTORY_RECEIVED,
  in_production: ORDER_STATUSES.PRODUCTION_STARTED,
  produced: ORDER_STATUSES.PRODUCTION_COMPLETED,
  shipped: ORDER_STATUSES.SHIPPED,
  failed: ORDER_STATUSES.MANUAL_REVIEW,
});

const FACTORY_CALLBACK_READY_ORDER_STATUSES = new Set([
  ORDER_STATUSES.COMPLETED,
  ORDER_STATUSES.FACTORY_RECEIVED,
  ORDER_STATUSES.PRODUCTION_STARTED,
  ORDER_STATUSES.PRODUCTION_COMPLETED,
  ORDER_STATUSES.READY_FOR_SHIPPING,
  ORDER_STATUSES.SHIPPED,
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPayloadObject(payload) {
  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload);
}

function getFirstPresentValue(source, keys) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  for (const key of keys) {
    if (hasOwn(source, key)) {
      return source[key];
    }
  }

  return undefined;
}

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

function normalizeStringField(payload, keys, fieldName, maxLength, errors) {
  const value = getFirstPresentValue(payload, keys);

  if (value === undefined || value === null || value === '') {
    return null;
  }

  const normalized = scalarToString(value);

  if (!normalized) {
    errors.push(`${fieldName}_must_be_scalar`);
    return null;
  }

  if (normalized.length > maxLength) {
    errors.push(`${fieldName}_too_long`);
    return null;
  }

  return normalized;
}

function normalizeOrderIdField(payload, errors) {
  const normalized = normalizeStringField(
    payload,
    ['order_id', 'orderId'],
    'order_id',
    MAX_IDENTIFIER_LENGTH,
    errors
  );

  if (!normalized) {
    return null;
  }

  if (!/^[1-9][0-9]*$/.test(normalized)) {
    errors.push('order_id_must_be_positive_integer');
    return null;
  }

  const numericOrderId = Number(normalized);

  if (!Number.isSafeInteger(numericOrderId)) {
    errors.push('order_id_out_of_range');
    return null;
  }

  return normalized;
}

function normalizeFactoryStatusField(payload, errors) {
  const normalized = normalizeStringField(
    payload,
    ['status', 'factory_status', 'factoryStatus'],
    'status',
    MAX_STATUS_LENGTH,
    errors
  )?.toLowerCase();

  if (!normalized) {
    errors.push('status_required');
    return null;
  }

  if (!SIMULATED_FACTORY_STATUS_SET.has(normalized)) {
    errors.push('unsupported_factory_status');
    return normalized;
  }

  return normalized;
}

function getHeaderValue(headers, names) {
  for (const name of names) {
    const value = headers?.[name.toLowerCase()];

    if (value === undefined || value === null || value === '') {
      continue;
    }

    return Array.isArray(value) ? value[0] : value;
  }

  return null;
}

function getDeliveryId({ payload, headers }, errors = []) {
  const headerDeliveryId = scalarToString(
    getHeaderValue(headers, [
      'x-factory-callback-id',
      'x-factory-delivery-id',
      'x-nexo-delivery-id',
    ])
  );

  if (headerDeliveryId) {
    if (headerDeliveryId.length > MAX_IDENTIFIER_LENGTH) {
      errors.push('delivery_id_too_long');
      return null;
    }

    return headerDeliveryId;
  }

  return normalizeStringField(
    payload,
    ['delivery_id', 'deliveryId'],
    'delivery_id',
    MAX_IDENTIFIER_LENGTH,
    errors
  );
}

function getPresentedApiKey(headers) {
  const directHeader = scalarToString(
    getHeaderValue(headers, ['x-factory-callback-api-key', 'x-api-key'])
  );

  if (directHeader) {
    return directHeader;
  }

  const authorization = scalarToString(getHeaderValue(headers, ['authorization']));
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);

  return bearerMatch ? bearerMatch[1].trim() : null;
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function authenticateFactoryCallback(headers) {
  if (!env.FACTORY_CALLBACK_AUTH_ENABLED) {
    return {
      authChecked: false,
      authValid: null,
      error: null,
    };
  }

  const configuredApiKey = String(env.FACTORY_CALLBACK_API_KEY ?? '').trim();

  if (!configuredApiKey) {
    return {
      authChecked: true,
      authValid: false,
      error: 'factory_callback_api_key_not_configured',
    };
  }

  const presentedApiKey = getPresentedApiKey(headers);
  const authValid = Boolean(
    presentedApiKey && secureEquals(presentedApiKey, configuredApiKey)
  );

  return {
    authChecked: true,
    authValid,
    error: authValid ? null : 'invalid_factory_callback_auth',
  };
}

function extractIdentifiers(payload, headers, errors = []) {
  const safePayload = isPayloadObject(payload) ? payload : {};

  return {
    orderId: normalizeOrderIdField(safePayload, errors),
    shopifyOrderId: normalizeStringField(
      safePayload,
      ['shopify_order_id', 'shopifyOrderId'],
      'shopify_order_id',
      MAX_IDENTIFIER_LENGTH,
      errors
    ),
    orderNumber: normalizeStringField(
      safePayload,
      ['order_number', 'orderNumber'],
      'order_number',
      MAX_IDENTIFIER_LENGTH,
      errors
    ),
    factoryOrderId: normalizeStringField(
      safePayload,
      ['factory_order_id', 'factoryOrderId', 'nexo_order_id', 'nexoOrderId'],
      'factory_order_id',
      MAX_IDENTIFIER_LENGTH,
      errors
    ),
    deliveryId: getDeliveryId({ payload: safePayload, headers }, errors),
  };
}

function extractStatusForStorage(payload) {
  if (!isPayloadObject(payload)) {
    return null;
  }

  const rawStatus = getFirstPresentValue(payload, [
    'status',
    'factory_status',
    'factoryStatus',
  ]);
  const normalized = scalarToString(rawStatus);

  if (!normalized || normalized.length > MAX_STATUS_LENGTH) {
    return null;
  }

  return normalized.toLowerCase();
}

function validateFactoryCallbackPayload(payload, headers) {
  const errors = [];

  if (!isPayloadObject(payload)) {
    return {
      ok: false,
      errors: ['payload_must_be_object'],
      normalized: {
        status: null,
        ...extractIdentifiers({}, headers, []),
      },
    };
  }

  const status = normalizeFactoryStatusField(payload, errors);
  const identifiers = extractIdentifiers(payload, headers, errors);
  const hasMatchableIdentifier = Boolean(
    identifiers.orderId ||
      identifiers.shopifyOrderId ||
      identifiers.factoryOrderId
  );

  if (!hasMatchableIdentifier) {
    errors.push('matchable_order_identifier_required');
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      status,
      ...identifiers,
    },
  };
}

function getCallbackRecordData({
  payload,
  headers,
  authValid,
  processingStatus,
  errorMessage = null,
  duplicateOfId = null,
}) {
  const errors = [];
  const identifiers = extractIdentifiers(payload, headers, errors);

  return {
    provider: 'factory_simulation',
    ...identifiers,
    status: extractStatusForStorage(payload),
    rawPayloadJson: redact(payload ?? null),
    headersJson: redact(headers ?? {}),
    authValid,
    processingStatus,
    duplicateOfId,
    errorMessage,
  };
}

async function recordRejectedCallback({
  payload,
  headers,
  authValid,
  processingStatus,
  errorMessage,
}) {
  const callback = await createFactoryCallback(
    getCallbackRecordData({
      payload,
      headers,
      authValid,
      processingStatus,
      errorMessage,
    })
  );

  await logWarning({
    scopeType: 'system',
    step: 'factory_callback.rejected',
    message: 'Factory callback rejected',
    detailsJson: {
      callbackId: callback.id,
      processingStatus,
      errorMessage,
      deliveryId: callback.delivery_id,
      factoryStatus: callback.status,
    },
  });

  return callback;
}

async function findOrderForCallback(normalized, db) {
  if (normalized.orderId) {
    return findOrderByIdForUpdate(normalized.orderId, db);
  }

  if (normalized.shopifyOrderId) {
    return findOrderByShopifyOrderIdForUpdate(normalized.shopifyOrderId, db);
  }

  if (normalized.factoryOrderId) {
    return findOrderByFactoryOrderIdForUpdate(normalized.factoryOrderId, db);
  }

  return null;
}

function getOrderIdentifierMismatch(order, normalized) {
  if (!order) {
    return null;
  }

  if (
    normalized.shopifyOrderId &&
    order.shopify_order_id &&
    String(order.shopify_order_id) !== normalized.shopifyOrderId
  ) {
    return 'shopify_order_id_mismatch';
  }

  if (
    normalized.factoryOrderId &&
    order.factory_order_id &&
    String(order.factory_order_id) !== normalized.factoryOrderId
  ) {
    return 'factory_order_id_mismatch';
  }

  return null;
}

function getUnsafeTransitionReason(order, targetOrderStatus) {
  if (!FACTORY_CALLBACK_READY_ORDER_STATUSES.has(order.status)) {
    return 'order_not_ready_for_factory_callback';
  }

  if (!canTransition(STATUS_GROUPS.ORDER, order.status, targetOrderStatus)) {
    return 'unsafe_order_status_transition';
  }

  return null;
}

async function markCallbackManualReview(
  callback,
  errorMessage,
  orderId = null,
  db = undefined
) {
  const updatedCallback = await updateFactoryCallbackProcessingStatus(
    callback.id,
    {
      processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
      errorMessage,
      orderId,
    },
    db
  );

  return updatedCallback;
}

async function logCallbackManualReview(updatedCallback, errorMessage, orderId) {
  await logWarning({
    scopeType: 'order',
    orderId,
    step: 'factory_callback.manual_review',
    message: 'Factory callback requires manual review',
    detailsJson: {
      callbackId: updatedCallback.id,
      errorMessage,
      factoryStatus: updatedCallback.status,
      deliveryId: updatedCallback.delivery_id,
    },
  });
}

async function buildDuplicateCallbackResult(originalCallback, normalized) {
  await logInfo({
    scopeType: 'system',
    step: 'factory_callback.duplicate',
    message: 'Duplicate factory callback ignored',
    detailsJson: {
      callbackId: originalCallback.id,
      duplicateOfId: originalCallback.id,
      deliveryId: normalized.deliveryId,
      factoryStatus: normalized.status,
    },
  });

  return {
    httpStatus: 200,
    body: {
      ok: true,
      duplicate: true,
      callbackId: originalCallback.id,
      duplicateOfId: originalCallback.id,
      processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE,
    },
  };
}

export async function receiveFactoryCallback({ payload, headers }) {
  const auth = authenticateFactoryCallback(headers);

  if (auth.error) {
    const processingStatus = FACTORY_CALLBACK_PROCESSING_STATUSES.FAILED;
    const callback = await recordRejectedCallback({
      payload,
      headers,
      authValid: false,
      processingStatus,
      errorMessage: auth.error,
    });

    return {
      httpStatus:
        auth.error === 'factory_callback_api_key_not_configured' ? 503 : 401,
      body: {
        ok: false,
        error: auth.error,
        callbackId: callback.id,
        processingStatus,
      },
    };
  }

  if (!auth.authChecked) {
    await logWarning({
      scopeType: 'system',
      step: 'factory_callback.auth_not_enforced',
      message: 'Factory callback auth enforcement is disabled',
    });
  }

  const validation = validateFactoryCallbackPayload(payload, headers);

  if (!validation.ok) {
    const processingStatus = FACTORY_CALLBACK_PROCESSING_STATUSES.FAILED;
    const callback = await recordRejectedCallback({
      payload,
      headers,
      authValid: auth.authValid,
      processingStatus,
      errorMessage: validation.errors.join(', '),
    });

    return {
      httpStatus: 400,
      body: {
        ok: false,
        error: 'invalid_factory_callback_payload',
        errors: validation.errors,
        callbackId: callback.id,
        processingStatus,
      },
    };
  }

  const normalized = validation.normalized;
  const connection = await pool.getConnection();
  let transactionStarted = false;
  let connectionReleased = false;
  const releaseConnection = () => {
    if (!connectionReleased) {
      connection.release();
      connectionReleased = true;
    }
  };

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    if (normalized.deliveryId) {
      const originalCallback = await findOriginalFactoryCallbackByDeliveryId(
        normalized.deliveryId,
        connection
      );

      if (originalCallback) {
        await connection.commit();
        transactionStarted = false;
        releaseConnection();
        return buildDuplicateCallbackResult(originalCallback, normalized);
      }
    }

    const callback = await createFactoryCallback(
      getCallbackRecordData({
        payload,
        headers,
        authValid: auth.authValid,
        processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.RECEIVED,
      }),
      connection
    );
    const order = await findOrderForCallback(normalized, connection);

    if (!order) {
      const updatedCallback = await markCallbackManualReview(
        callback,
        'factory_callback_order_not_found',
        null,
        connection
      );

      await connection.commit();
      transactionStarted = false;
      releaseConnection();

      await logCallbackManualReview(
        updatedCallback,
        'factory_callback_order_not_found',
        null
      );

      return {
        httpStatus: 202,
        body: {
          ok: true,
          callbackId: updatedCallback.id,
          processingStatus: updatedCallback.processing_status,
          orderUpdated: false,
          error: 'factory_callback_order_not_found',
        },
      };
    }

    const mismatchReason = getOrderIdentifierMismatch(order, normalized);

    if (mismatchReason) {
      const updatedCallback = await markCallbackManualReview(
        callback,
        mismatchReason,
        order.id,
        connection
      );

      await connection.commit();
      transactionStarted = false;
      releaseConnection();

      await logCallbackManualReview(
        updatedCallback,
        mismatchReason,
        order.id
      );

      return {
        httpStatus: 202,
        body: {
          ok: true,
          callbackId: updatedCallback.id,
          processingStatus: updatedCallback.processing_status,
          orderId: order.id,
          orderUpdated: false,
          error: mismatchReason,
        },
      };
    }

    const targetOrderStatus = FACTORY_STATUS_TO_ORDER_STATUS[normalized.status];
    const unsafeReason = getUnsafeTransitionReason(order, targetOrderStatus);

    if (unsafeReason) {
      const updatedCallback = await markCallbackManualReview(
        callback,
        unsafeReason,
        order.id,
        connection
      );

      await connection.commit();
      transactionStarted = false;
      releaseConnection();

      await logCallbackManualReview(updatedCallback, unsafeReason, order.id);

      return {
        httpStatus: 202,
        body: {
          ok: true,
          callbackId: updatedCallback.id,
          processingStatus: updatedCallback.processing_status,
          orderId: order.id,
          orderUpdated: false,
          error: unsafeReason,
        },
      };
    }

    const factoryFailure = normalized.status === 'failed';
    const manualReviewReason = factoryFailure
      ? 'factory_callback_failed'
      : undefined;
    const updatedOrder = await updateOrderFactoryState(
      order.id,
      {
        factoryStatus: normalized.status,
        factoryOrderId: normalized.factoryOrderId,
        status: targetOrderStatus,
        manualReviewReason,
      },
      connection
    );
    const callbackProcessingStatus = factoryFailure
      ? FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW
      : FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED;
    const updatedCallback = await updateFactoryCallbackProcessingStatus(
      callback.id,
      {
        processingStatus: callbackProcessingStatus,
        errorMessage: factoryFailure
          ? 'factory_status_failed_requires_manual_review'
          : null,
        orderId: order.id,
      },
      connection
    );
    const shopifyUpdateTaskResult = await ensureShopifyUpdateTaskDryRun({
      order: updatedOrder,
      factoryCallback: updatedCallback,
      factoryStatus: normalized.status,
      factoryPayload: payload,
      db: connection,
      logCreation: false,
    });

    await connection.commit();
    transactionStarted = false;
    releaseConnection();

    await logInfo({
      scopeType: 'order',
      orderId: updatedOrder.id,
      step: 'factory_callback.processed',
      message: 'Factory callback simulation processed',
      detailsJson: {
        callbackId: updatedCallback.id,
        factoryStatus: normalized.status,
        previousOrderStatus: order.status,
        orderStatus: updatedOrder.status,
        factoryOrderId: updatedOrder.factory_order_id,
        deliveryId: normalized.deliveryId,
        shopifyUpdateTaskId: shopifyUpdateTaskResult.task?.id ?? null,
        shopifyUpdateTaskCreated: shopifyUpdateTaskResult.created,
        shopifyUpdateTaskType:
          shopifyUpdateTaskResult.task?.task_type ?? null,
        shopifyUpdateSuppressed: Boolean(shopifyUpdateTaskResult.task),
      },
    });

    return {
      httpStatus: factoryFailure ? 202 : 200,
      body: {
        ok: true,
        callbackId: updatedCallback.id,
        processingStatus: updatedCallback.processing_status,
        orderId: updatedOrder.id,
        orderUpdated: true,
        factoryStatus: updatedOrder.factory_status,
        orderStatus: updatedOrder.status,
        shopifyUpdateTaskId: shopifyUpdateTaskResult.task?.id ?? null,
        shopifyUpdateTaskCreated: shopifyUpdateTaskResult.created,
        shopifyUpdateTaskType:
          shopifyUpdateTaskResult.task?.task_type ?? null,
        shopifyUpdateSuppressed: Boolean(shopifyUpdateTaskResult.task),
      },
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
      transactionStarted = false;
    }

    releaseConnection();

    if (normalized.deliveryId && isDuplicateKeyError(error)) {
      const originalCallback = await findOriginalFactoryCallbackByDeliveryId(
        normalized.deliveryId
      );

      if (originalCallback) {
        return buildDuplicateCallbackResult(originalCallback, normalized);
      }
    }

    throw error;
  } finally {
    releaseConnection();
  }
}

export default {
  SIMULATED_FACTORY_STATUSES,
  receiveFactoryCallback,
};
