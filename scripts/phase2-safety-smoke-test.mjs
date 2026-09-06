import assert from 'node:assert/strict';

import {
  MANUAL_REVIEW_REASONS,
  validateConfiguratorLineItem,
} from '../src/services/PreflightValidationService.js';
import { REDACTED_VALUE, redact } from '../src/utils/redact.js';
import { buildFactoryReference } from '../src/utils/factoryReference.js';

const wallpaperValidationOptions = {
  checkMasterFileExists: false,
  wallpaperSkus: ['20-140.1-3'],
};

const redactedHeaders = redact({
  'X-API-Key': 'factory-secret',
  nested: [
    { 'x-factory-callback-api-key': 'factory-secret-2' },
    { 'X-NEXO-API-KEY': 'nexo-secret' },
    { authorization: 'Bearer secret' },
    { FACTORY_CALLBACK_API_KEY: 'env-style-secret' },
    { shopifyApiKey: 'camel-case-secret' },
  ],
});

assert.equal(redactedHeaders['X-API-Key'], REDACTED_VALUE);
assert.equal(
  redactedHeaders.nested[0]['x-factory-callback-api-key'],
  REDACTED_VALUE
);
assert.equal(redactedHeaders.nested[1]['X-NEXO-API-KEY'], REDACTED_VALUE);
assert.equal(redactedHeaders.nested[2].authorization, REDACTED_VALUE);
assert.equal(
  redactedHeaders.nested[3].FACTORY_CALLBACK_API_KEY,
  REDACTED_VALUE
);
assert.equal(redactedHeaders.nested[4].shopifyApiKey, REDACTED_VALUE);

const missingPayload = validateConfiguratorLineItem(
  {
    id: 1,
    sku: '20-140.1-3',
    quantity: 1,
    properties: [],
  },
  wallpaperValidationOptions
);

assert.equal(missingPayload.isConfigurable, true);
assert.equal(missingPayload.ok, false);
assert.equal(
  missingPayload.reason,
  MANUAL_REVIEW_REASONS.MISSING_CONFIGURATOR_PAYLOAD
);

const nonConfigurableAddon = validateConfiguratorLineItem(
  {
    id: 2,
    sku: 'gift-wrap',
    properties: [],
  },
  wallpaperValidationOptions
);

assert.equal(nonConfigurableAddon.isConfigurable, false);
assert.equal(nonConfigurableAddon.ok, true);

const testedSize = validateConfiguratorLineItem(
  {
    id: 3,
    sku: '20-140.1-3',
    quantity: 1,
    properties: [
      {
        name: 'configurator_payload',
        value: JSON.stringify({
          version: 1,
          master_asset_id: 'master-1',
          output: { width: 5000, height: 2000, unit: 'mm' },
          crop_ratio: { x: 0, y: 0, w: 1, h: 1 },
        }),
      },
    ],
  },
  wallpaperValidationOptions
);

assert.equal(testedSize.ok, true);

const oversized = validateConfiguratorLineItem(
  {
    id: 4,
    sku: '20-140.1-3',
    quantity: 1,
    properties: [
      {
        name: 'configurator_payload',
        value: {
          version: 1,
          master_asset_id: 'master-1',
          output: { width: 20001, height: 2000, unit: 'mm' },
          crop_ratio: { x: 0, y: 0, w: 1, h: 1 },
        },
      },
    ],
  },
  wallpaperValidationOptions
);

assert.equal(oversized.ok, false);
assert.ok(
  oversized.errors.includes(
    MANUAL_REVIEW_REASONS.OUTPUT_WIDTH_EXCEEDS_LIMIT
  )
);

const factoryReference = buildFactoryReference({
  shopifyOrderId: '7248237232408',
  jobId: 24,
});

assert.equal(factoryReference, 'WANDINI-S7248237232408-J24');
assert.equal(
  buildFactoryReference({ shopifyOrderId: '7248237232408', jobId: 24 }),
  factoryReference
);

console.log('phase2 safety smoke ok');
