import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { ShopifyGraphQLClient } from '../src/services/ShopifyGraphQLClient.js';

import { SHOPIFY_UPDATE_TASK_STATUSES } from '../src/constants/statuses.js';
import { buildNexoShopifyTaskIdempotencyKey } from '../src/services/NexoCallbackAdapter.js';
import {
  processClaimedShopifyUpdateTask,
  runShopifyUpdateExecutorOnce,
} from '../src/services/ShopifyUpdateExecutorService.js';
import {
  ensureNexoShopifyUpdateTask,
  SHOPIFY_UPDATE_TASK_TYPES,
} from '../src/services/ShopifyUpdateTaskService.js';

const workerId = 'order-fulfillment-smoke';
const shopifyOrderId = '7248237232408';
const orderId = 41;
const orderFactoryPackageId = 91;
const artifactId = 81;
const reference = `WANDINI-S${shopifyOrderId}`;
const fulfillmentOrderId =
  'gid://shopify/FulfillmentOrder/8197734662424';
const fulfillmentLineIds = [
  'gid://shopify/FulfillmentOrderLineItem/17398957179160',
  'gid://shopify/FulfillmentOrderLineItem/17398957179161',
];
const idempotencyKey = buildNexoShopifyTaskIdempotencyKey({
  orderFactoryPackageId,
  reference,
  taskType: SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED,
});

const liveConfig = {
  SHOPIFY_UPDATE_EXECUTOR_ENABLED: true,
  SHOPIFY_WRITE_ENABLED: true,
  SHOPIFY_WRITE_ALLOW_ALL_ORDERS: false,
  SHOPIFY_WRITE_ORDER_ALLOWLIST: [shopifyOrderId],
  SHOPIFY_WRITE_ORDER_ALLOWLIST_INVALID_ENTRIES: [],
  SHOPIFY_FULFILLMENT_NOTIFY_CUSTOMER: false,
  SHOPIFY_UPDATE_TASK_BATCH_SIZE: 5,
  SHOPIFY_UPDATE_TASK_MAX_ATTEMPTS: 3,
  PROCESSING_STALE_LOCK_MINUTES: 15,
};

function buildTask(overrides = {}) {
  const payload = {
    source: 'nexo_callback',
    taskType: SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED,
    idempotencyKey,
    factoryCallbackId: '17',
    nexoStatus: 'shipped',
    reference,
    factoryReference: reference,
    nexoExternalId: '123456',
    orderFactoryPackageId,
    orderId,
    shopifyOrderId,
    dryRun: false,
    writeSuppressed: false,
    parcel_service: 'UPS',
    trackingNumbers: [
      {
        number: '1ZABC123456789',
        url: 'https://example.test/track/one',
      },
    ],
    ...(overrides.payload_json ?? {}),
  };

  return {
    id: 101,
    order_id: orderId,
    shopify_order_id: shopifyOrderId,
    task_type: SHOPIFY_UPDATE_TASK_TYPES.ORDER_SHIPPED,
    idempotency_key: idempotencyKey,
    source_type: 'nexo_callback',
    source_id: '17',
    status: SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING,
    payload_json: payload,
    dry_run: false,
    attempt_count: 1,
    max_attempts: 3,
    locked_by: workerId,
    locked_at: '2026-09-04 12:00:00',
    ...overrides,
    payload_json: payload,
  };
}

function buildOrderResponse(remainingQuantities = [2, 1]) {
  return {
    id: `gid://shopify/Order/${shopifyOrderId}`,
    fulfillmentOrders: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: fulfillmentOrderId,
          lineItems: {
            pageInfo: { hasNextPage: false },
            nodes: fulfillmentLineIds.map((id, index) => ({
              id,
              remainingQuantity: remainingQuantities[index],
              lineItem: {
                id: `gid://shopify/LineItem/${7000 + index}`,
              },
            })),
          },
        },
      ],
    },
  };
}

function createHarness({
  task = buildTask(),
  orderOverrides = {},
  packageOverrides = {},
  artifactOverrides = {},
  uploadOverrides = {},
  remainingQuantities = [2, 1],
} = {}) {
  const order = {
    id: orderId,
    shopify_order_id: shopifyOrderId,
    status: 'shipped',
    factory_status: 'shipped',
    factory_order_id: '123456',
    ...orderOverrides,
  };
  const orderPackage = {
    id: orderFactoryPackageId,
    order_id: orderId,
    shopify_order_id: shopifyOrderId,
    artifact_id: artifactId,
    order_number: reference,
    status: 'ready',
    factory_status: 'shipped',
    nexo_order_id: '123456',
    ...packageOverrides,
  };
  const artifact = {
    id: artifactId,
    order_id: orderId,
    job_id: null,
    type: 'factory_package',
    status: 'available',
    validation_status: 'passed',
    ...artifactOverrides,
  };
  const uploadTask = {
    id: 71,
    order_id: orderId,
    job_id: null,
    artifact_id: artifactId,
    order_factory_package_id: orderFactoryPackageId,
    shopify_order_id: shopifyOrderId,
    factory_reference: reference,
    status: 'uploaded',
    ...uploadOverrides,
  };
  const finalizations = [];
  const logs = [];
  const graphqlCalls = [];
  let mutationCount = 0;

  const runtime = {
    findOrderById: async () => ({ ...order }),
    findOrderFactoryPackageByOrderId: async () => ({ ...orderPackage }),
    findArtifactById: async () => ({ ...artifact }),
    findFactoryUploadTaskByOrderPackageId: async () => ({ ...uploadTask }),
    findOwnedShopifyUpdateTaskClaim: async () => ({ ...task }),
    finalizeShopifyUpdateTask: async (id, update) => {
      finalizations.push({ id, update });
      return {
        updated: true,
        task: {
          ...task,
          status: update.status,
          result_json: update.resultJson,
          external_id: update.externalId ?? null,
        },
      };
    },
    requeueShopifyUpdateTask: async () => true,
    logInfo: async (entry) => logs.push(entry),
    logWarning: async (entry) => logs.push(entry),
    logError: async (entry) => logs.push(entry),
  };
  const graphqlClient = {
    async request(request) {
      graphqlCalls.push(request);

      if (request.operationName === 'ShopifyOrderFulfillmentPlan') {
        return {
          ok: true,
          data: { order: buildOrderResponse(remainingQuantities) },
          cost: { requestedQueryCost: 10 },
        };
      }

      mutationCount += 1;
      return {
        ok: true,
        data: {
          fulfillmentCreate: {
            fulfillment: {
              id: 'gid://shopify/Fulfillment/555',
              status: 'SUCCESS',
            },
            userErrors: [],
          },
        },
        cost: { requestedQueryCost: 10 },
      };
    },
  };

  return {
    task,
    runtime,
    graphqlClient,
    finalizations,
    logs,
    graphqlCalls,
    mutationCount: () => mutationCount,
  };
}

async function execute(harness, config = liveConfig) {
  return processClaimedShopifyUpdateTask({
    task: harness.task,
    workerId,
    config,
    graphqlClient: harness.graphqlClient,
    runtime: harness.runtime,
  });
}

const taskCreationState = {
  task: null,
  creates: 0,
};
const taskCreationRuntime = {
  findShopifyUpdateTaskByIdempotencyKey: async () =>
    taskCreationState.task,
  createShopifyUpdateTask: async (draft) => {
    taskCreationState.creates += 1;
    taskCreationState.task = {
      id: 201,
      order_id: draft.orderId,
      shopify_order_id: draft.shopifyOrderId,
      task_type: draft.taskType,
      idempotency_key: draft.idempotencyKey,
      source_type: draft.sourceType,
      source_id: draft.sourceId,
      status: draft.status,
      dry_run: draft.dryRun,
      payload_json: draft.payloadJson,
    };
    return taskCreationState.task;
  },
};
const taskCreationInput = {
  order: {
    id: orderId,
    shopify_order_id: shopifyOrderId,
    status: 'shipped',
  },
  orderPackage: {
    id: orderFactoryPackageId,
    order_number: reference,
  },
  factoryCallback: {
    id: 17,
    processing_status: 'processed',
  },
  nexoCallback: {
    status: 'shipped',
    reference,
    nexoJobId: '123456',
    timestamp: '2026-09-04 12:00:00',
    parcelService: 'UPS',
    trackingNumbers: [
      {
        number: '1ZABC123456789',
        url: 'https://example.test/track/one',
      },
    ],
  },
  runtime: taskCreationRuntime,
};

const producedTask = await ensureNexoShopifyUpdateTask({
  ...taskCreationInput,
  nexoCallback: {
    ...taskCreationInput.nexoCallback,
    status: 'printed',
  },
});
assert.equal(producedTask.task, null);
assert.equal(taskCreationState.creates, 0);

const createdTask = await ensureNexoShopifyUpdateTask(taskCreationInput);
const repeatedTask = await ensureNexoShopifyUpdateTask(taskCreationInput);
assert.equal(createdTask.created, true);
assert.equal(createdTask.task.dry_run, false);
assert.equal(createdTask.task.payload_json.writeSuppressed, false);
assert.equal('jobId' in createdTask.task.payload_json, false);
assert.equal(repeatedTask.created, false);
assert.equal(repeatedTask.task.id, createdTask.task.id);
assert.equal(taskCreationState.creates, 1);

const validHarness = createHarness();
const validResult = await execute(validHarness);
assert.equal(validResult.disposition, 'completed');
assert.equal(validHarness.mutationCount(), 1);
assert.equal(validResult.result.orderFactoryPackageId, orderFactoryPackageId);
const fulfillmentInput =
  validHarness.graphqlCalls.find(
    (call) => call.operationName === 'ShopifyFulfillmentCreate'
  ).variables.fulfillment;
assert.deepEqual(
  fulfillmentInput.lineItemsByFulfillmentOrder,
  [
    {
      fulfillmentOrderId,
      fulfillmentOrderLineItems: [
        { id: fulfillmentLineIds[0], quantity: 2 },
        { id: fulfillmentLineIds[1], quantity: 1 },
      ],
    },
  ]
);

for (const harness of [
  createHarness({ packageOverrides: { id: 92 } }),
  createHarness({ orderOverrides: { id: 42 } }),
  createHarness({
    task: buildTask({ payload_json: { orderId: 42 } }),
  }),
]) {
  const result = await execute(harness);
  assert.equal(result.disposition, 'manual_review');
  assert.equal(harness.mutationCount(), 0);
}

const unshippedHarness = createHarness({
  packageOverrides: { factory_status: 'printed' },
});
assert.equal((await execute(unshippedHarness)).disposition, 'manual_review');
assert.equal(unshippedHarness.mutationCount(), 0);

const invalidTrackingHarness = createHarness({
  task: buildTask({ payload_json: { trackingNumbers: [] } }),
});
assert.equal(
  (await execute(invalidTrackingHarness)).disposition,
  'manual_review'
);
assert.equal(invalidTrackingHarness.mutationCount(), 0);

let disabledClaimCalls = 0;
const disabledBatch = await runShopifyUpdateExecutorOnce({
  config: {
    ...liveConfig,
    SHOPIFY_WRITE_ENABLED: false,
  },
  workerId,
  runtime: {
    claimNextPendingShopifyUpdateTask: async () => {
      disabledClaimCalls += 1;
      return null;
    },
  },
});
assert.equal(disabledBatch.claimed, 0);
assert.equal(disabledClaimCalls, 0);

const nonAllowlistedHarness = createHarness();
const nonAllowlisted = await execute(nonAllowlistedHarness, {
  ...liveConfig,
  SHOPIFY_WRITE_ORDER_ALLOWLIST: ['999999'],
});
assert.equal(nonAllowlisted.disposition, 'skipped');
assert.equal(nonAllowlistedHarness.mutationCount(), 0);

const allowAllHarness = createHarness();
const allowAll = await execute(allowAllHarness, {
  ...liveConfig,
  SHOPIFY_WRITE_ALLOW_ALL_ORDERS: true,
  SHOPIFY_WRITE_ORDER_ALLOWLIST: [],
});
assert.equal(allowAll.disposition, 'completed');
assert.equal(allowAllHarness.mutationCount(), 1);

const restartHarness = createHarness();
assert.equal((await execute(restartHarness)).disposition, 'completed');
const alreadyFulfilledHarness = createHarness({
  remainingQuantities: [0, 0],
});
assert.equal(
  (await execute(alreadyFulfilledHarness)).disposition,
  'skipped'
);
assert.equal(restartHarness.mutationCount(), 1);
assert.equal(alreadyFulfilledHarness.mutationCount(), 0);

const legacyProducedHarness = createHarness({
  task: {
    ...buildTask(),
    task_type: SHOPIFY_UPDATE_TASK_TYPES.ORDER_PRODUCED,
  },
});
const legacyProduced = await execute(legacyProducedHarness);
assert.equal(legacyProduced.disposition, 'skipped');
assert.equal(
  legacyProducedHarness.finalizations[0].update.status,
  SHOPIFY_UPDATE_TASK_STATUSES.SKIPPED
);
assert.equal(legacyProducedHarness.mutationCount(), 0);

const concurrentHarness = createHarness();
let sharedClaimed = false;
const concurrentRuntime = {
  ...concurrentHarness.runtime,
  releaseStaleShopifyUpdateTaskClaims: async () => ({
    requeued: 0,
    failed: 0,
  }),
  claimNextPendingShopifyUpdateTask: async () => {
    if (sharedClaimed) {
      return null;
    }

    sharedClaimed = true;
    return concurrentHarness.task;
  },
};
const concurrentRuns = await Promise.all([
  runShopifyUpdateExecutorOnce({
    config: { ...liveConfig, SHOPIFY_UPDATE_TASK_BATCH_SIZE: 1 },
    workerId,
    graphqlClient: concurrentHarness.graphqlClient,
    runtime: concurrentRuntime,
  }),
  runShopifyUpdateExecutorOnce({
    config: { ...liveConfig, SHOPIFY_UPDATE_TASK_BATCH_SIZE: 1 },
    workerId: `${workerId}-two`,
    graphqlClient: concurrentHarness.graphqlClient,
    runtime: concurrentRuntime,
  }),
]);
assert.equal(
  concurrentRuns.reduce((sum, run) => sum + run.claimed, 0),
  1
);
assert.equal(concurrentHarness.mutationCount(), 1);

const executorModelSource = await fs.readFile(
  new URL('../src/models/ShopifyUpdateTaskModel.js', import.meta.url),
  'utf8'
);
const idempotencyMigration = await fs.readFile(
  new URL(
    '../src/db/migrations/003_phase2_safety_foundation.sql',
    import.meta.url
  ),
  'utf8'
);
assert.match(executorModelSource, /FOR UPDATE SKIP LOCKED/);
assert.match(
  idempotencyMigration,
  /uq_shopify_update_tasks_idempotency_key/
);

// Exercise HTTP-200 GraphQL throttling through the real client normalizer;
// fetch and authentication are entirely local stubs.
const throttleClient = new ShopifyGraphQLClient({
  config: { SHOPIFY_ADMIN_API_VERSION: '2026-01', SHOPIFY_SHOP_DOMAIN: 'local-test.myshopify.com' },
  authClient: { getAccessToken: async () => 'local-stub-token' },
  fetchImpl: async () => ({
    ok: true, status: 200,
    json: async () => ({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
  }),
});
async function executeFailureThroughWorker(harness) {
  return runShopifyUpdateExecutorOnce({
    config: { ...liveConfig, SHOPIFY_UPDATE_TASK_BATCH_SIZE: 1 }, workerId,
    graphqlClient: harness.graphqlClient,
    runtime: {
      ...harness.runtime,
      releaseStaleShopifyUpdateTaskClaims: async () => ({ requeued: 0, failed: 0 }),
      claimNextPendingShopifyUpdateTask: async () => harness.task,
    },
  });
}
const throttledResult = await throttleClient.request({ query: 'query { shop { id } }' });
assert.equal(throttledResult.errors[0].code, 'THROTTLED');
for (const [failure, retryable] of [
  [throttledResult, true],
  [{ errorType: 'graphql', httpStatus: 200, errors: [{ code: 'GRAPHQL_VALIDATION_FAILED' }] }, false],
  [{ errorType: 'user_errors', httpStatus: 200, errors: [], userErrors: [{ code: 'THROTTLED' }] }, false],
  [{ errorType: 'network' }, true],
  [{ errorType: 'authentication' }, true],
  [{ errorType: 'http', httpStatus: 429 }, true],
  [{ errorType: 'http', httpStatus: 503 }, true],
]) {
  const harness = createHarness();
  harness.graphqlClient.request = async () => ({ ok: false, ...failure });
  await assert.rejects(execute(harness), (error) => error.retryable === retryable);
  const result = await executeFailureThroughWorker(harness);
  assert.equal(result.results[0].disposition, retryable ? 'retry_pending' : 'failed');
}
const exhaustedThrottle = createHarness();
exhaustedThrottle.task.attempt_count = exhaustedThrottle.task.max_attempts;
exhaustedThrottle.graphqlClient.request = async () => throttledResult;
assert.equal((await executeFailureThroughWorker(exhaustedThrottle)).results[0].disposition, 'failed');

console.log('Shopify whole-order execution smoke ok');
