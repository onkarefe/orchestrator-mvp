import assert from 'node:assert/strict';

import {
  buildShopifyAdminUrl,
  isShopifyOrderAllowlisted,
  normalizeShopifyAdminApiVersion,
  normalizeShopifyShopDomain,
  parseShopifyWriteOrderAllowlist,
} from '../src/config/shopifyAdmin.js';
import {
  getSafeStartupConfigSummary,
  validateServerStartupEnv,
} from '../src/config/startupValidation.js';
import { SHOPIFY_UPDATE_TASK_STATUSES } from '../src/constants/statuses.js';
import {
  buildShopifyFulfillmentPlan,
  buildShopifyOrderFulfillmentPlan,
  buildShopifyOrderGid,
} from '../src/services/ShopifyFulfillmentPlanner.js';
import {
  SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS,
  evaluateShopifyExternalWriteGates,
} from '../src/services/ShopifyUpdateExecutorSafety.js';
import { REDACTED_VALUE, redact } from '../src/utils/redact.js';

const parsedAllowlist = parseShopifyWriteOrderAllowlist(
  '7248237232408, 7248237232408,invalid,0'
);

assert.deepEqual(parsedAllowlist.orderIds, ['7248237232408']);
assert.deepEqual(parsedAllowlist.invalidEntries, ['invalid', '0']);
assert.equal(
  isShopifyOrderAllowlisted('7248237232408', parsedAllowlist.orderIds),
  true
);
assert.equal(normalizeShopifyShopDomain('shop.myshopify.com'), 'shop.myshopify.com');
assert.equal(normalizeShopifyShopDomain('https://shop.myshopify.com'), null);
assert.equal(normalizeShopifyAdminApiVersion('2026-01'), '2026-01');
assert.equal(normalizeShopifyAdminApiVersion('latest'), null);
assert.equal(
  buildShopifyAdminUrl({
    shopDomain: 'shop.myshopify.com',
    path: '/admin/oauth/access_token',
  }),
  'https://shop.myshopify.com/admin/oauth/access_token'
);

const startupBase = {
  WALLPAPER_SKUS: ['20-140.1-3'],
  SHOPIFY_WEBHOOK_HMAC_REQUIRED: false,
  SHOPIFY_SHOP_DOMAIN: 'shop.myshopify.com',
  FACTORY_CALLBACK_ENABLED: false,
  NEXO_CALLBACK_ENABLED: false,
  SHOPIFY_UPDATE_EXECUTOR_ENABLED: false,
  SHOPIFY_WRITE_ENABLED: false,
  SHOPIFY_WRITE_ALLOW_ALL_ORDERS: false,
  SHOPIFY_WRITE_ORDER_ALLOWLIST: [],
  SHOPIFY_WRITE_ORDER_ALLOWLIST_INVALID_ENTRIES: [],
};

assert.equal(validateServerStartupEnv(startupBase), true);
assert.throws(
  () =>
    validateServerStartupEnv({
      ...startupBase,
      SHOPIFY_SHOP_DOMAIN: '',
    }),
  /SHOPIFY_SHOP_DOMAIN/
);
assert.throws(
  () =>
    validateServerStartupEnv({
      ...startupBase,
      SHOPIFY_UPDATE_EXECUTOR_ENABLED: true,
      SHOPIFY_SHOP_DOMAIN: '',
      SHOPIFY_ADMIN_API_VERSION: '2026-01',
    }),
  /SHOPIFY_SHOP_DOMAIN/
);
assert.throws(
  () =>
    validateServerStartupEnv({
      ...startupBase,
      SHOPIFY_WRITE_ENABLED: true,
    }),
  /SHOPIFY_WRITE_ORDER_ALLOWLIST/
);
assert.throws(
  () =>
    validateServerStartupEnv({
      ...startupBase,
      SHOPIFY_WRITE_ENABLED: true,
      SHOPIFY_WRITE_ORDER_ALLOWLIST: ['7248237232408'],
    }),
  /SHOPIFY_UPDATE_EXECUTOR_ENABLED/
);
const enabledConfig = {
  ...startupBase,
  SHOPIFY_UPDATE_EXECUTOR_ENABLED: true,
  SHOPIFY_SHOP_DOMAIN: 'shop.myshopify.com',
  SHOPIFY_ADMIN_API_VERSION: '2026-01',
  SHOPIFY_CLIENT_ID: 'configured-client-id',
  SHOPIFY_CLIENT_SECRET: 'configured-client-secret',
  SHOPIFY_UPDATE_TASK_BATCH_SIZE: 5,
  SHOPIFY_UPDATE_TASK_MAX_ATTEMPTS: 3,
};

assert.equal(validateServerStartupEnv(enabledConfig), true);
assert.equal(
  validateServerStartupEnv({
    ...enabledConfig,
    SHOPIFY_WRITE_ENABLED: true,
    SHOPIFY_WRITE_ORDER_ALLOWLIST: ['7248237232408'],
  }),
  true
);
assert.throws(
  () =>
    validateServerStartupEnv({
      ...enabledConfig,
      SHOPIFY_WRITE_ENABLED: true,
      SHOPIFY_WRITE_ALLOW_ALL_ORDERS: 'true',
      SHOPIFY_WRITE_ORDER_ALLOWLIST: [],
    }),
  /SHOPIFY_WRITE_ORDER_ALLOWLIST/
);
assert.throws(
  () =>
    validateServerStartupEnv({
      ...enabledConfig,
      SHOPIFY_WRITE_ENABLED: true,
      SHOPIFY_WRITE_ALLOW_ALL_ORDERS: true,
      SHOPIFY_WRITE_ORDER_ALLOWLIST: ['7248237232408'],
    }),
  /mutually exclusive/
);
assert.equal(
  validateServerStartupEnv({
    ...enabledConfig,
    SHOPIFY_WRITE_ENABLED: true,
    SHOPIFY_WRITE_ALLOW_ALL_ORDERS: true,
    SHOPIFY_WRITE_ORDER_ALLOWLIST: [],
  }),
  true
);
const safeSummaryJson = JSON.stringify(
  getSafeStartupConfigSummary(enabledConfig)
);
assert.equal(safeSummaryJson.includes('configured-client-id'), false);
assert.equal(safeSummaryJson.includes('configured-client-secret'), false);
assert.throws(
  () =>
    validateServerStartupEnv({
      ...startupBase,
      SHOPIFY_WRITE_ENABLED: true,
      SHOPIFY_WRITE_ORDER_ALLOWLIST: ['7248237232408'],
      SHOPIFY_WRITE_ORDER_ALLOWLIST_INVALID_ENTRIES: ['invalid'],
    }),
  /only numeric Shopify order IDs/
);

const redactedSecrets = redact({
  SHOPIFY_CLIENT_SECRET: 'client-secret-value',
  SHOPIFY_ACCESS_TOKEN: 'access-token-value',
  access_token: 'access-token-value-2',
  client_secret: 'client-secret-value-2',
  'X-Shopify-Access-Token': 'access-token-value-3',
});

for (const value of Object.values(redactedSecrets)) {
  assert.equal(value, REDACTED_VALUE);
}

const shopifyOrderId = '7259989737752';
const shopifyLineItemId = '17199936274712';
const fulfillmentOrderId =
  'gid://shopify/FulfillmentOrder/8197734662424';
const targetFulfillmentLineItemId =
  'gid://shopify/FulfillmentOrderLineItem/17398957179160';
const unrelatedFulfillmentLineItemId =
  'gid://shopify/FulfillmentOrderLineItem/333';
const taskPayload = {
  dryRun: true,
  writeSuppressed: true,
  parcel_service: 'UPS',
  trackingNumbers: [
    { number: '1ZABC123', url: 'https://example.test/track/one' },
    { number: '1ZDEF456', url: 'https://example.test/track/two' },
  ],
};

function fulfillmentOrderResponse({ includeTarget = true, remainingQuantity = 2 } = {}) {
  const nodes = [
    {
      id: unrelatedFulfillmentLineItemId,
      remainingQuantity: 1,
      lineItem: {
        id: 'gid://shopify/LineItem/123456',
      },
    },
  ];

  if (includeTarget) {
    nodes.push({
      id: targetFulfillmentLineItemId,
      remainingQuantity,
      lineItem: {
        id: `gid://shopify/LineItem/${shopifyLineItemId}`,
      },
    });
  }

  return {
    id: buildShopifyOrderGid(shopifyOrderId),
    fulfillmentOrders: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: fulfillmentOrderId,
          lineItems: {
            pageInfo: { hasNextPage: false },
            nodes,
          },
        },
      ],
    },
  };
}

const shopify202601Order = fulfillmentOrderResponse();
const shopify202601TargetLineItem =
  shopify202601Order.fulfillmentOrders.nodes[0].lineItems.nodes[1].lineItem;

assert.equal(
  Object.prototype.hasOwnProperty.call(
    shopify202601TargetLineItem,
    'legacyResourceId'
  ),
  false
);

const matchedPlan = buildShopifyFulfillmentPlan({
  order: shopify202601Order,
  shopifyOrderId,
  shopifyLineItemId,
  taskPayload,
  notifyCustomer: false,
});

assert.equal(matchedPlan.ok, true);
assert.equal(matchedPlan.disposition, 'ready');
assert.equal(matchedPlan.matchedFulfillmentOrderCount, 1);
assert.equal(matchedPlan.matchedLineItemCount, 1);
assert.equal(matchedPlan.trackingNumberCount, 2);
assert.deepEqual(
  matchedPlan.fulfillmentInput.lineItemsByFulfillmentOrder,
  [
    {
      fulfillmentOrderId,
      fulfillmentOrderLineItems: [
        { id: targetFulfillmentLineItemId, quantity: 2 },
      ],
    },
  ]
);
assert.equal(
  JSON.stringify(matchedPlan.fulfillmentInput).includes(
    unrelatedFulfillmentLineItemId
  ),
  false
);

const wholeOrderPlan = buildShopifyOrderFulfillmentPlan({
  order: shopify202601Order,
  shopifyOrderId,
  taskPayload,
  notifyCustomer: false,
});

assert.equal(wholeOrderPlan.ok, true);
assert.equal(wholeOrderPlan.matchedLineItemCount, 2);
assert.deepEqual(
  wholeOrderPlan.fulfillmentInput.lineItemsByFulfillmentOrder[0]
    .fulfillmentOrderLineItems,
  [
    { id: unrelatedFulfillmentLineItemId, quantity: 1 },
    { id: targetFulfillmentLineItemId, quantity: 2 },
  ]
);

const noMatchPlan = buildShopifyFulfillmentPlan({
  order: fulfillmentOrderResponse({ includeTarget: false }),
  shopifyOrderId,
  shopifyLineItemId,
  taskPayload,
});

assert.equal(noMatchPlan.ok, false);
assert.equal(noMatchPlan.error, 'shopify_fulfillment_line_item_not_found');

const fulfilledPlan = buildShopifyFulfillmentPlan({
  order: fulfillmentOrderResponse({ remainingQuantity: 0 }),
  shopifyOrderId,
  shopifyLineItemId,
  taskPayload,
});

assert.equal(fulfilledPlan.ok, true);
assert.equal(fulfilledPlan.disposition, 'skipped');
assert.equal(fulfilledPlan.reason, 'already_fulfilled');

const claimedTask = {
  id: 10,
  task_type: 'order_shipped',
  shopify_order_id: shopifyOrderId,
  status: SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING,
  locked_by: 'smoke-worker',
  locked_at: '2026-07-17 12:00:00',
  dry_run: true,
};
const dryRunGate = evaluateShopifyExternalWriteGates({
  config: {
    SHOPIFY_UPDATE_EXECUTOR_ENABLED: true,
    SHOPIFY_WRITE_ENABLED: true,
    SHOPIFY_WRITE_ORDER_ALLOWLIST: [shopifyOrderId],
  },
  task: claimedTask,
  payload: taskPayload,
  workerId: 'smoke-worker',
  fulfillmentInput: matchedPlan.fulfillmentInput,
});

assert.equal(dryRunGate.allowed, false);
assert.ok(
  dryRunGate.reasons.includes(
    SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.TASK_DRY_RUN
  )
);
assert.ok(
  dryRunGate.reasons.includes(
    SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.PAYLOAD_WRITE_SUPPRESSED
  )
);

const allowlistGate = evaluateShopifyExternalWriteGates({
  config: {
    SHOPIFY_UPDATE_EXECUTOR_ENABLED: true,
    SHOPIFY_WRITE_ENABLED: true,
    SHOPIFY_WRITE_ORDER_ALLOWLIST: ['111111'],
  },
  task: { ...claimedTask, dry_run: false },
  payload: { ...taskPayload, dryRun: false, writeSuppressed: false },
  workerId: 'smoke-worker',
  fulfillmentInput: matchedPlan.fulfillmentInput,
});

assert.equal(allowlistGate.allowed, false);
assert.deepEqual(allowlistGate.reasons, [
  SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.ORDER_NOT_ALLOWLISTED,
]);

const ambiguousSuppressionGate = evaluateShopifyExternalWriteGates({
  config: {
    SHOPIFY_UPDATE_EXECUTOR_ENABLED: true,
    SHOPIFY_WRITE_ENABLED: true,
    SHOPIFY_WRITE_ORDER_ALLOWLIST: [shopifyOrderId],
  },
  task: { ...claimedTask, dry_run: false },
  payload: {
    ...taskPayload,
    dryRun: false,
    writeSuppressed: 'false',
  },
  workerId: 'smoke-worker',
  fulfillmentInput: matchedPlan.fulfillmentInput,
});

assert.equal(ambiguousSuppressionGate.allowed, false);
assert.deepEqual(ambiguousSuppressionGate.reasons, [
  SHOPIFY_EXTERNAL_WRITE_BLOCK_REASONS.PAYLOAD_WRITE_SUPPRESSION_AMBIGUOUS,
]);

const liveGate = evaluateShopifyExternalWriteGates({
  config: {
    SHOPIFY_UPDATE_EXECUTOR_ENABLED: true,
    SHOPIFY_WRITE_ENABLED: true,
    SHOPIFY_WRITE_ORDER_ALLOWLIST: [shopifyOrderId],
  },
  task: { ...claimedTask, dry_run: false },
  payload: { ...taskPayload, dryRun: false, writeSuppressed: false },
  workerId: 'smoke-worker',
  fulfillmentInput: matchedPlan.fulfillmentInput,
});

assert.equal(liveGate.allowed, true);
assert.deepEqual(liveGate.reasons, []);

const allowAllGate = evaluateShopifyExternalWriteGates({
  config: {
    SHOPIFY_UPDATE_EXECUTOR_ENABLED: true,
    SHOPIFY_WRITE_ENABLED: true,
    SHOPIFY_WRITE_ALLOW_ALL_ORDERS: true,
    SHOPIFY_WRITE_ORDER_ALLOWLIST: [],
  },
  task: { ...claimedTask, dry_run: false },
  payload: { ...taskPayload, dryRun: false, writeSuppressed: false },
  workerId: 'smoke-worker',
  fulfillmentInput: matchedPlan.fulfillmentInput,
});

assert.equal(allowAllGate.allowed, true);
assert.deepEqual(allowAllGate.reasons, []);

console.log('shopify admin config smoke ok');
