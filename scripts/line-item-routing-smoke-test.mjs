import assert from 'node:assert/strict';

import {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_STATES,
} from '../src/constants/lineItemRouting.js';
import { createOrderLineItem } from '../src/models/OrderLineItemModel.js';
import {
  FACTORY_DISPATCH_BLOCK_REASONS,
  evaluateFactoryDispatchGate,
} from '../src/services/FactoryDispatchGateService.js';
import { ensureOrderFactoryUploadTask } from '../src/services/FactoryUploadTaskService.js';
import { createConfiguratorJobFromLineItem } from '../src/services/JobService.js';
import { classifyShopifyLineItem } from '../src/services/LineItemRoutingService.js';

const validPayload = {
  master_asset_id: 'master-1',
  output: { width: 3000, height: 2400 },
  crop_ratio: { x: 0, y: 0, w: 1, h: 1 },
};

function item(id, sku, properties = []) {
  return { id, sku, title: `Item ${id}`, quantity: 1, properties };
}

function configurableItem(id, sku = 'wandini-wallpaper-1') {
  return item(id, sku, [
    { name: 'configurator_payload', value: validPayload },
  ]);
}

const routingOptions = {
  configuratorSkuPrefixes: ['wandini-'],
  accessorySkus: ['ACCESSORY-EXPLICIT'],
  validationOptions: { checkMasterFileExists: false },
};

const validWallpaper = configurableItem(101);
const validWallpaperRouting = classifyShopifyLineItem(
  validWallpaper,
  routingOptions
);
assert.equal(
  validWallpaperRouting.classification,
  LINE_ITEM_CLASSIFICATIONS.WALLPAPER
);
assert.equal(
  validWallpaperRouting.routingState,
  LINE_ITEM_ROUTING_STATES.PRODUCTION_READY
);

const missingConfiguratorWallpaper = item(102, 'wandini-wallpaper-2');
const invalidWallpaperRouting = classifyShopifyLineItem(
  missingConfiguratorWallpaper,
  routingOptions
);
assert.equal(
  invalidWallpaperRouting.classification,
  LINE_ITEM_CLASSIFICATIONS.WALLPAPER
);
assert.equal(
  invalidWallpaperRouting.routingState,
  LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED
);
const overlappingContractRouting = classifyShopifyLineItem(
  missingConfiguratorWallpaper,
  {
    ...routingOptions,
    accessorySkus: [missingConfiguratorWallpaper.sku],
  }
);
assert.equal(
  overlappingContractRouting.classification,
  LINE_ITEM_CLASSIFICATIONS.WALLPAPER
);

const accessory = item(103, 'ACCESSORY-EXPLICIT');
const accessoryRouting = classifyShopifyLineItem(accessory, routingOptions);
assert.equal(
  accessoryRouting.classification,
  LINE_ITEM_CLASSIFICATIONS.ACCESSORY
);
assert.equal(
  accessoryRouting.routingState,
  LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED
);

const untrustedPayloadItem = configurableItem(104, 'UNTRUSTED-SKU');
const unknownRouting = classifyShopifyLineItem(
  untrustedPayloadItem,
  routingOptions
);
assert.equal(unknownRouting.classification, LINE_ITEM_CLASSIFICATIONS.UNKNOWN);
assert.equal(
  unknownRouting.routingState,
  LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED
);

let createdJobCount = 0;
const jobRuntime = {
  validateConfiguratorLineItem: () => validWallpaperRouting.validation,
  findJobByShopifyOrderAndLineItem: async () => null,
  createJob: async (data) => {
    createdJobCount += 1;
    return {
      id: createdJobCount,
      order_id: data.orderId,
      shopify_order_id: String(data.shopifyOrderId),
      shopify_line_item_id: String(data.shopifyLineItemId),
      status: data.status,
    };
  },
};
const validJob = await createConfiguratorJobFromLineItem(1, validWallpaper, {
  shopifyOrderId: 9001,
  runtime: jobRuntime,
});
assert.equal(validJob.created, true);
assert.equal(createdJobCount, 1);

for (const nonWallpaper of [accessory, untrustedPayloadItem]) {
  const result = await createConfiguratorJobFromLineItem(1, nonWallpaper, {
    shopifyOrderId: 9001,
    runtime: {
      ...jobRuntime,
      validateConfiguratorLineItem: undefined,
    },
  });
  assert.equal(result.job, null);
}
assert.equal(createdJobCount, 1);

const storedRows = [];
let nextLineItemId = 1;
const lineItemExecutor = {
  async execute(sql, params) {
    if (sql.includes('INSERT INTO order_line_items')) {
      const existing = storedRows.find(
        (row) =>
          (params[2] && row.shopify_line_item_id === String(params[2])) ||
          row.source_position === params[3]
      );

      if (existing) {
        const error = new Error('duplicate');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }

      const row = {
        id: nextLineItemId++,
        order_id: params[0],
        shopify_order_id: String(params[1]),
        shopify_line_item_id: params[2] === null ? null : String(params[2]),
        source_position: params[3],
        sku: params[4],
        title: params[5],
        quantity: params[6],
        classification: params[7],
        routing_state: params[8],
        routing_reason: params[9],
      };
      storedRows.push(row);
      return [{ insertId: row.id }];
    }

    if (sql.includes('WHERE id = ?')) {
      return [[storedRows.find((row) => row.id === params[0])]];
    }

    if (sql.includes('shopify_line_item_id = ?')) {
      return [[
        storedRows.find(
          (row) =>
            row.shopify_order_id === String(params[0]) &&
            row.shopify_line_item_id === String(params[1])
        ),
      ]];
    }

    throw new Error(`Unexpected line-item SQL: ${sql}`);
  },
};
const persistedData = {
  orderId: 1,
  shopifyOrderId: 9001,
  shopifyLineItemId: validWallpaper.id,
  sourcePosition: 0,
  sku: validWallpaper.sku,
  title: validWallpaper.title,
  quantity: validWallpaper.quantity,
  classification: validWallpaperRouting.classification,
  routingState: validWallpaperRouting.routingState,
  routingReason: validWallpaperRouting.routingReason,
};
const firstPersist = await createOrderLineItem(persistedData, lineItemExecutor);
const secondPersist = await createOrderLineItem(persistedData, lineItemExecutor);
assert.equal(firstPersist.created, true);
assert.equal(secondPersist.created, false);
assert.equal(storedRows.length, 1);
assert.equal(
  storedRows[0].classification,
  LINE_ITEM_CLASSIFICATIONS.WALLPAPER
);

for (const [index, [sourceItem, routing]] of [
  [missingConfiguratorWallpaper, invalidWallpaperRouting],
  [accessory, accessoryRouting],
  [untrustedPayloadItem, unknownRouting],
].entries()) {
  const persisted = await createOrderLineItem(
    {
      orderId: 1,
      shopifyOrderId: 9001,
      shopifyLineItemId: sourceItem.id,
      sourcePosition: index + 1,
      sku: sourceItem.sku,
      title: sourceItem.title,
      quantity: sourceItem.quantity,
      classification: routing.classification,
      routingState: routing.routingState,
      routingReason: routing.routingReason,
    },
    lineItemExecutor
  );
  assert.equal(persisted.created, true);
  assert.equal(persisted.lineItem.classification, routing.classification);
}
assert.equal(storedRows.length, 4);

function persistedLine(sourceItem, sourcePosition, routing) {
  return {
    id: sourcePosition + 1,
    order_id: 1,
    shopify_order_id: '9001',
    shopify_line_item_id: String(sourceItem.id),
    source_position: sourcePosition,
    classification: routing.classification,
    routing_state: routing.routingState,
    routing_reason: routing.routingReason,
  };
}

function orderFor(...lineItems) {
  return {
    id: 1,
    shopify_order_id: '9001',
    raw_payload_json: { id: 9001, line_items: lineItems },
  };
}

const orderPackage = {
  id: 31,
  order_id: 1,
  artifact_id: 21,
  order_number: 'WANDINI-S9001',
  status: 'ready',
  manifest_path: 'C:/factory/order-9001/manifest.json',
  xml_file_name: 'WANDINI-S9001.xml',
};
const artifact = {
  id: 21,
  order_id: 1,
  job_id: null,
  type: 'factory_package',
  status: 'available',
  validation_status: 'passed',
  manifest_path: 'C:/factory/order-9001/manifest.json',
  file_name: 'WANDINI-S9001.xml',
};
const factoryConfig = {
  FTP_REMOTE_DIR: '/factory',
  FTP_UPLOAD_TASK_MAX_ATTEMPTS: 3,
};
let createdTaskCount = 0;
const factoryRuntime = {
  findFactoryUploadTaskByOrderPackageId: async () => null,
  createFactoryUploadTask: async (data) => {
    createdTaskCount += 1;
    return {
      id: createdTaskCount,
      order_id: data.orderId,
      job_id: null,
      artifact_id: data.artifactId,
      order_factory_package_id: data.orderFactoryPackageId,
      shopify_order_id: String(data.shopifyOrderId),
      factory_reference: data.factoryReference,
      status: data.status,
      upload_mode: data.uploadMode,
      suppressed_reason: data.suppressedReason,
    };
  },
  logInfo: async () => null,
  logWarning: async () => null,
};

const wallpaperOnlyOrder = orderFor(validWallpaper);
const wallpaperOnlyLines = [
  persistedLine(validWallpaper, 0, validWallpaperRouting),
];
assert.equal(
  evaluateFactoryDispatchGate({
    order: wallpaperOnlyOrder,
    lineItems: wallpaperOnlyLines,
  }).allowed,
  true
);
const validFactoryTask = await ensureOrderFactoryUploadTask({
  order: wallpaperOnlyOrder,
  orderPackage,
  artifact,
  config: factoryConfig,
  orderLineItems: wallpaperOnlyLines,
  runtime: factoryRuntime,
});
assert.equal(validFactoryTask.created, true);
assert.equal(createdTaskCount, 1);

const blockedCases = [
  {
    order: orderFor(missingConfiguratorWallpaper),
    lines: [
      persistedLine(missingConfiguratorWallpaper, 0, invalidWallpaperRouting),
    ],
    reason: FACTORY_DISPATCH_BLOCK_REASONS.BLOCKED_LINE_ITEM,
  },
  {
    order: orderFor(accessory),
    lines: [persistedLine(accessory, 0, accessoryRouting)],
    reason: FACTORY_DISPATCH_BLOCK_REASONS.ACCESSORY_LINE_ITEM,
  },
  {
    order: orderFor(untrustedPayloadItem),
    lines: [persistedLine(untrustedPayloadItem, 0, unknownRouting)],
    reason: FACTORY_DISPATCH_BLOCK_REASONS.UNKNOWN_LINE_ITEM,
  },
  {
    order: orderFor(validWallpaper, accessory),
    lines: [
      persistedLine(validWallpaper, 0, validWallpaperRouting),
      persistedLine(accessory, 1, accessoryRouting),
    ],
    reason: FACTORY_DISPATCH_BLOCK_REASONS.ACCESSORY_LINE_ITEM,
  },
];

for (const blockedCase of blockedCases) {
  const gate = evaluateFactoryDispatchGate({
    order: blockedCase.order,
    lineItems: blockedCase.lines,
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, blockedCase.reason);

  const result = await ensureOrderFactoryUploadTask({
    order: blockedCase.order,
    orderPackage,
    artifact,
    config: factoryConfig,
    orderLineItems: blockedCase.lines,
    runtime: factoryRuntime,
  });
  assert.equal(result.task, null);
  assert.equal(result.blocked, true);
}
assert.equal(createdTaskCount, 1);

const incomplete = evaluateFactoryDispatchGate({
  order: orderFor(validWallpaper, accessory),
  lineItems: wallpaperOnlyLines,
});
assert.equal(incomplete.allowed, false);
assert.equal(
  incomplete.reason,
  FACTORY_DISPATCH_BLOCK_REASONS.CLASSIFICATION_INCOMPLETE
);

console.log('line-item routing safety smoke ok');
