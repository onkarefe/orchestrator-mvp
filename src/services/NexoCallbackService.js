import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import env from '../config/env.js';
import {
  FACTORY_CALLBACK_PROCESSING_STATUSES,
  FACTORY_UPLOAD_TASK_STATUSES,
  ORDER_STATUSES,
  STATUS_GROUPS,
} from '../constants/statuses.js';
import pool from '../db/connection.js';
import { isDuplicateKeyError } from '../db/errors.js';
import { findArtifactById } from '../models/ArtifactModel.js';
import {
  createFactoryCallback,
  findFactoryCallbackByIdForUpdate,
  RECOVERABLE_NEXO_CALLBACK_REASONS,
  holdNexoReplayTaskConflict,
  findLatestNexoCallbackByPackageAndStatus,
  findOriginalFactoryCallbackByDeliveryId,
  updateFactoryCallbackProcessingStatus,
} from '../models/FactoryCallbackModel.js';
import { findFactoryUploadTaskByOrderPackageId } from '../models/FactoryUploadTaskModel.js';
import {
  findOrderFactoryPackageByNexoOrderIdForUpdate,
  findOrderFactoryPackageByShopifyOrderIdForUpdate,
  updateOrderFactoryPackageNexoState,
  updateOrderFactoryPackageAggregateStatus,
} from '../models/OrderFactoryPackageModel.js';
import {
  listOrderLineItemsByOrderIdForUpdate,
  findOrderLineItemByNexoJobId,
  updateOrderLineItemNexoState,
} from '../models/OrderLineItemModel.js';
import { xmlEscape } from '../processing/xml.js';
import {
  findOrderByShopifyOrderIdForUpdate,
  updateOrderFactoryState,
} from '../models/OrderModel.js';
import { redact } from '../utils/redact.js';
import { logInfo, logWarning } from './LogService.js';
import {
  getNexoDeliveryIdentity,
  canonicalizeNexoTrackingPayload,
  getNexoOrderStatus,
  getNexoStatusSequenceIssue,
  validateNexoCallbackPayload,
} from './NexoCallbackAdapter.js';
import { ensureNexoShopifyUpdateTask, buildNexoPositionShipment } from './ShopifyUpdateTaskService.js';
import { canTransition } from './statusTransition.js';
import { resolveFactoryUploadFiles } from './FactoryUploadService.js';

const NEXO_PROVIDER = 'nexo';

const FACTORY_CALLBACK_READY_ORDER_STATUSES = new Set([
  ORDER_STATUSES.COMPLETED,
  ORDER_STATUSES.FACTORY_RECEIVED,
  ORDER_STATUSES.PRODUCTION_STARTED,
  ORDER_STATUSES.PRODUCTION_COMPLETED,
  ORDER_STATUSES.READY_FOR_SHIPPING,
  ORDER_STATUSES.SHIPPED,
]);

const FACTORY_ORDER_STATUS_RANK = Object.freeze({
  [ORDER_STATUSES.COMPLETED]: 0,
  [ORDER_STATUSES.FACTORY_RECEIVED]: 1,
  [ORDER_STATUSES.PRODUCTION_STARTED]: 2,
  [ORDER_STATUSES.PRODUCTION_COMPLETED]: 3,
  [ORDER_STATUSES.READY_FOR_SHIPPING]: 4,
  [ORDER_STATUSES.SHIPPED]: 5,
});

const DEFAULT_RUNTIME = Object.freeze({
  getConnection: () => pool.getConnection(),
  holdNexoReplayTaskConflict,
  findFactoryCallbackByIdForUpdate,
  createFactoryCallback,
  findArtifactById,
  findFactoryUploadTaskByOrderPackageId,
  findLatestNexoCallbackByPackageAndStatus,
  findOrderByShopifyOrderIdForUpdate,
  findOrderFactoryPackageByNexoOrderIdForUpdate,
  findOrderFactoryPackageByShopifyOrderIdForUpdate,
  findOriginalFactoryCallbackByDeliveryId,
  updateFactoryCallbackProcessingStatus,
  updateOrderFactoryPackageNexoState,
  updateOrderFactoryPackageAggregateStatus,
  listOrderLineItemsByOrderIdForUpdate,
  findOrderLineItemByNexoJobId,
  updateOrderLineItemNexoState,
  readNexoCallbackPackage,
  updateOrderFactoryState,
  ensureNexoShopifyUpdateTask,
  logInfo,
  logWarning,
});

function callbackRuntime(overrides = {}) {
  return { ...DEFAULT_RUNTIME, ...overrides };
}

function normalizeHeaders(headers) {
  const normalized = {};

  for (const [name, value] of Object.entries(headers ?? {})) {
    normalized[String(name).toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }

  return normalized;
}

function scalarHeader(headers, names) {
  const normalizedHeaders = normalizeHeaders(headers);

  for (const name of names) {
    const value = normalizedHeaders[name];

    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }

  return null;
}

function getPresentedNexoApiKey(headers) {
  const directKey = scalarHeader(headers, [
    'x-nexo-api-key',
    'x-nexo-callback-api-key',
  ]);

  if (directKey) {
    return directKey;
  }

  const authorization = scalarHeader(headers, ['authorization']);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() || null : null;
}

function timingSafeSecretEquals(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left ?? ''), 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(String(right ?? ''), 'utf8').digest();

  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

export function authenticateNexoCallback(headers, config = env) {
  if (!config.NEXO_CALLBACK_AUTH_ENABLED) {
    return {
      authChecked: false,
      authValid: null,
      error: null,
    };
  }

  const configuredApiKey = String(config.NEXO_CALLBACK_API_KEY ?? '').trim();

  if (!configuredApiKey) {
    return {
      authChecked: true,
      authValid: false,
      error: 'nexo_callback_api_key_not_configured',
    };
  }

  const presentedApiKey = getPresentedNexoApiKey(headers);
  const authValid = Boolean(
    presentedApiKey && timingSafeSecretEquals(presentedApiKey, configuredApiKey)
  );

  return {
    authChecked: true,
    authValid,
    error: authValid ? null : 'invalid_nexo_callback_auth',
  };
}

function callbackRecordData({
  payload,
  headers,
  normalized,
  deliveryIdentity,
  authValid,
  processingStatus,
  errorMessage = null,
  duplicateOfId = null,
  orderId = null,
  orderFactoryPackageId = null,
}) {
  return {
    provider: NEXO_PROVIDER,
    orderId,
    jobId: null,
    orderFactoryPackageId,
    factoryReference: normalized?.reference ?? null,
    shopifyOrderId: normalized?.referenceParts?.shopifyOrderId ?? null,
    factoryOrderId: normalized?.nexoJobId ?? null,
    deliveryId: deliveryIdentity?.deliveryId ?? null,
    status: normalized?.status ?? null,
    trackingCount: normalized?.trackingNumbers?.length ?? 0,
    rawPayloadJson: redact(payload ?? null),
    headersJson: redact(headers ?? {}),
    authValid,
    duplicateOfId,
    processingStatus,
    errorMessage,
  };
}

async function recordRejectedNexoCallback({
  payload,
  headers,
  normalized,
  deliveryIdentity,
  authValid,
  processingStatus,
  errorMessage,
  orderId = null,
  orderFactoryPackageId = null,
  duplicateOfId = null,
  runtime: runtimeOverrides = {},
}) {
  const runtime = callbackRuntime(runtimeOverrides);
  const callback = await runtime.createFactoryCallback(
    callbackRecordData({
      payload,
      headers,
      normalized,
      deliveryIdentity,
      authValid,
      processingStatus,
      errorMessage,
      orderId,
      orderFactoryPackageId,
      duplicateOfId,
    })
  );

  await runtime.logWarning({
    scopeType: orderId ? 'order' : 'system',
    orderId,
    jobId: null,
    step: 'nexo_callback.rejected',
    message: 'NEXO callback rejected or held for manual review',
    detailsJson: {
      callbackId: callback.id,
      orderFactoryPackageId,
      processingStatus,
      errorMessage,
      reference: callback.factory_reference,
      nexoExternalId: callback.factory_order_id,
    },
  });

  return callback;
}

function hasSameNexoEventSemantics(originalCallback, normalized) {
  const originalValidation = validateNexoCallbackPayload(
    originalCallback.raw_payload_json
  );

  if (!originalValidation.ok) {
    return false;
  }

  const originalEventKey = getNexoDeliveryIdentity({
    headers: {},
    normalized: originalValidation.normalized,
  }).deliveryId;
  const currentEventKey = getNexoDeliveryIdentity({
    headers: {},
    normalized,
  }).deliveryId;

  return originalEventKey === currentEventKey;
}

async function resolveTransportDuplicate({
  originalCallback,
  payload,
  headers,
  normalized,
  deliveryIdentity,
  authValid,
  runtime,
}) {
  if (!hasSameNexoEventSemantics(originalCallback, normalized)) {
    const callback = await recordRejectedNexoCallback({
      payload,
      headers,
      normalized,
      deliveryIdentity,
      authValid,
      processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
      errorMessage: 'nexo_delivery_id_payload_mismatch',
      duplicateOfId: originalCallback.id,
      orderId: originalCallback.order_id ?? null,
      orderFactoryPackageId:
        originalCallback.order_factory_package_id ?? null,
      runtime,
    });

    return {
      httpStatus: 202,
      body: {
        ok: true,
        duplicate: false,
        callbackId: callback.id,
        duplicateOfId: originalCallback.id,
        processingStatus: callback.processing_status,
        orderId: originalCallback.order_id ?? null,
        orderFactoryPackageId:
          originalCallback.order_factory_package_id ?? null,
        orderUpdated: false,
        shopifyUpdateTaskCreated: false,
        error: 'nexo_delivery_id_payload_mismatch',
      },
    };
  }

  await runtime.logInfo({
    scopeType: originalCallback.order_id ? 'order' : 'system',
    orderId: originalCallback.order_id ?? null,
    jobId: null,
    step: 'nexo_callback.duplicate',
    message: 'Duplicate NEXO callback delivery safely ignored',
    detailsJson: {
      callbackId: originalCallback.id,
      orderFactoryPackageId:
        originalCallback.order_factory_package_id ?? null,
      shopifyOrderId: originalCallback.shopify_order_id ?? null,
      reference: originalCallback.factory_reference ?? null,
      nexoExternalId: originalCallback.factory_order_id ?? null,
      nexoStatus: originalCallback.status ?? null,
      duplicateReason: 'same_delivery',
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
      orderId: originalCallback.order_id ?? null,
      orderFactoryPackageId:
        originalCallback.order_factory_package_id ?? null,
      orderUpdated: false,
      shopifyUpdateTaskCreated: false,
    },
  };
}

function getPackageRelationshipIssue({
  order,
  orderPackage,
  artifact,
  uploadTask,
  normalized,
}) {
  if (
    !orderPackage ||
    String(orderPackage.order_id) !== String(order.id) ||
    String(orderPackage.shopify_order_id) !== String(order.shopify_order_id) ||
    orderPackage.order_number !== `WANDINI-S${normalized.referenceParts.shopifyOrderId}`
  ) {
    return 'order_factory_package_identity_mismatch';
  }

  if (
    orderPackage.status !== 'ready' ||
    !artifact ||
    String(artifact.id) !== String(orderPackage.artifact_id) ||
    String(artifact.order_id) !== String(order.id) ||
    artifact.job_id !== null ||
    artifact.type !== 'factory_package' ||
    artifact.status !== 'available' ||
    artifact.validation_status !== 'passed'
  ) {
    return 'order_factory_package_not_valid';
  }

  if (
    uploadTask && (
      String(uploadTask.order_factory_package_id) !== String(orderPackage.id) ||
      String(uploadTask.order_id) !== String(order.id) ||
      String(uploadTask.artifact_id) !== String(orderPackage.artifact_id) ||
      String(uploadTask.shopify_order_id) !== String(order.shopify_order_id) ||
      uploadTask.factory_reference !== orderPackage.order_number ||
      uploadTask.job_id !== null
    )
  ) {
    return 'order_factory_upload_identity_mismatch';
  }
  if (!uploadTask || uploadTask.status !== FACTORY_UPLOAD_TASK_STATUSES.UPLOADED) {
    return 'order_factory_package_not_dispatched';
  }

  return null;
}

function getOrderUpdateDecision(order, targetOrderStatus) {
  if (!FACTORY_CALLBACK_READY_ORDER_STATUSES.has(order.status)) {
    return {
      update: false,
      error: 'order_not_ready_for_nexo_callback',
    };
  }

  if (canTransition(STATUS_GROUPS.ORDER, order.status, targetOrderStatus)) {
    return {
      update: order.status !== targetOrderStatus,
      error: null,
    };
  }

  return {
    update: false,
    error: 'unsafe_order_status_transition',
  };
}

function requiresShopifyTask(status) {
  return status === 'shipped';
}

// Read only the immutable local package; the upload resolver verifies its paths,
// XML/PDF checksums and durable content checksum without contacting FTP.
export async function readNexoCallbackPackage({ artifact, orderPackage, artifactsRoot }) {
  if (!orderPackage.manifest_path ||
      path.resolve(orderPackage.manifest_path) !== path.resolve(artifact.manifest_path ?? '')) {
    throw new Error('nexo_package_manifest_identity_mismatch');
  }
  const files = await resolveFactoryUploadFiles({ artifact, orderPackage, artifactsRoot });
  const xml = await fs.readFile(files.xmlFile.filePath, 'utf8');
  if (crypto.createHash('sha256').update(xml).digest('hex') !== files.xmlFile.checksum) {
    throw new Error('nexo_package_xml_changed');
  }
  const manifest = JSON.parse(await fs.readFile(artifact.manifest_path, 'utf8'));
  return { manifest, xml };
}

function getPackagePositionIssue({ order, orderPackage, lineItems, evidence, positionLevel }) {
  const { manifest, xml } = evidence;
  const positions = manifest?.contents?.positions;
  const xmlPositions = [...String(xml).matchAll(/<position>([\s\S]*?)<\/position>/g)];
  if (String(manifest?.order?.id) !== String(order.id) ||
      String(manifest?.order?.shopify_order_id) !== String(order.shopify_order_id) ||
      manifest?.order?.order_number !== orderPackage.order_number ||
      manifest?.validation?.ok !== true || manifest?.validation?.validationStatus !== 'passed' ||
      !String(xml).includes(`<order_number>${xmlEscape(orderPackage.order_number)}</order_number>`) ||
      !Array.isArray(positions) || !positions.length ||
      positions.some(position => !position || typeof position !== 'object') ||
      positions.length !== lineItems.length || positions.length !== xmlPositions.length ||
      Number(manifest.contents.position_count) !== positions.length) {
    return 'nexo_package_position_identity_mismatch';
  }
  if (!positionLevel && (positions.length !== 1 || /<reference\b/.test(xml) ||
      lineItems.some(line => line.nexo_job_id || line.nexo_status))) {
    return 'nexo_legacy_position_identity_ambiguous';
  }
  const matched = new Set();
  for (const [index, position] of positions.entries()) {
    const line = lineItems.find(item =>
      String(item.shopify_line_item_id) === String(position.shopify_line_item_id) &&
      Number(item.source_position) === position.source_position);
    if (!line || matched.has(String(line.id)) ||
        !/^[1-9]\d*$/.test(String(line.id)) || !/^[1-9]\d*$/.test(String(line.shopify_line_item_id)) ||
        !Number.isSafeInteger(position.source_position) || position.source_position < 0 ||
        String(line.order_id) !== String(order.id) ||
        String(line.shopify_order_id) !== String(order.shopify_order_id) ||
        !['WALLPAPER', 'ACCESSORY'].includes(line.classification) ||
        line.sku !== position.sku || Number(line.quantity) !== position.quantity ||
        !xmlPositions[index][1].includes(`<sku>${xmlEscape(line.sku)}</sku>`)) {
      return 'nexo_package_position_identity_mismatch';
    }
    matched.add(String(line.id));
    if (positionLevel) {
      const reference = xmlPositions[index][1].match(/^\s*<reference>([^<]+)<\/reference>\s*<sku>/)?.[1];
      if (reference !== `WANDINI-S${order.shopify_order_id}-J${line.id}`) {
        return 'nexo_position_reference_not_dispatched';
      }
    }
  }
  return null;
}

const POSITION_PROGRESS = ['accepted', 'ready_to_print', 'printed', 'shipped'];

function aggregatePositionStatus(lineItems) {
  const exception = lineItems.find(line => ['cancelled', 'error'].includes(line.nexo_status));
  if (exception) return exception.nexo_status;
  if (lineItems.some(line => !line.nexo_status)) return null;
  return POSITION_PROGRESS[Math.min(...lineItems.map(line => POSITION_PROGRESS.indexOf(line.nexo_status)))];
}

function storedPositionTracking(line) {
  let trackingNumbers = line.nexo_tracking_json;
  if (typeof trackingNumbers === 'string') {
    try { trackingNumbers = JSON.parse(trackingNumbers); } catch { return null; }
  }
  if (!Array.isArray(trackingNumbers)) return null;
  return canonicalizeNexoTrackingPayload({
    status: 'shipped', parcelService: line.nexo_parcel_service, trackingNumbers,
  });
}

async function logManualReview(
  callback,
  errorMessage,
  orderId,
  orderFactoryPackageId,
  runtime
) {
  await runtime.logWarning({
    scopeType: orderId ? 'order' : 'system',
    orderId,
    jobId: null,
    step: 'nexo_callback.manual_review',
    message: 'NEXO callback requires manual review',
    detailsJson: {
      callbackId: callback.id,
      orderFactoryPackageId,
      errorMessage,
      reference: callback.factory_reference,
      nexoExternalId: callback.factory_order_id,
      nexoStatus: callback.status,
    },
  });
}

export async function recordNexoTransportFailure({
  rawBody,
  headers,
  errorCode,
  config = env,
  runtime: runtimeOverrides = {},
}) {
  const runtime = callbackRuntime(runtimeOverrides);
  const auth = authenticateNexoCallback(headers, config);
  const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0);
  const payloadAudit = {
    rawPayloadUnavailable: true,
    byteLength: rawBuffer.length,
    sha256: crypto.createHash('sha256').update(rawBuffer).digest('hex'),
    transportError: errorCode,
  };
  const processingStatus = auth.error
    ? FACTORY_CALLBACK_PROCESSING_STATUSES.FAILED
    : FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW;
  const callback = await recordRejectedNexoCallback({
    payload: payloadAudit,
    headers,
    normalized: null,
    deliveryIdentity: getNexoDeliveryIdentity({ headers, normalized: null }),
    authValid: auth.authValid,
    processingStatus,
    errorMessage: auth.error ?? errorCode,
    runtime,
  });

  return {
    auth,
    callback,
  };
}

export async function receiveNexoCallback({
  payload,
  headers,
  config = env,
  runtime: runtimeOverrides = {},
}) {
  const runtime = callbackRuntime(runtimeOverrides);
  const auth = authenticateNexoCallback(headers, config);
  const validation = validateNexoCallbackPayload(payload);
  const normalized = validation.normalized;
  const deliveryIdentity = getNexoDeliveryIdentity({ headers, normalized });

  if (auth.error) {
    const callback = await recordRejectedNexoCallback({
      payload,
      headers,
      normalized,
      deliveryIdentity,
      authValid: false,
      processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.FAILED,
      errorMessage: auth.error,
      runtime,
    });

    return {
      httpStatus:
        auth.error === 'nexo_callback_api_key_not_configured' ? 503 : 401,
      body: {
        ok: false,
        error: auth.error,
        callbackId: callback.id,
        processingStatus: callback.processing_status,
      },
    };
  }

  if (!auth.authChecked) {
    await runtime.logWarning({
      scopeType: 'system',
      step: 'nexo_callback.auth_not_enforced',
      message: 'NEXO callback authentication is disabled',
    });
  }

  if (!validation.ok) {
    const callback = await recordRejectedNexoCallback({
      payload,
      headers,
      normalized,
      deliveryIdentity,
      authValid: auth.authValid,
      processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
      errorMessage: validation.errors.join(', '),
      runtime,
    });

    return {
      httpStatus: 400,
      body: {
        ok: false,
        error: 'invalid_nexo_callback_payload',
        errors: validation.errors,
        callbackId: callback.id,
        processingStatus: callback.processing_status,
      },
    };
  }

  return processValidatedNexoCallback({
    runtime, auth, payload, headers, normalized, deliveryIdentity,
  });
}

// Replay uses durable proof of successful authentication, never stored/redacted secrets.
export async function replayNexoCallback(callbackId, { runtime = {} } = {}) {
  return processValidatedNexoCallback({
    runtime: callbackRuntime(runtime), replayCallbackId: callbackId,
  });
}

async function processValidatedNexoCallback({
  runtime, auth, payload, headers, normalized, deliveryIdentity,
  replayCallbackId = null,
}) {
  const connection = await runtime.getConnection();
  let transactionStarted = false;
  let matchedOrderId = null;
  let matchedOrderFactoryPackageId = null;
  let matchedOrderLineItemId = null;
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

    let replayCallback = null;
    if (replayCallbackId !== null) {
      replayCallback = await runtime.findFactoryCallbackByIdForUpdate(
        replayCallbackId, connection
      );
      if (
        !replayCallback || replayCallback.provider !== NEXO_PROVIDER ||
        ![true, 1].includes(replayCallback.auth_valid) ||
        replayCallback.processing_status !== FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW ||
        !RECOVERABLE_NEXO_CALLBACK_REASONS.includes(replayCallback.error_message)
      ) {
        await connection.commit();
        transactionStarted = false;
        releaseConnection();
        return { httpStatus: 200, body: { skipped: true, callbackId: replayCallbackId } };
      }
      payload = replayCallback.raw_payload_json;
      const validation = validateNexoCallbackPayload(payload);
      normalized = validation.normalized;
      if (
        !validation.ok ||
        normalized.reference !== replayCallback.factory_reference ||
        normalized.nexoJobId !== String(replayCallback.factory_order_id) ||
        normalized.status !== replayCallback.status ||
        (replayCallback.order_line_item_id != null &&
          normalized.referenceParts?.orderLineItemId !== String(replayCallback.order_line_item_id)) ||
        normalized.referenceParts?.shopifyOrderId !== String(replayCallback.shopify_order_id)
      ) {
        await runtime.updateFactoryCallbackProcessingStatus(replayCallback.id, {
          processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
          errorMessage: 'nexo_replay_payload_identity_mismatch',
        }, connection);
        await connection.commit();
        transactionStarted = false;
        releaseConnection();
        return { httpStatus: 202, body: {
          callbackId: replayCallback.id, error: 'nexo_replay_payload_identity_mismatch',
        } };
      }
      auth = { authValid: true };
      headers = {};
      deliveryIdentity = { deliveryId: replayCallback.delivery_id };
    }

    const originalDelivery = await runtime.findOriginalFactoryCallbackByDeliveryId(
      deliveryIdentity.deliveryId,
      connection,
      NEXO_PROVIDER
    );

    if (originalDelivery) {
      if (replayCallback) {
        const sameEvent = hasSameNexoEventSemantics(originalDelivery, normalized);
        await runtime.updateFactoryCallbackProcessingStatus(replayCallback.id, {
          processingStatus: sameEvent
            ? FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE
            : FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
          duplicateOfId: originalDelivery.id,
          errorMessage: sameEvent ? null : 'nexo_delivery_id_payload_mismatch',
        }, connection);
        await connection.commit();
        transactionStarted = false;
        releaseConnection();
        return { httpStatus: sameEvent ? 200 : 202, body: {
          callbackId: replayCallback.id, duplicate: sameEvent,
          error: sameEvent ? null : 'nexo_delivery_id_payload_mismatch',
        } };
      }
      await connection.commit();
      transactionStarted = false;
      releaseConnection();
      return await resolveTransportDuplicate({
        originalCallback: originalDelivery,
        payload,
        headers,
        normalized,
        deliveryIdentity,
        authValid: auth.authValid,
        runtime,
      });
    }

    const callback = replayCallback ?? await runtime.createFactoryCallback(
      callbackRecordData({
        payload,
        headers,
        normalized,
        deliveryIdentity,
        authValid: auth.authValid,
        processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.RECEIVED,
      }),
      connection
    );

    const finishManualReview = async ({
      errorMessage,
      orderId = null,
      orderFactoryPackageId = null,
    }) => {
      const updatedCallback = await runtime.updateFactoryCallbackProcessingStatus(
        callback.id,
        {
          processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
          errorMessage,
          orderId,
          jobId: null,
          orderFactoryPackageId,
          orderLineItemId: matchedOrderLineItemId,
        },
        connection
      );

      await connection.commit();
      transactionStarted = false;
      releaseConnection();
      await logManualReview(
        updatedCallback,
        errorMessage,
        orderId,
        orderFactoryPackageId,
        runtime
      );

      return {
        httpStatus: 202,
        body: {
          ok: true,
          callbackId: updatedCallback.id,
          processingStatus: updatedCallback.processing_status,
          orderId,
          orderFactoryPackageId,
          orderUpdated: false,
          shopifyUpdateTaskCreated: false,
          error: errorMessage,
        },
      };
    };

    const order = await runtime.findOrderByShopifyOrderIdForUpdate(
      normalized.referenceParts.shopifyOrderId,
      connection
    );

    if (!order) {
      return await finishManualReview({
        errorMessage: 'nexo_callback_order_not_found',
      });
    }

    matchedOrderId = order.id;

    if (
      String(order.shopify_order_id) !==
      normalized.referenceParts.shopifyOrderId
    ) {
      return await finishManualReview({
        errorMessage: 'nexo_callback_shopify_order_id_mismatch',
        orderId: order.id,
      });
    }

    if (order.status === 'SECURITY_HOLD') {
      return await finishManualReview({ errorMessage: 'checkout_security_hold', orderId: order.id });
    }

    const matchingPackages =
      await runtime.findOrderFactoryPackageByShopifyOrderIdForUpdate(
        normalized.referenceParts.shopifyOrderId,
        connection
      );

    if (matchingPackages.length !== 1) {
      return await finishManualReview({
        errorMessage:
          matchingPackages.length === 0
            ? 'nexo_order_factory_package_not_found'
            : 'nexo_multiple_order_factory_packages',
        orderId: order.id,
      });
    }

    const orderPackage = matchingPackages[0];
    matchedOrderFactoryPackageId = orderPackage.id;
    const artifact = await runtime.findArtifactById(
      orderPackage.artifact_id,
      connection
    );
    const uploadTask = await runtime.findFactoryUploadTaskByOrderPackageId(
      orderPackage.id,
      connection
    );
    const relationshipIssue = getPackageRelationshipIssue({
      order,
      orderPackage,
      artifact,
      uploadTask,
      normalized,
    });

    if (relationshipIssue) {
      return await finishManualReview({
        errorMessage: relationshipIssue,
        orderId: order.id,
        orderFactoryPackageId: orderPackage.id,
      });
    }

    // The order lock serializes callbacks across all positions of this order.
    const lineItems = await runtime.listOrderLineItemsByOrderIdForUpdate(order.id, connection);
    const positionLevel = Boolean(normalized.referenceParts.orderLineItemId);
    const review = errorMessage => finishManualReview({
      errorMessage, orderId: order.id, orderFactoryPackageId: orderPackage.id,
    });
    let evidence;
    try {
      evidence = await runtime.readNexoCallbackPackage({ artifact, orderPackage });
    } catch {
      return await review('nexo_dispatched_package_unverifiable');
    }
    const positionIssue = getPackagePositionIssue({ order, orderPackage, lineItems, evidence, positionLevel });
    if (positionIssue) return await review(positionIssue);

    if (positionLevel) {
      const line = lineItems.find(item => String(item.id) === normalized.referenceParts.orderLineItemId);
      if (!line) return await review('nexo_order_line_item_not_found');
      matchedOrderLineItemId = line.id;
      if (line.nexo_job_id && String(line.nexo_job_id) !== normalized.nexoJobId) {
        return await review('nexo_position_external_id_mismatch');
      }
      if (lineItems.some(item => item.nexo_status && !item.nexo_job_id)) {
        return await review('nexo_position_status_without_bound_external_id');
      }
      if (lineItems.some(item => item.nexo_status &&
          ![...POSITION_PROGRESS, 'cancelled', 'error'].includes(item.nexo_status))) {
        return await review('unknown_existing_nexo_status');
      }
      const boundLine = await runtime.findOrderLineItemByNexoJobId(normalized.nexoJobId, connection);
      if (boundLine && String(boundLine.id) !== String(line.id)) {
        return await review('nexo_external_id_already_bound_to_another_position');
      }
      const sequenceIssue = getNexoStatusSequenceIssue(line.nexo_status, normalized.status, { positionLevel: true });
      if (sequenceIssue) return await review(sequenceIssue);
      if (!FACTORY_CALLBACK_READY_ORDER_STATUSES.has(order.status)) {
        return await review('order_not_ready_for_nexo_callback');
      }
      const previousAggregate = aggregatePositionStatus(lineItems);
      if ((order.factory_status ?? null) !== previousAggregate ||
          (orderPackage.factory_status ?? null) !== previousAggregate) {
        return await review('order_package_factory_status_mismatch');
      }
      const duplicate = line.nexo_status === normalized.status;
      const tracking = canonicalizeNexoTrackingPayload(normalized);
      if (duplicate && normalized.status === 'shipped' &&
          JSON.stringify(storedPositionTracking(line)) !== JSON.stringify(tracking)) {
        return await review('nexo_position_tracking_conflict');
      }
      const projected = lineItems.map(item => item === line ? {
        ...item, nexo_status: normalized.status, nexo_job_id: normalized.nexoJobId,
        nexo_tracking_json: tracking?.trackingNumbers ?? null, nexo_parcel_service: tracking?.parcelService ?? null,
      } : item);
      const projectedStatus = aggregatePositionStatus(projected);
      const targetStatus = projectedStatus ? getNexoOrderStatus(projectedStatus) : order.status;
      const isException = ['cancelled', 'error'].includes(projectedStatus);
      if (order.status === ORDER_STATUSES.SHIPPED && (!duplicate || projectedStatus !== 'shipped')) {
        return await review('unsafe_order_status_transition');
      }
      const advance = !duplicate && (isException ||
        FACTORY_ORDER_STATUS_RANK[targetStatus] > FACTORY_ORDER_STATUS_RANK[order.status]);
      if (advance && !canTransition(STATUS_GROUPS.ORDER, order.status, targetStatus)) {
        return await review('unsafe_order_status_transition');
      }
      if (projectedStatus === 'shipped') {
        try {
          buildNexoPositionShipment({ order, orderPackage, lineItems: projected });
        } catch (error) {
          if (error.code !== 'NEXO_POSITION_SHIPMENT_INVALID') throw error;
          return await review(error.message);
        }
      }

      let persisted = lineItems;
      let updatedPackage = orderPackage;
      let updatedOrder = order;
      if (!duplicate) {
        let updated;
        try {
          updated = await runtime.updateOrderLineItemNexoState(line.id, {
            orderId: order.id, nexoJobId: normalized.nexoJobId, status: normalized.status,
            parcelService: tracking?.parcelService, trackingNumbers: tracking?.trackingNumbers,
          }, connection);
        } catch (error) {
          // A competing order can win the unique external-ID binding after our read.
          if (!isDuplicateKeyError(error)) throw error;
          return await review('nexo_external_id_already_bound_to_another_position');
        }
        if (!updated) return await review('nexo_position_conditional_binding_failed');
        persisted = await runtime.listOrderLineItemsByOrderIdForUpdate(order.id, connection);
        const aggregate = aggregatePositionStatus(persisted);
        if (aggregate !== projectedStatus) throw new Error('NEXO position aggregate changed under order lock');
        updatedPackage = await runtime.updateOrderFactoryPackageAggregateStatus(orderPackage.id, aggregate, connection);
        updatedOrder = await runtime.updateOrderFactoryState(order.id, {
          factoryStatus: aggregate ?? undefined,
          status: advance ? targetStatus : undefined,
          manualReviewReason: isException ? `nexo_callback_${aggregate}` : undefined,
        }, connection);
      }
      const processingStatus = duplicate ? FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE
        : isException ? FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW
          : FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED;
      const updatedCallback = await runtime.updateFactoryCallbackProcessingStatus(callback.id, {
        processingStatus, orderId: order.id, orderFactoryPackageId: orderPackage.id,
        orderLineItemId: line.id,
        errorMessage: isException ? `nexo_status_${projectedStatus}_requires_manual_review` : null,
      }, connection);
      const shopifyTaskResult = projectedStatus === 'shipped'
        ? await runtime.ensureNexoShopifyUpdateTask({
          order: updatedOrder, orderPackage: updatedPackage, factoryCallback: updatedCallback,
          positionLineItems: persisted, db: connection,
        })
        : { task: null, created: false };
      if (projectedStatus === 'shipped' && !shopifyTaskResult.task) {
        throw new Error('Required NEXO position shipment Shopify task was not created or found');
      }
      await connection.commit();
      transactionStarted = false;
      releaseConnection();
      await runtime[isException ? 'logWarning' : 'logInfo']({
        scopeType: 'order', orderId: order.id, jobId: null,
        step: duplicate ? 'nexo_callback.duplicate' : 'nexo_callback.position_processed',
        message: duplicate ? 'Duplicate NEXO position status safely ignored' : 'NEXO position callback processed',
        detailsJson: {
          callbackId: updatedCallback.id, orderFactoryPackageId: orderPackage.id,
          orderLineItemId: line.id, reference: normalized.reference,
          nexoExternalId: normalized.nexoJobId, nexoStatus: normalized.status,
          aggregateFactoryStatus: projectedStatus,
          shopifyUpdateTaskId: shopifyTaskResult.task?.id ?? null,
          shopifyUpdateTaskCreated: shopifyTaskResult.created,
        },
      });
      return { httpStatus: isException ? 202 : 200, body: {
        ok: true, duplicate, callbackId: updatedCallback.id, processingStatus,
        orderId: order.id, orderFactoryPackageId: orderPackage.id, orderLineItemId: line.id,
        orderUpdated: advance, orderStatus: advance ? targetStatus : order.status,
        shopifyUpdateTaskId: shopifyTaskResult.task?.id ?? null,
        shopifyUpdateTaskCreated: shopifyTaskResult.created,
      } };
    }

    if (
      orderPackage.nexo_order_id &&
      String(orderPackage.nexo_order_id) !== normalized.nexoJobId
    ) {
      return await finishManualReview({
        errorMessage: 'nexo_external_id_mismatch',
        orderId: order.id,
        orderFactoryPackageId: orderPackage.id,
      });
    }

    if (orderPackage.factory_status && !orderPackage.nexo_order_id) {
      return await finishManualReview({
        errorMessage: 'nexo_status_without_bound_external_id',
        orderId: order.id,
        orderFactoryPackageId: orderPackage.id,
      });
    }

    if (
      order.factory_order_id &&
      String(order.factory_order_id) !== normalized.nexoJobId
    ) {
      return await finishManualReview({
        errorMessage: 'order_nexo_external_id_mismatch',
        orderId: order.id,
        orderFactoryPackageId: orderPackage.id,
      });
    }

    if (
      (order.factory_status ?? null) !==
      (orderPackage.factory_status ?? null)
    ) {
      return await finishManualReview({
        errorMessage: 'order_package_factory_status_mismatch',
        orderId: order.id,
        orderFactoryPackageId: orderPackage.id,
      });
    }

    const packageAlreadyBoundToNexoId =
      await runtime.findOrderFactoryPackageByNexoOrderIdForUpdate(
        normalized.nexoJobId,
        connection
      );

    if (
      packageAlreadyBoundToNexoId &&
      String(packageAlreadyBoundToNexoId.id) !== String(orderPackage.id)
    ) {
      return await finishManualReview({
        errorMessage: 'nexo_external_id_already_bound_to_another_package',
        orderId: order.id,
        orderFactoryPackageId: orderPackage.id,
      });
    }

    const sequenceIssue = getNexoStatusSequenceIssue(
      orderPackage.factory_status,
      normalized.status
    );

    if (sequenceIssue) {
      return await finishManualReview({
        errorMessage: sequenceIssue,
        orderId: order.id,
        orderFactoryPackageId: orderPackage.id,
      });
    }

    const sameSemanticStatus =
      orderPackage.factory_status === normalized.status;
    const priorSemanticCallback = sameSemanticStatus
      ? await runtime.findLatestNexoCallbackByPackageAndStatus(
          {
            orderFactoryPackageId: orderPackage.id,
            nexoOrderId: normalized.nexoJobId,
            status: normalized.status,
          },
          connection
        )
      : null;

    if (sameSemanticStatus && !requiresShopifyTask(normalized.status)) {
      const updatedCallback =
        await runtime.updateFactoryCallbackProcessingStatus(
          callback.id,
          {
            processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE,
            orderId: order.id,
            jobId: null,
            orderFactoryPackageId: orderPackage.id,
            duplicateOfId: priorSemanticCallback?.id ?? null,
          },
          connection
        );

      await connection.commit();
      transactionStarted = false;
      releaseConnection();

      await runtime.logInfo({
        scopeType: 'order',
        orderId: order.id,
        jobId: null,
        step: 'nexo_callback.duplicate',
        message: 'Duplicate NEXO callback status safely ignored',
        detailsJson: {
          callbackId: updatedCallback.id,
          duplicateOfId: priorSemanticCallback?.id ?? null,
          orderFactoryPackageId: orderPackage.id,
          shopifyOrderId: order.shopify_order_id,
          reference: normalized.reference,
          nexoExternalId: normalized.nexoJobId,
          previousNexoStatus: orderPackage.factory_status,
          nexoStatus: normalized.status,
          duplicateReason: 'same_status',
        },
      });

      return {
        httpStatus: 200,
        body: {
          ok: true,
          duplicate: true,
          callbackId: updatedCallback.id,
          duplicateOfId: priorSemanticCallback?.id ?? null,
          processingStatus: updatedCallback.processing_status,
          orderId: order.id,
          orderFactoryPackageId: orderPackage.id,
          orderUpdated: false,
          shopifyUpdateTaskCreated: false,
        },
      };
    }

    const targetOrderStatus = getNexoOrderStatus(normalized.status);
    const orderDecision = sameSemanticStatus
      ? { update: false, error: null }
      : getOrderUpdateDecision(order, targetOrderStatus);

    if (orderDecision.error) {
      return await finishManualReview({
        errorMessage: orderDecision.error,
        orderId: order.id,
        orderFactoryPackageId: orderPackage.id,
      });
    }

    const updatedPackage = sameSemanticStatus
      ? orderPackage
      : await runtime.updateOrderFactoryPackageNexoState(
          orderPackage.id,
          {
            nexoOrderId: normalized.nexoJobId,
            factoryStatus: normalized.status,
          },
          connection
        );

    if (!updatedPackage) {
      return await finishManualReview({
        errorMessage: 'nexo_external_id_conditional_binding_failed',
        orderId: order.id,
        orderFactoryPackageId: orderPackage.id,
      });
    }

    const isFactoryException =
      normalized.status === 'cancelled' || normalized.status === 'error';
    const updatedOrder = sameSemanticStatus
      ? order
      : await runtime.updateOrderFactoryState(
          order.id,
          {
            factoryOrderId: normalized.nexoJobId,
            factoryStatus: normalized.status,
            status: orderDecision.update ? targetOrderStatus : undefined,
            manualReviewReason: isFactoryException
              ? `nexo_callback_${normalized.status}`
              : undefined,
          },
          connection
        );
    const successfulProcessingStatus = isFactoryException
      ? FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW
      : FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED;
    let updatedCallback = await runtime.updateFactoryCallbackProcessingStatus(
      callback.id,
      {
        processingStatus: successfulProcessingStatus,
        errorMessage: isFactoryException
          ? `nexo_status_${normalized.status}_requires_manual_review`
          : null,
        orderId: order.id,
        jobId: null,
        orderFactoryPackageId: orderPackage.id,
      },
      connection
    );
    const shopifyUpdateTaskResult =
      await runtime.ensureNexoShopifyUpdateTask({
        order: updatedOrder,
        orderPackage: updatedPackage,
        factoryCallback: updatedCallback,
        nexoCallback: normalized,
        db: connection,
      });

    if (requiresShopifyTask(normalized.status) && !shopifyUpdateTaskResult.task) {
      throw new Error('Required NEXO Shopify task was not created or found');
    }

    const semanticDuplicate = Boolean(
      sameSemanticStatus &&
      requiresShopifyTask(normalized.status) &&
      !shopifyUpdateTaskResult.created
    );

    if (semanticDuplicate) {
      updatedCallback = await runtime.updateFactoryCallbackProcessingStatus(
        callback.id,
        {
          processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE,
          orderId: order.id,
          jobId: null,
          orderFactoryPackageId: orderPackage.id,
          duplicateOfId: priorSemanticCallback?.id ?? null,
        },
        connection
      );
    }

    await connection.commit();
    transactionStarted = false;
    releaseConnection();

    await runtime.logInfo({
      scopeType: 'order',
      orderId: order.id,
      jobId: null,
      step: semanticDuplicate
        ? 'nexo_callback.duplicate'
        : 'nexo_callback.processed',
      message: semanticDuplicate
        ? 'Duplicate NEXO callback safely ignored'
        : 'NEXO callback processed',
      detailsJson: {
        callbackId: updatedCallback.id,
        orderFactoryPackageId: orderPackage.id,
        shopifyOrderId: order.shopify_order_id,
        reference: normalized.reference,
        nexoExternalId: normalized.nexoJobId,
        previousNexoStatus: orderPackage.factory_status ?? null,
        nexoStatus: normalized.status,
        previousOrderStatus: order.status,
        orderStatus: updatedOrder.status,
        orderUpdated: orderDecision.update,
        shopifyUpdateTaskId: shopifyUpdateTaskResult.task?.id ?? null,
        shopifyUpdateTaskCreated: shopifyUpdateTaskResult.created,
        shopifyUpdateTaskType: shopifyUpdateTaskResult.task?.task_type ?? null,
      },
    });

    return {
      httpStatus: isFactoryException ? 202 : 200,
      body: {
        ok: true,
        duplicate: semanticDuplicate,
        callbackId: updatedCallback.id,
        duplicateOfId: semanticDuplicate
          ? priorSemanticCallback?.id ?? null
          : null,
        processingStatus: updatedCallback.processing_status,
        orderId: order.id,
        orderFactoryPackageId: orderPackage.id,
        reference: normalized.reference,
        nexoExternalId: normalized.nexoJobId,
        nexoStatus: normalized.status,
        orderUpdated: orderDecision.update,
        orderStatus: updatedOrder.status,
        shopifyUpdateTaskId: shopifyUpdateTaskResult.task?.id ?? null,
        shopifyUpdateTaskCreated: shopifyUpdateTaskResult.created,
        shopifyUpdateTaskType: shopifyUpdateTaskResult.task?.task_type ?? null,
        shopifyUpdateSuppressed: Boolean(
          shopifyUpdateTaskResult.task?.dry_run === true ||
            shopifyUpdateTaskResult.task?.payload_json?.writeSuppressed === true
        ),
      },
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
      transactionStarted = false;
    }

    releaseConnection();

    if (replayCallbackId !== null) {
      if (error?.code === 'NEXO_SHOPIFY_TASK_IDEMPOTENCY_CONFLICT') {
        await runtime.holdNexoReplayTaskConflict(replayCallbackId);
        return { httpStatus: 202, body: {
          callbackId: replayCallbackId,
          error: 'nexo_shopify_task_idempotency_conflict',
        } };
      }
      throw error;
    }
    if (isDuplicateKeyError(error)) {
      const originalDelivery =
        await runtime.findOriginalFactoryCallbackByDeliveryId(
          deliveryIdentity.deliveryId,
          undefined,
          NEXO_PROVIDER
        );

      if (originalDelivery) {
        return await resolveTransportDuplicate({
          originalCallback: originalDelivery,
          payload,
          headers,
          normalized,
          deliveryIdentity,
          authValid: auth.authValid,
          runtime,
        });
      }

      if (
        String(error.message ?? '').includes(
          'uq_order_factory_packages_nexo_order_id'
        )
      ) {
        const callback = await recordRejectedNexoCallback({
          payload,
          headers,
          normalized,
          deliveryIdentity,
          authValid: auth.authValid,
          processingStatus:
            FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
          errorMessage: 'nexo_external_id_already_bound_to_another_package',
          orderId: matchedOrderId,
          orderFactoryPackageId: matchedOrderFactoryPackageId,
          runtime,
        });

        return {
          httpStatus: 202,
          body: {
            ok: true,
            callbackId: callback.id,
            processingStatus: callback.processing_status,
            orderId: matchedOrderId,
            orderFactoryPackageId: matchedOrderFactoryPackageId,
            orderUpdated: false,
            shopifyUpdateTaskCreated: false,
            error: 'nexo_external_id_already_bound_to_another_package',
          },
        };
      }
    }

    if (error?.code === 'NEXO_SHOPIFY_TASK_IDEMPOTENCY_CONFLICT') {
      const callback = await recordRejectedNexoCallback({
        payload,
        headers,
        normalized,
        deliveryIdentity,
        authValid: auth.authValid,
        processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
        errorMessage: 'nexo_shopify_task_idempotency_conflict',
        orderId: matchedOrderId,
        orderFactoryPackageId: matchedOrderFactoryPackageId,
        runtime,
      });

      return {
        httpStatus: 202,
        body: {
          ok: true,
          callbackId: callback.id,
          processingStatus: callback.processing_status,
          orderId: matchedOrderId,
          orderFactoryPackageId: matchedOrderFactoryPackageId,
          orderUpdated: false,
          shopifyUpdateTaskCreated: false,
          error: 'nexo_shopify_task_idempotency_conflict',
        },
      };
    }

    throw error;
  } finally {
    releaseConnection();
  }
}

export default {
  authenticateNexoCallback,
  receiveNexoCallback,
  replayNexoCallback,
  recordNexoTransportFailure,
};
