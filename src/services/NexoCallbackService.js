import crypto from 'node:crypto';

import env from '../config/env.js';
import {
  FACTORY_CALLBACK_PROCESSING_STATUSES,
  JOB_STATUSES,
  ORDER_STATUSES,
  STATUS_GROUPS,
} from '../constants/statuses.js';
import pool from '../db/connection.js';
import { isDuplicateKeyError } from '../db/errors.js';
import {
  createFactoryCallback,
  findLatestNexoCallbackByJobAndStatus,
  findOriginalFactoryCallbackByDeliveryId,
  updateFactoryCallbackProcessingStatus,
} from '../models/FactoryCallbackModel.js';
import {
  findJobByFactoryReferenceForUpdate,
  findJobByNexoJobIdForUpdate,
  updateJobNexoState,
} from '../models/JobModel.js';
import {
  findOrderByIdForUpdate,
  updateOrderFactoryState,
} from '../models/OrderModel.js';
import { redact } from '../utils/redact.js';
import { logInfo, logWarning } from './LogService.js';
import {
  getNexoDeliveryIdentity,
  getNexoOrderStatus,
  getNexoStatusSequenceIssue,
  validateNexoCallbackPayload,
} from './NexoCallbackAdapter.js';
import { ensureNexoShopifyUpdateTaskDryRun } from './ShopifyUpdateTaskService.js';
import { canTransition } from './statusTransition.js';

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
  jobId = null,
}) {
  return {
    provider: NEXO_PROVIDER,
    orderId,
    jobId,
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
  jobId = null,
  duplicateOfId = null,
}) {
  const callback = await createFactoryCallback(
    callbackRecordData({
      payload,
      headers,
      normalized,
      deliveryIdentity,
      authValid,
      processingStatus,
      errorMessage,
      orderId,
      jobId,
      duplicateOfId,
    })
  );

  await logWarning({
    scopeType: orderId ? 'order' : 'system',
    orderId,
    jobId,
    step: 'nexo_callback.rejected',
    message: 'NEXO callback rejected or held for manual review',
    detailsJson: {
      callbackId: callback.id,
      processingStatus,
      errorMessage,
      reference: callback.factory_reference,
      nexoJobId: callback.factory_order_id,
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
      jobId: originalCallback.job_id ?? null,
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
        jobId: originalCallback.job_id ?? null,
        orderUpdated: false,
        shopifyUpdateTaskCreated: false,
        error: 'nexo_delivery_id_payload_mismatch',
      },
    };
  }

  return {
    httpStatus: 200,
    body: {
      ok: true,
      duplicate: true,
      callbackId: originalCallback.id,
      duplicateOfId: originalCallback.id,
      processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE,
      orderUpdated: false,
      shopifyUpdateTaskCreated: false,
    },
  };
}

function getJobOrderRelationshipIssue(job, order, normalized) {
  if (!job.order_id) {
    return 'job_order_relationship_missing';
  }

  if (!order || String(order.id) !== String(job.order_id)) {
    return 'job_order_relationship_invalid';
  }

  if (!job.factory_reference || job.factory_reference !== normalized.reference) {
    return 'factory_reference_mismatch';
  }

  if (String(job.id) !== normalized.referenceParts.internalJobId) {
    return 'factory_reference_job_id_mismatch';
  }

  if (
    !job.shopify_order_id ||
    !order.shopify_order_id ||
    String(job.shopify_order_id) !== String(order.shopify_order_id)
  ) {
    return 'job_order_shopify_id_mismatch';
  }

  if (
    String(order.shopify_order_id) !== normalized.referenceParts.shopifyOrderId
  ) {
    return 'factory_reference_shopify_order_id_mismatch';
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
      update: true,
      error: null,
    };
  }

  const currentRank = FACTORY_ORDER_STATUS_RANK[order.status];
  const targetRank = FACTORY_ORDER_STATUS_RANK[targetOrderStatus];

  if (
    currentRank !== undefined &&
    targetRank !== undefined &&
    currentRank > targetRank
  ) {
    return {
      update: false,
      error: null,
    };
  }

  return {
    update: false,
    error: 'unsafe_order_status_transition',
  };
}

function requiresShopifyTask(status) {
  return status === 'printed' || status === 'shipped';
}

async function logManualReview(callback, errorMessage, orderId, jobId) {
  await logWarning({
    scopeType: orderId ? 'order' : 'system',
    orderId,
    jobId,
    step: 'nexo_callback.manual_review',
    message: 'NEXO callback requires manual review',
    detailsJson: {
      callbackId: callback.id,
      errorMessage,
      reference: callback.factory_reference,
      nexoJobId: callback.factory_order_id,
      nexoStatus: callback.status,
    },
  });
}

export async function recordNexoTransportFailure({
  rawBody,
  headers,
  errorCode,
}) {
  const auth = authenticateNexoCallback(headers);
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
  });

  return {
    auth,
    callback,
  };
}

export async function receiveNexoCallback({ payload, headers }) {
  const auth = authenticateNexoCallback(headers);
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
    await logWarning({
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

  const connection = await pool.getConnection();
  let transactionStarted = false;
  let matchedOrderId = null;
  let matchedJobId = null;
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

    const originalDelivery = await findOriginalFactoryCallbackByDeliveryId(
      deliveryIdentity.deliveryId,
      connection,
      NEXO_PROVIDER
    );

    if (originalDelivery) {
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
      });
    }

    const callback = await createFactoryCallback(
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
    const job = await findJobByFactoryReferenceForUpdate(
      normalized.reference,
      connection
    );

    const finishManualReview = async ({
      errorMessage,
      orderId = null,
      jobId = null,
    }) => {
      const updatedCallback = await updateFactoryCallbackProcessingStatus(
        callback.id,
        {
          processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
          errorMessage,
          orderId,
          jobId,
        },
        connection
      );

      await connection.commit();
      transactionStarted = false;
      releaseConnection();
      await logManualReview(updatedCallback, errorMessage, orderId, jobId);

      return {
        httpStatus: 202,
        body: {
          ok: true,
          callbackId: updatedCallback.id,
          processingStatus: updatedCallback.processing_status,
          orderId,
          jobId,
          orderUpdated: false,
          shopifyUpdateTaskCreated: false,
          error: errorMessage,
        },
      };
    };

    if (!job) {
      return await finishManualReview({
        errorMessage: 'nexo_factory_reference_not_found',
      });
    }

    matchedJobId = job.id;

    const order = job.order_id
      ? await findOrderByIdForUpdate(job.order_id, connection)
      : null;
    matchedOrderId = order?.id ?? null;
    const relationshipIssue = getJobOrderRelationshipIssue(
      job,
      order,
      normalized
    );

    if (relationshipIssue) {
      return await finishManualReview({
        errorMessage: relationshipIssue,
        orderId: order?.id ?? null,
        jobId: job.id,
      });
    }

    if (job.status !== JOB_STATUSES.COMPLETED) {
      return await finishManualReview({
        errorMessage: 'job_not_ready_for_nexo_callback',
        orderId: order.id,
        jobId: job.id,
      });
    }

    if (
      job.nexo_job_id &&
      String(job.nexo_job_id) !== normalized.nexoJobId
    ) {
      return await finishManualReview({
        errorMessage: 'nexo_job_id_mismatch',
        orderId: order.id,
        jobId: job.id,
      });
    }

    if (job.nexo_status && !job.nexo_job_id) {
      return await finishManualReview({
        errorMessage: 'nexo_status_without_bound_job_id',
        orderId: order.id,
        jobId: job.id,
      });
    }

    const jobAlreadyBoundToNexoId = await findJobByNexoJobIdForUpdate(
      normalized.nexoJobId,
      connection
    );

    if (
      jobAlreadyBoundToNexoId &&
      String(jobAlreadyBoundToNexoId.id) !== String(job.id)
    ) {
      return await finishManualReview({
        errorMessage: 'nexo_job_id_already_bound_to_another_job',
        orderId: order.id,
        jobId: job.id,
      });
    }

    const sequenceIssue = getNexoStatusSequenceIssue(
      job.nexo_status,
      normalized.status
    );

    if (sequenceIssue) {
      return await finishManualReview({
        errorMessage: sequenceIssue,
        orderId: order.id,
        jobId: job.id,
      });
    }

    const sameSemanticStatus = job.nexo_status === normalized.status;
    const priorSemanticCallback = sameSemanticStatus
      ? await findLatestNexoCallbackByJobAndStatus(
          {
            jobId: job.id,
            nexoJobId: normalized.nexoJobId,
            status: normalized.status,
          },
          connection
        )
      : null;

    if (sameSemanticStatus && !requiresShopifyTask(normalized.status)) {
      const updatedCallback = await updateFactoryCallbackProcessingStatus(
        callback.id,
        {
          processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE,
          orderId: order.id,
          jobId: job.id,
          duplicateOfId: priorSemanticCallback?.id ?? null,
        },
        connection
      );

      await connection.commit();
      transactionStarted = false;

      return {
        httpStatus: 200,
        body: {
          ok: true,
          duplicate: true,
          callbackId: updatedCallback.id,
          duplicateOfId: priorSemanticCallback?.id ?? null,
          processingStatus: updatedCallback.processing_status,
          orderId: order.id,
          jobId: job.id,
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
        jobId: job.id,
      });
    }

    const updatedJob = sameSemanticStatus
      ? job
      : await updateJobNexoState(
          job.id,
          {
            nexoJobId: normalized.nexoJobId,
            nexoStatus: normalized.status,
          },
          connection
        );
    const isFactoryException =
      normalized.status === 'cancelled' || normalized.status === 'error';
    const updatedOrder = orderDecision.update
      ? await updateOrderFactoryState(
          order.id,
          {
            factoryStatus: normalized.status,
            status: targetOrderStatus,
            manualReviewReason: isFactoryException
              ? `nexo_callback_${normalized.status}`
              : undefined,
          },
          connection
        )
      : order;
    const successfulProcessingStatus = isFactoryException
      ? FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW
      : FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED;
    let updatedCallback = await updateFactoryCallbackProcessingStatus(
      callback.id,
      {
        processingStatus: successfulProcessingStatus,
        errorMessage: isFactoryException
          ? `nexo_status_${normalized.status}_requires_manual_review`
          : null,
        orderId: order.id,
        jobId: job.id,
      },
      connection
    );
    const shopifyUpdateTaskResult = await ensureNexoShopifyUpdateTaskDryRun({
      order: updatedOrder,
      job: updatedJob,
      factoryCallback: updatedCallback,
      nexoCallback: normalized,
      db: connection,
    });

    if (requiresShopifyTask(normalized.status) && !shopifyUpdateTaskResult.task) {
      throw new Error('Required NEXO Shopify dry-run task was not created or found');
    }

    const semanticDuplicate = Boolean(
      sameSemanticStatus &&
      requiresShopifyTask(normalized.status) &&
      !shopifyUpdateTaskResult.created
    );

    if (semanticDuplicate) {
      updatedCallback = await updateFactoryCallbackProcessingStatus(
        callback.id,
        {
          processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.DUPLICATE,
          orderId: order.id,
          jobId: job.id,
          duplicateOfId: priorSemanticCallback?.id ?? null,
        },
        connection
      );
    }

    await connection.commit();
    transactionStarted = false;
    releaseConnection();

    await logInfo({
      scopeType: 'order',
      orderId: order.id,
      jobId: job.id,
      step: semanticDuplicate
        ? 'nexo_callback.duplicate'
        : 'nexo_callback.processed',
      message: semanticDuplicate
        ? 'Duplicate NEXO callback safely ignored'
        : 'NEXO callback processed',
      detailsJson: {
        callbackId: updatedCallback.id,
        reference: normalized.reference,
        nexoJobId: normalized.nexoJobId,
        nexoStatus: normalized.status,
        previousNexoStatus: job.nexo_status ?? null,
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
        jobId: job.id,
        reference: normalized.reference,
        nexoJobId: normalized.nexoJobId,
        nexoStatus: normalized.status,
        orderUpdated: orderDecision.update,
        orderStatus: updatedOrder.status,
        shopifyUpdateTaskId: shopifyUpdateTaskResult.task?.id ?? null,
        shopifyUpdateTaskCreated: shopifyUpdateTaskResult.created,
        shopifyUpdateTaskType: shopifyUpdateTaskResult.task?.task_type ?? null,
        shopifyUpdateSuppressed: Boolean(shopifyUpdateTaskResult.task),
      },
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
      transactionStarted = false;
    }

    releaseConnection();

    if (isDuplicateKeyError(error)) {
      const originalDelivery = await findOriginalFactoryCallbackByDeliveryId(
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
        });
      }

      if (String(error.message ?? '').includes('uq_jobs_nexo_job_id')) {
        const callback = await recordRejectedNexoCallback({
          payload,
          headers,
          normalized,
          deliveryIdentity,
          authValid: auth.authValid,
          processingStatus: FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
          errorMessage: 'nexo_job_id_already_bound_to_another_job',
          orderId: matchedOrderId,
          jobId: matchedJobId,
        });

        return {
          httpStatus: 202,
          body: {
            ok: true,
            callbackId: callback.id,
            processingStatus: callback.processing_status,
            orderId: matchedOrderId,
            jobId: matchedJobId,
            orderUpdated: false,
            shopifyUpdateTaskCreated: false,
            error: 'nexo_job_id_already_bound_to_another_job',
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
        jobId: matchedJobId,
      });

      return {
        httpStatus: 202,
        body: {
          ok: true,
          callbackId: callback.id,
          processingStatus: callback.processing_status,
          orderId: matchedOrderId,
          jobId: matchedJobId,
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
  recordNexoTransportFailure,
};
