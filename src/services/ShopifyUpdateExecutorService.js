import env from '../config/env.js';
import { normalizeShopifyNumericId } from '../config/shopifyAdmin.js';
import { SHOPIFY_UPDATE_TASK_STATUSES } from '../constants/statuses.js';
import { findArtifactById } from '../models/ArtifactModel.js';
import { findFactoryUploadTaskByOrderPackageId } from '../models/FactoryUploadTaskModel.js';
import { findOrderFactoryPackageByOrderId } from '../models/OrderFactoryPackageModel.js';
import { findOrderById } from '../models/OrderModel.js';
import {
  claimNextPendingShopifyUpdateTask,
  finalizeShopifyUpdateTask,
  findOwnedShopifyUpdateTaskClaim,
  releaseStaleShopifyUpdateTaskClaims,
  requeueShopifyUpdateTask,
} from '../models/ShopifyUpdateTaskModel.js';
import { redact } from '../utils/redact.js';
import { logError, logInfo, logWarning } from './LogService.js';
import {
  buildShopifyOrderFulfillmentPlan,
  buildShopifyOrderGid,
} from './ShopifyFulfillmentPlanner.js';
import ShopifyGraphQLClient from './ShopifyGraphQLClient.js';
import {
  SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS,
  evaluateShopifyExternalWriteGates,
} from './ShopifyUpdateExecutorSafety.js';
import { SHOPIFY_UPDATE_TASK_TYPES } from './ShopifyUpdateTaskService.js';
import { buildNexoShopifyTaskIdempotencyKey } from './NexoCallbackAdapter.js';

export const SHOPIFY_ORDER_FULFILLMENT_QUERY = `
  query ShopifyOrderFulfillmentPlan($orderId: ID!) {
    order(id: $orderId) {
      id
      fulfillmentOrders(first: 50) {
        pageInfo {
          hasNextPage
        }
        nodes {
          id
          status
          lineItems(first: 100) {
            pageInfo {
              hasNextPage
            }
            nodes {
              id
              remainingQuantity
              lineItem {
                id
              }
            }
          }
        }
      }
    }
  }
`;

export const SHOPIFY_FULFILLMENT_CREATE_MUTATION = `
  mutation ShopifyFulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

class ShopifyUpdateExecutorError extends Error {
  constructor(code, { retryable = false, result = null } = {}) {
    super(code);
    this.name = 'ShopifyUpdateExecutorError';
    this.code = code;
    this.retryable = retryable;
    this.result = result;
  }
}

function executorRuntime(overrides = {}) {
  return {
    claimNextPendingShopifyUpdateTask,
    finalizeShopifyUpdateTask,
    findArtifactById,
    findFactoryUploadTaskByOrderPackageId,
    findOrderById,
    findOrderFactoryPackageByOrderId,
    findOwnedShopifyUpdateTaskClaim,
    releaseStaleShopifyUpdateTaskClaims,
    requeueShopifyUpdateTask,
    logError,
    logInfo,
    logWarning,
    ...overrides,
  };
}

function payloadObject(task) {
  const payload = task?.payload_json;

  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : null;
}

function scalar(value) {
  if (
    value === undefined ||
    value === null ||
    !['string', 'number', 'bigint'].includes(typeof value)
  ) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function getPayloadValue(payload, camelCaseName, snakeCaseName) {
  return payload[camelCaseName] ?? payload[snakeCaseName] ?? null;
}

function taskIdentityIssue(task, payload, context = {}) {
  const { order, orderPackage, artifact, factoryUploadTask } = context;
  const taskOrderId = scalar(task.order_id);
  const taskShopifyOrderId = normalizeShopifyNumericId(task.shopify_order_id);
  const payloadOrderId = scalar(getPayloadValue(payload, 'orderId', 'order_id'));
  const payloadShopifyOrderId = normalizeShopifyNumericId(
    getPayloadValue(payload, 'shopifyOrderId', 'shopify_order_id')
  );
  const payloadPackageId = scalar(
    getPayloadValue(
      payload,
      'orderFactoryPackageId',
      'order_factory_package_id'
    )
  );
  const payloadTaskType = scalar(
    getPayloadValue(payload, 'taskType', 'task_type')
  );

  if (!taskOrderId || !taskShopifyOrderId || !payloadPackageId) {
    return 'shopify_update_task_identity_missing';
  }

  if (!payloadTaskType || payloadTaskType !== task.task_type) {
    return 'shopify_update_task_type_mismatch';
  }

  if (!payloadOrderId || payloadOrderId !== taskOrderId) {
    return 'shopify_update_task_order_id_mismatch';
  }

  if (!payloadShopifyOrderId || payloadShopifyOrderId !== taskShopifyOrderId) {
    return 'shopify_update_task_shopify_order_id_mismatch';
  }

  if (
    task.job_id !== undefined &&
    task.job_id !== null
  ) {
    return 'shopify_update_task_legacy_job_ownership_not_allowed';
  }

  if (getPayloadValue(payload, 'jobId', 'job_id') !== null) {
    return 'shopify_update_task_legacy_job_ownership_not_allowed';
  }

  if (
    !order ||
    String(order.id) !== taskOrderId ||
    normalizeShopifyNumericId(order.shopify_order_id) !== taskShopifyOrderId
  ) {
    return 'shopify_update_task_order_not_found_or_mismatched';
  }

  if (
    !orderPackage ||
    String(orderPackage.id) !== payloadPackageId ||
    String(orderPackage.order_id) !== taskOrderId ||
    normalizeShopifyNumericId(orderPackage.shopify_order_id) !==
      taskShopifyOrderId
  ) {
    return 'shopify_update_task_order_package_mismatch';
  }

  if (
    !artifact ||
    String(artifact.id) !== String(orderPackage.artifact_id) ||
    String(artifact.order_id) !== taskOrderId ||
    artifact.job_id !== null ||
    artifact.type !== 'factory_package' ||
    artifact.status !== 'available' ||
    artifact.validation_status !== 'passed'
  ) {
    return 'shopify_update_task_package_artifact_invalid';
  }

  if (
    !factoryUploadTask ||
    factoryUploadTask.status !== 'uploaded' ||
    String(factoryUploadTask.order_id) !== taskOrderId ||
    String(factoryUploadTask.artifact_id) !== String(artifact.id) ||
    String(factoryUploadTask.order_factory_package_id) !==
      String(orderPackage.id) ||
    normalizeShopifyNumericId(factoryUploadTask.shopify_order_id) !==
      taskShopifyOrderId ||
    factoryUploadTask.factory_reference !== orderPackage.order_number ||
    factoryUploadTask.job_id !== null
  ) {
    return 'shopify_update_task_package_not_validly_dispatched';
  }

  if (
    task.source_type !== 'nexo_callback' ||
    payload.source !== 'nexo_callback' ||
    payload.nexoStatus !== 'shipped' ||
    order.status !== 'shipped' ||
    order.factory_status !== 'shipped' ||
    orderPackage.status !== 'ready' ||
    orderPackage.factory_status !== 'shipped'
  ) {
    return 'shopify_update_task_package_not_shipped';
  }

  const nexoExternalId = scalar(payload.nexoExternalId);

  if (
    !nexoExternalId ||
    String(order.factory_order_id ?? '') !== nexoExternalId ||
    String(orderPackage.nexo_order_id ?? '') !== nexoExternalId ||
    payload.reference !== orderPackage.order_number ||
    payload.factoryReference !== orderPackage.order_number
  ) {
    return 'shopify_update_task_factory_identity_mismatch';
  }

  const expectedIdempotencyKey = buildNexoShopifyTaskIdempotencyKey({
    orderFactoryPackageId: orderPackage.id,
    reference: orderPackage.order_number,
    taskType: SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED,
  });

  if (
    !expectedIdempotencyKey ||
    task.idempotency_key !== expectedIdempotencyKey ||
    payload.idempotencyKey !== expectedIdempotencyKey
  ) {
    return 'shopify_update_task_idempotency_identity_mismatch';
  }

  return null;
}

async function loadOrderLevelTaskContext(task, runtime) {
  const order = await runtime.findOrderById(task.order_id);
  const orderPackage = order
    ? await runtime.findOrderFactoryPackageByOrderId(order.id)
    : null;
  const artifact = orderPackage
    ? await runtime.findArtifactById(orderPackage.artifact_id)
    : null;
  const factoryUploadTask = orderPackage
    ? await runtime.findFactoryUploadTaskByOrderPackageId(orderPackage.id)
    : null;

  return { order, orderPackage, artifact, factoryUploadTask };
}

function baseResult(task) {
  const payload = payloadObject(task);

  return {
    taskId: task.id,
    taskType: task.task_type,
    orderId: task.order_id,
    shopifyOrderId: task.shopify_order_id,
    orderFactoryPackageId: payload
      ? getPayloadValue(
          payload,
          'orderFactoryPackageId',
          'order_factory_package_id'
        )
      : null,
    attemptCount: task.attempt_count,
    matchedFulfillmentOrderCount: 0,
    matchedLineItemCount: 0,
    trackingNumberCount: 0,
    externalWritePerformed: false,
  };
}

function plannedInputSummary(fulfillmentInput) {
  const groups = fulfillmentInput?.lineItemsByFulfillmentOrder ?? [];
  const lineItems = groups.flatMap(
    (group) => group.fulfillmentOrderLineItems ?? []
  );

  return {
    fulfillmentOrderCount: groups.length,
    fulfillmentOrderLineItemCount: lineItems.length,
    totalQuantity: lineItems.reduce(
      (sum, item) => sum + Number(item.quantity ?? 0),
      0
    ),
    notifyCustomer: Boolean(fulfillmentInput?.notifyCustomer),
    trackingNumberCount:
      fulfillmentInput?.trackingInfo?.numbers?.length ?? 0,
    trackingUrlCount: fulfillmentInput?.trackingInfo?.urls?.length ?? 0,
    hasTrackingCompany: Boolean(fulfillmentInput?.trackingInfo?.company),
    fulfillmentOrderIds: groups.map((group) => group.fulfillmentOrderId),
    fulfillmentOrderLineItemIds: lineItems.map((item) => item.id),
  };
}

function safeGraphqlResultSummary(result) {
  return {
    errorType: result?.errorType ?? null,
    httpStatus: result?.httpStatus ?? null,
    graphqlErrorCount: result?.errors?.length ?? 0,
    userErrorCount: result?.userErrors?.length ?? 0,
    cost: result?.cost ?? null,
  };
}

function effectiveMaxAttempts(task, config) {
  const taskMax = Number(task?.max_attempts);
  const configMax = Number(config.SHOPIFY_UPDATE_TASK_MAX_ATTEMPTS);
  const normalizedTaskMax =
    Number.isSafeInteger(taskMax) && taskMax > 0 ? taskMax : 3;
  const normalizedConfigMax =
    Number.isSafeInteger(configMax) && configMax > 0 ? configMax : 3;

  return Math.min(normalizedTaskMax, normalizedConfigMax);
}

async function finalizeOwnedTask({
  task,
  workerId,
  status,
  result,
  lastError = null,
  externalId = null,
  runtime,
}) {
  const finalization = await runtime.finalizeShopifyUpdateTask(task.id, {
    status,
    resultJson: redact(result),
    lastError,
    externalId,
    workerId,
  });

  if (!finalization.updated) {
    throw new ShopifyUpdateExecutorError(
      'shopify_update_task_claim_lost_before_finalization'
    );
  }

  return finalization.task;
}

async function finalizeManualReview(
  task,
  workerId,
  errorCode,
  details = {},
  runtime
) {
  const result = {
    ...baseResult(task),
    ...details,
    plannedAction: null,
    writeSuppressed: true,
    writeSuppressedReason: errorCode,
    error: errorCode,
  };
  const finalTask = await finalizeOwnedTask({
    task,
    workerId,
    status: SHOPIFY_UPDATE_TASK_STATUSES.MANUAL_REVIEW,
    result,
    lastError: errorCode,
    runtime,
  });

  await runtime.logWarning({
    scopeType: task.order_id ? 'order' : 'system',
    orderId: task.order_id,
    step: 'shopify_update_executor.manual_review',
    message: 'Shopify update task requires manual review',
    detailsJson: {
      taskId: task.id,
      taskType: task.task_type,
      orderFactoryPackageId: baseResult(task).orderFactoryPackageId,
      attemptCount: task.attempt_count,
      error: errorCode,
    },
  });

  return {
    task: finalTask,
    disposition: 'manual_review',
    result,
  };
}

async function processOrderProduced(task, workerId, runtime) {
  const result = {
    ...baseResult(task),
    plannedAction: null,
    writeSuppressed: true,
    writeSuppressedReason: 'order_produced_mutation_not_implemented',
    notifyCustomer: false,
  };
  const finalTask = await finalizeOwnedTask({
    task,
    workerId,
    status: SHOPIFY_UPDATE_TASK_STATUSES.SKIPPED,
    result,
    lastError: 'order_produced_mutation_not_implemented',
    runtime,
  });

  return {
    task: finalTask,
    disposition: 'skipped',
    result,
  };
}

function graphqlFailure(code, result, { retryable = false } = {}) {
  return new ShopifyUpdateExecutorError(code, {
    retryable,
    result: safeGraphqlResultSummary(result),
  });
}

function isRetryableGraphqlFailure(result) {
  return (
    result?.errorType === 'network' ||
    result?.errorType === 'authentication' ||
    result?.httpStatus === 429 ||
    Number(result?.httpStatus) >= 500
  );
}

async function processOrderShipped({
  task,
  workerId,
  config,
  graphqlClient,
  runtime,
}) {
  const payload = payloadObject(task);

  if (!payload) {
    return finalizeManualReview(
      task,
      workerId,
      'shopify_update_task_payload_invalid',
      {},
      runtime
    );
  }

  const context = await loadOrderLevelTaskContext(task, runtime);
  const identityIssue = taskIdentityIssue(task, payload, context);

  if (identityIssue) {
    return finalizeManualReview(task, workerId, identityIssue, {}, runtime);
  }

  const orderGid = buildShopifyOrderGid(task.shopify_order_id);
  const orderResult = await graphqlClient.request({
    query: SHOPIFY_ORDER_FULFILLMENT_QUERY,
    variables: { orderId: orderGid },
    operationName: 'ShopifyOrderFulfillmentPlan',
  });

  if (!orderResult.ok) {
    throw graphqlFailure('shopify_fulfillment_order_query_failed', orderResult, {
      retryable: isRetryableGraphqlFailure(orderResult),
    });
  }

  const plan = buildShopifyOrderFulfillmentPlan({
    order: orderResult.data?.order,
    shopifyOrderId: task.shopify_order_id,
    taskPayload: payload,
    notifyCustomer: config.SHOPIFY_FULFILLMENT_NOTIFY_CUSTOMER,
  });
  const planResult = {
    ...baseResult(task),
    matchedFulfillmentOrderCount: plan.matchedFulfillmentOrderCount,
    matchedLineItemCount: plan.matchedLineItemCount,
    trackingNumberCount: plan.trackingNumberCount,
    graphqlCost: orderResult.cost,
  };

  if (!plan.ok) {
    return finalizeManualReview(
      task,
      workerId,
      plan.error,
      planResult,
      runtime
    );
  }

  if (plan.disposition === 'skipped') {
    const result = {
      ...planResult,
      plannedAction: 'fulfillmentCreate',
      writeSuppressed: true,
      writeSuppressedReason: plan.reason,
      alreadyFulfilled: true,
    };
    const finalTask = await finalizeOwnedTask({
      task,
      workerId,
      status: SHOPIFY_UPDATE_TASK_STATUSES.SKIPPED,
      result,
      runtime,
    });

    return {
      task: finalTask,
      disposition: 'skipped',
      result,
    };
  }

  const ownedTask = await runtime.findOwnedShopifyUpdateTaskClaim(
    task.id,
    workerId
  );

  if (!ownedTask) {
    throw new ShopifyUpdateExecutorError(
      'shopify_update_task_claim_lost_before_write_gate'
    );
  }

  const ownedPayload = payloadObject(ownedTask);

  if (!ownedPayload) {
    return finalizeManualReview(
      ownedTask,
      workerId,
      'shopify_update_task_payload_invalid',
      {},
      runtime
    );
  }

  const refreshedContext = await loadOrderLevelTaskContext(
    ownedTask,
    runtime
  );
  const refreshedIdentityIssue = taskIdentityIssue(
    ownedTask,
    ownedPayload,
    refreshedContext
  );

  if (refreshedIdentityIssue) {
    return finalizeManualReview(
      ownedTask,
      workerId,
      refreshedIdentityIssue,
      {},
      runtime
    );
  }

  const refreshedPlan = buildShopifyOrderFulfillmentPlan({
    order: orderResult.data?.order,
    shopifyOrderId: ownedTask.shopify_order_id,
    taskPayload: ownedPayload,
    notifyCustomer: config.SHOPIFY_FULFILLMENT_NOTIFY_CUSTOMER,
  });

  if (!refreshedPlan.ok || refreshedPlan.disposition !== 'ready') {
    return finalizeManualReview(
      ownedTask,
      workerId,
      refreshedPlan.error ?? 'shopify_fulfillment_plan_changed_before_write',
      {},
      runtime
    );
  }

  const gate = evaluateShopifyExternalWriteGates({
    config,
    task: ownedTask,
    payload: ownedPayload,
    workerId,
    fulfillmentInput: refreshedPlan.fulfillmentInput,
  });
  const allowlistBlockReason = gate.reasons.find((reason) =>
    [
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.ALLOWLIST_INVALID,
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.ORDER_NOT_ALLOWLISTED,
    ].includes(reason)
  );
  const result = {
    ...planResult,
    plannedAction: 'fulfillmentCreate',
    plannedMutation: plannedInputSummary(refreshedPlan.fulfillmentInput),
    writeSuppressed: !gate.allowed,
    writeSuppressedReason: gate.primaryReason,
    externalWriteBlockedReason:
      config.SHOPIFY_WRITE_ENABLED && allowlistBlockReason
        ? allowlistBlockReason
        : gate.primaryReason,
    writeGateReasons: gate.reasons,
  };

  if (!gate.allowed) {
    const allowlistReasons = new Set([
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.ALLOWLIST_INVALID,
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.ORDER_NOT_ALLOWLISTED,
    ]);
    const plannedSuppressionReasons = new Set([
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.WRITE_DISABLED,
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.TASK_DRY_RUN,
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.PAYLOAD_DRY_RUN,
      SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.PAYLOAD_WRITE_SUPPRESSED,
    ]);
    const unsafeGateReasons = gate.reasons.filter(
      (reason) =>
        !allowlistReasons.has(reason) &&
        !plannedSuppressionReasons.has(reason)
    );

    if (unsafeGateReasons.length > 0) {
      return finalizeManualReview(
        ownedTask,
        workerId,
        unsafeGateReasons[0],
        result,
        runtime
      );
    }

    const allowlistOnlyBlock =
      gate.reasons.some((reason) => allowlistReasons.has(reason)) &&
      gate.reasons.every((reason) => allowlistReasons.has(reason));
    const status = allowlistOnlyBlock
      ? SHOPIFY_UPDATE_TASK_STATUSES.SKIPPED
      : SHOPIFY_UPDATE_TASK_STATUSES.COMPLETED;
    const finalTask = await finalizeOwnedTask({
      task: ownedTask,
      workerId,
      status,
      result,
      lastError: allowlistOnlyBlock ? gate.primaryReason : null,
      runtime,
    });

    return {
      task: finalTask,
      disposition: allowlistOnlyBlock ? 'skipped' : 'planned',
      result,
    };
  }

  const mutationResult = await graphqlClient.request({
    query: SHOPIFY_FULFILLMENT_CREATE_MUTATION,
    variables: { fulfillment: refreshedPlan.fulfillmentInput },
    operationName: 'ShopifyFulfillmentCreate',
  });

  if (!mutationResult.ok) {
    if (mutationResult.errorType === 'user_errors') {
      return finalizeManualReview(
        ownedTask,
        workerId,
        'shopify_fulfillment_create_user_error',
        {
          ...result,
          mutationResult: safeGraphqlResultSummary(mutationResult),
        },
        runtime
      );
    }

    throw graphqlFailure(
      'shopify_fulfillment_create_failed',
      mutationResult,
      { retryable: isRetryableGraphqlFailure(mutationResult) }
    );
  }

  const fulfillment = mutationResult.data?.fulfillmentCreate?.fulfillment;

  if (typeof fulfillment?.id !== 'string' || !fulfillment.id) {
    return finalizeManualReview(
      ownedTask,
      workerId,
      'shopify_fulfillment_create_result_missing_id',
      {
        ...result,
        mutationResult: safeGraphqlResultSummary(mutationResult),
      },
      runtime
    );
  }

  const completedResult = {
    ...result,
    writeSuppressed: false,
    writeSuppressedReason: null,
    externalWriteBlockedReason: null,
    writeGateReasons: [],
    externalWritePerformed: true,
    fulfillmentStatus: fulfillment.status ?? null,
    mutationCost: mutationResult.cost,
  };
  const finalTask = await finalizeOwnedTask({
    task: ownedTask,
    workerId,
    status: SHOPIFY_UPDATE_TASK_STATUSES.COMPLETED,
    result: completedResult,
    externalId: fulfillment.id,
    runtime,
  });

  return {
    task: finalTask,
    disposition: 'completed',
    result: completedResult,
  };
}

export async function processClaimedShopifyUpdateTask({
  task,
  workerId,
  config = env,
  graphqlClient,
  runtime: runtimeOverrides = {},
}) {
  const runtime = executorRuntime(runtimeOverrides);
  if (
    !task ||
    task.status !== SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING ||
    task.locked_by !== workerId
  ) {
    throw new ShopifyUpdateExecutorError(
      'shopify_update_task_not_owned_by_executor'
    );
  }

  if (task.task_type === SHOPIFY_UPDATE_TASK_TYPES.ORDER_PRODUCED) {
    return processOrderProduced(task, workerId, runtime);
  }

  if (task.task_type === SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED) {
    return processOrderShipped({
      task,
      workerId,
      config,
      graphqlClient,
      runtime,
    });
  }

  return finalizeManualReview(
    task,
    workerId,
    'shopify_update_task_type_not_supported',
    {},
    runtime
  );
}

async function handleClaimedTaskFailure({
  task,
  workerId,
  config,
  error,
  runtime,
}) {
  const code =
    typeof error?.code === 'string'
      ? error.code
      : 'shopify_update_executor_unexpected_failure';
  const retryable = error?.retryable === true;
  const canRetry =
    retryable && task.attempt_count < effectiveMaxAttempts(task, config);
  const result = {
    ...baseResult(task),
    plannedAction: null,
    writeSuppressed: true,
    writeSuppressedReason: code,
    error: code,
    retryable,
    failure: redact(error?.result ?? null),
  };

  if (canRetry) {
    const requeued = await runtime.requeueShopifyUpdateTask(task.id, {
      resultJson: redact(result),
      lastError: code,
      workerId,
    });

    if (!requeued) {
      throw new ShopifyUpdateExecutorError(
        'shopify_update_task_claim_lost_before_retry'
      );
    }

    return {
      disposition: 'retry_pending',
      result,
    };
  }

  const finalTask = await finalizeOwnedTask({
    task,
    workerId,
    status: SHOPIFY_UPDATE_TASK_STATUSES.FAILED,
    result,
    lastError: code,
    runtime,
  });

  await runtime.logError({
    scopeType: task.order_id ? 'order' : 'system',
    orderId: task.order_id,
    step: 'shopify_update_executor.failed',
    message: 'Shopify update task executor failed safely',
    detailsJson: {
      taskId: task.id,
      taskType: task.task_type,
      orderFactoryPackageId: baseResult(task).orderFactoryPackageId,
      attemptCount: task.attempt_count,
      error: code,
      retryable,
    },
  });

  return {
    task: finalTask,
    disposition: 'failed',
    result,
  };
}

export async function runShopifyUpdateExecutorOnce({
  config = env,
  workerId,
  graphqlClient = null,
  runtime: runtimeOverrides = {},
} = {}) {
  if (
    config.SHOPIFY_UPDATE_EXECUTOR_ENABLED !== true ||
    config.SHOPIFY_WRITE_ENABLED !== true
  ) {
    return {
      enabled: config.SHOPIFY_UPDATE_EXECUTOR_ENABLED === true,
      writeEnabled: config.SHOPIFY_WRITE_ENABLED === true,
      claimed: 0,
      processed: 0,
      results: [],
    };
  }

  const runtime = executorRuntime(runtimeOverrides);
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 191);

  if (!normalizedWorkerId) {
    throw new Error('Shopify update executor worker ID is required');
  }

  const parsedBatchSize = Number(config.SHOPIFY_UPDATE_TASK_BATCH_SIZE);
  const batchSize =
    Number.isSafeInteger(parsedBatchSize) && parsedBatchSize > 0
      ? Math.min(parsedBatchSize, 100)
      : 5;
  const parsedMaxAttempts = Number(config.SHOPIFY_UPDATE_TASK_MAX_ATTEMPTS);
  const maxAttempts =
    Number.isSafeInteger(parsedMaxAttempts) && parsedMaxAttempts > 0
      ? parsedMaxAttempts
      : 3;
  const client = graphqlClient ?? new ShopifyGraphQLClient({ config });
  const staleClaims = await runtime.releaseStaleShopifyUpdateTaskClaims({
    staleLockMinutes: config.PROCESSING_STALE_LOCK_MINUTES,
    maxAttempts,
  });
  const results = [];
  const claimedTaskIds = [];
  let claimed = 0;

  for (let index = 0; index < batchSize; index += 1) {
    const task = await runtime.claimNextPendingShopifyUpdateTask({
      workerId: normalizedWorkerId,
      maxAttempts,
      excludeIds: claimedTaskIds,
    });

    if (!task) {
      break;
    }

    claimed += 1;
    claimedTaskIds.push(task.id);

    try {
      const outcome = await processClaimedShopifyUpdateTask({
        task,
        workerId: normalizedWorkerId,
        config,
        graphqlClient: client,
        runtime,
      });

      results.push({
        taskId: task.id,
        disposition: outcome.disposition,
      });

      await runtime.logInfo({
        scopeType: task.order_id ? 'order' : 'system',
        orderId: task.order_id,
        step: 'shopify_update_executor.processed',
        message: 'Shopify update task executor processed a claimed task',
        detailsJson: {
          taskId: task.id,
          taskType: task.task_type,
          orderFactoryPackageId:
            outcome.result?.orderFactoryPackageId ?? null,
          attemptCount: task.attempt_count,
          disposition: outcome.disposition,
          externalWritePerformed:
            outcome.result?.externalWritePerformed === true,
        },
      });
    } catch (error) {
      const outcome = await handleClaimedTaskFailure({
        task,
        workerId: normalizedWorkerId,
        config,
        error,
        runtime,
      });

      results.push({
        taskId: task.id,
        disposition: outcome.disposition,
      });
    }
  }

  return {
    enabled: true,
    writeEnabled: true,
    claimed,
    processed: results.length,
    staleClaims,
    results,
  };
}

export default {
  SHOPIFY_FULFILLMENT_CREATE_MUTATION,
  SHOPIFY_ORDER_FULFILLMENT_QUERY,
  processClaimedShopifyUpdateTask,
  runShopifyUpdateExecutorOnce,
};
