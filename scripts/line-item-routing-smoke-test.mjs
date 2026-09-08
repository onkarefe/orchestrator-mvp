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
import { MANUAL_REVIEW_REASONS } from '../src/services/PreflightValidationService.js';
import {
  LEGACY_CONFIGURATOR_INSTANCE_PROPERTY,
  LEGACY_CONFIGURATOR_PAYLOAD_PROPERTY,
  PRIVATE_CONFIGURATOR_INSTANCE_PROPERTY,
  PRIVATE_CONFIGURATOR_PAYLOAD_PROPERTY,
  resolveConfiguratorProperties,
} from '../src/services/ConfiguratorPropertyResolver.js';
import { inspectOrderFactoryReadiness } from '../src/processing/OrderFactoryPackageAssembler.js';

const validPayload = {
  version: 1,
  master_asset_id: 'master-1',
  output: { width: 3000, height: 2400, unit: 'mm' },
  crop_ratio: { x: 0, y: 0, w: 1, h: 1 },
};

function item(id, sku, properties = []) {
  return { id, sku, title: `Item ${id}`, quantity: 1, properties };
}

function configurableItem(id, sku = '20-140.1-3', payload = validPayload) {
  return item(id, sku, [
    { name: 'configurator_payload', value: payload },
  ]);
}

const routingOptions = {
  wallpaperSkus: ['20-140.1-3', '20-140.1-4', '20-331.1-3'],
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
assert.equal(
  classifyShopifyLineItem(validWallpaper, {
    ...routingOptions,
    wallpaperSkus: ['', ' 20-140.1-3 ', ' '],
  }).classification,
  LINE_ITEM_CLASSIFICATIONS.WALLPAPER
);
assert.equal(
  classifyShopifyLineItem(validWallpaper, {
    ...routingOptions,
    wallpaperSkus: [],
  }).classification,
  LINE_ITEM_CLASSIFICATIONS.UNKNOWN
);

const privatePayloadValue = JSON.stringify({
  ...validPayload,
  master_asset_id: 'private-master',
});
const privateWallpaper = item(111, '20-331.1-3', [
  {
    name: PRIVATE_CONFIGURATOR_PAYLOAD_PROPERTY,
    value: privatePayloadValue,
  },
]);
const privateWallpaperRouting = classifyShopifyLineItem(
  privateWallpaper,
  routingOptions
);
assert.equal(
  resolveConfiguratorProperties(privateWallpaper.properties).payload,
  privatePayloadValue
);
assert.equal(
  privateWallpaperRouting.classification,
  LINE_ITEM_CLASSIFICATIONS.WALLPAPER
);
assert.equal(
  privateWallpaperRouting.routingState,
  LINE_ITEM_ROUTING_STATES.PRODUCTION_READY
);
assert.equal(
  privateWallpaperRouting.validation.configuratorPayload.master_asset_id,
  'private-master'
);

const legacyPayloadValue = JSON.stringify({
  ...validPayload,
  master_asset_id: 'legacy-master',
});
const bothPayloadNames = item(112, '20-140.1-3', [
  {
    name: LEGACY_CONFIGURATOR_PAYLOAD_PROPERTY,
    value: legacyPayloadValue,
  },
  {
    name: PRIVATE_CONFIGURATOR_PAYLOAD_PROPERTY,
    value: privatePayloadValue,
  },
]);
const bothPayloadNamesRouting = classifyShopifyLineItem(
  bothPayloadNames,
  routingOptions
);
assert.equal(bothPayloadNamesRouting.validation.ok, true);
assert.equal(
  bothPayloadNamesRouting.validation.configuratorPayload.master_asset_id,
  'private-master'
);

const malformedPrivatePayload = item(113, '20-140.1-3', [
  {
    name: LEGACY_CONFIGURATOR_PAYLOAD_PROPERTY,
    value: legacyPayloadValue,
  },
  {
    name: PRIVATE_CONFIGURATOR_PAYLOAD_PROPERTY,
    value: '{malformed',
  },
]);
const malformedPrivateRouting = classifyShopifyLineItem(
  malformedPrivatePayload,
  routingOptions
);
assert.equal(
  malformedPrivateRouting.routingState,
  LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED
);
assert.ok(
  malformedPrivateRouting.validation.errors.includes(
    MANUAL_REVIEW_REASONS.INVALID_CONFIGURATOR_PAYLOAD
  )
);
assert.equal(malformedPrivateRouting.validation.configuratorPayload, null);

assert.equal(
  resolveConfiguratorProperties([
    {
      name: PRIVATE_CONFIGURATOR_INSTANCE_PROPERTY,
      value: 'new-instance',
    },
  ]).instanceId,
  'new-instance'
);
assert.equal(
  resolveConfiguratorProperties([
    {
      name: LEGACY_CONFIGURATOR_INSTANCE_PROPERTY,
      value: 'legacy-instance',
    },
  ]).instanceId,
  'legacy-instance'
);
assert.equal(
  resolveConfiguratorProperties([
    {
      name: LEGACY_CONFIGURATOR_INSTANCE_PROPERTY,
      value: 'legacy-instance',
    },
    {
      name: PRIVATE_CONFIGURATOR_INSTANCE_PROPERTY,
      value: 'new-instance',
    },
  ]).instanceId,
  'new-instance'
);
assert.deepEqual(resolveConfiguratorProperties([]), {
  payload: null,
  instanceId: null,
});

const invalidPrivateValidation = classifyShopifyLineItem(
  item(114, '20-331.1-3', [
    {
      name: PRIVATE_CONFIGURATOR_PAYLOAD_PROPERTY,
      value: JSON.stringify({
        version: 2,
        output: { width: 0, height: 2400, unit: 'cm' },
        crop_ratio: { x: -1, y: 0, w: 2, h: 1 },
      }),
    },
  ]),
  routingOptions
);
for (const expectedError of [
  MANUAL_REVIEW_REASONS.INVALID_CONFIGURATOR_PAYLOAD_VERSION,
  MANUAL_REVIEW_REASONS.INVALID_CONFIGURATOR_OUTPUT_UNIT,
  MANUAL_REVIEW_REASONS.MISSING_MASTER_ASSET_ID,
  MANUAL_REVIEW_REASONS.INVALID_OUTPUT_DIMENSIONS,
  MANUAL_REVIEW_REASONS.INVALID_CROP_RATIO,
]) {
  assert.ok(invalidPrivateValidation.validation.errors.includes(expectedError));
}

const missingPrivateMasterFile = classifyShopifyLineItem(
  item(115, '20-331.1-3', [
    {
      name: PRIVATE_CONFIGURATOR_PAYLOAD_PROPERTY,
      value: privatePayloadValue,
    },
  ]),
  {
    ...routingOptions,
    validationOptions: {
      checkMasterFileExists: true,
      resolveMasterPathFn: () => {
        throw new Error('missing test master');
      },
    },
  }
);
assert.ok(
  missingPrivateMasterFile.validation.errors.includes(
    MANUAL_REVIEW_REASONS.MISSING_MASTER_FILE
  )
);

const invalidPrivateQuantity = classifyShopifyLineItem(
  { ...privateWallpaper, id: 116, quantity: 2 },
  routingOptions
);
assert.ok(
  invalidPrivateQuantity.validation.errors.includes(
    MANUAL_REVIEW_REASONS.INVALID_WALLPAPER_QUANTITY
  )
);

const missingConfiguratorWallpaper = item(102, '20-140.1-4');
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

const missingSkuItem = item(110, '');
const missingSkuRouting = classifyShopifyLineItem(
  missingSkuItem,
  routingOptions
);
assert.equal(
  missingSkuRouting.classification,
  LINE_ITEM_CLASSIFICATIONS.UNKNOWN
);
assert.equal(missingSkuRouting.routingReason, 'unknown_sku');

const prefixLikeRouting = classifyShopifyLineItem(
  configurableItem(105, '20-140.1-3-extra'),
  routingOptions
);
assert.equal(
  prefixLikeRouting.classification,
  LINE_ITEM_CLASSIFICATIONS.UNKNOWN
);

const invalidVersionRouting = classifyShopifyLineItem(
  configurableItem(106, '20-140.1-3', { ...validPayload, version: 2 }),
  routingOptions
);
assert.equal(
  invalidVersionRouting.routingState,
  LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED
);
assert.ok(
  invalidVersionRouting.validation.errors.includes(
    MANUAL_REVIEW_REASONS.INVALID_CONFIGURATOR_PAYLOAD_VERSION
  )
);

const invalidUnitRouting = classifyShopifyLineItem(
  configurableItem(107, '20-140.1-3', {
    ...validPayload,
    output: { ...validPayload.output, unit: 'cm' },
  }),
  routingOptions
);
assert.equal(
  invalidUnitRouting.routingState,
  LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED
);
assert.ok(
  invalidUnitRouting.validation.errors.includes(
    MANUAL_REVIEW_REASONS.INVALID_CONFIGURATOR_OUTPUT_UNIT
  )
);

const invalidQuantityItem = {
  ...configurableItem(108),
  quantity: 2,
};
const invalidQuantityRouting = classifyShopifyLineItem(
  invalidQuantityItem,
  routingOptions
);
assert.equal(
  invalidQuantityRouting.routingState,
  LINE_ITEM_ROUTING_STATES.FACTORY_BLOCKED
);
assert.ok(
  invalidQuantityRouting.validation.errors.includes(
    MANUAL_REVIEW_REASONS.INVALID_WALLPAPER_QUANTITY
  )
);

const secondValidWallpaperRouting = classifyShopifyLineItem(
  configurableItem(109, '20-140.1-4'),
  routingOptions
);
assert.equal(
  secondValidWallpaperRouting.routingState,
  LINE_ITEM_ROUTING_STATES.PRODUCTION_READY
);

let createdJobCount = 0;
let createdJobData = null;
const jobRuntime = {
  validateConfiguratorLineItem: () => privateWallpaperRouting.validation,
  findJobByShopifyOrderAndLineItem: async () => null,
  createJob: async (data) => {
    createdJobCount += 1;
    createdJobData = data;
    return {
      id: createdJobCount,
      order_id: data.orderId,
      shopify_order_id: String(data.shopifyOrderId),
      shopify_line_item_id: String(data.shopifyLineItemId),
      status: data.status,
    };
  },
};
const validJob = await createConfiguratorJobFromLineItem(1, privateWallpaper, {
  shopifyOrderId: 9001,
  runtime: jobRuntime,
});
assert.equal(validJob.created, true);
assert.equal(createdJobCount, 1);
assert.equal(createdJobData.masterAssetId, 'private-master');
assert.equal(
  createdJobData.rawPayloadJson.configuratorPayload.master_asset_id,
  'private-master'
);

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
    raw_payload_json: {
      id: 9001,
      shipping_address: {
        name: 'Factory Customer',
        address1: 'Street 1',
        zip: '12345',
        city: 'Berlin',
        country_code: 'DE',
      },
      line_items: lineItems,
    },
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

for (const rawPayload of [
  {
    id: 9001,
    billing_address:
      wallpaperOnlyOrder.raw_payload_json.shipping_address,
    line_items: [validWallpaper],
  },
  {
    id: 9001,
    customer: {
      default_address:
        wallpaperOnlyOrder.raw_payload_json.shipping_address,
    },
    line_items: [validWallpaper],
  },
]) {
  const gate = evaluateFactoryDispatchGate({
    order: {
      ...wallpaperOnlyOrder,
      raw_payload_json: rawPayload,
    },
    lineItems: wallpaperOnlyLines,
  });
  assert.equal(gate.allowed, false);
  assert.equal(
    gate.reason,
    FACTORY_DISPATCH_BLOCK_REASONS.MISSING_SHIPPING_ADDRESS
  );
  const result = await ensureOrderFactoryUploadTask({
    order: {
      ...wallpaperOnlyOrder,
      raw_payload_json: rawPayload,
    },
    orderPackage,
    artifact,
    config: factoryConfig,
    orderLineItems: wallpaperOnlyLines,
    runtime: factoryRuntime,
  });
  assert.equal(result.task, null);
  assert.equal(result.blocked, true);
  const packageReadiness = await inspectOrderFactoryReadiness({
    order: {
      ...wallpaperOnlyOrder,
      raw_payload_json: rawPayload,
    },
    lineItems: wallpaperOnlyLines,
    jobs: [],
    artifacts: [],
  });
  assert.equal(packageReadiness.ready, false);
  assert.equal(
    packageReadiness.reason,
    FACTORY_DISPATCH_BLOCK_REASONS.MISSING_SHIPPING_ADDRESS
  );
}

const invalidShippingGate = evaluateFactoryDispatchGate({
  order: {
    ...wallpaperOnlyOrder,
    raw_payload_json: {
      ...wallpaperOnlyOrder.raw_payload_json,
      shipping_address: {
        name: 'Factory Customer',
        address1: 'Street 1',
        city: 'Berlin',
        country_code: 'DE',
      },
    },
  },
  lineItems: wallpaperOnlyLines,
});
assert.equal(invalidShippingGate.allowed, false);
assert.equal(
  invalidShippingGate.reason,
  FACTORY_DISPATCH_BLOCK_REASONS.INVALID_SHIPPING_ADDRESS
);
assert.equal(createdTaskCount, 1);

const manualReviewGate = evaluateFactoryDispatchGate({
  order: {
    ...wallpaperOnlyOrder,
    status: 'manual_review',
  },
  lineItems: wallpaperOnlyLines,
});
assert.equal(manualReviewGate.allowed, false);
assert.equal(
  manualReviewGate.reason,
  FACTORY_DISPATCH_BLOCK_REASONS.ORDER_MANUAL_REVIEW
);

console.log('line-item routing safety smoke ok');
