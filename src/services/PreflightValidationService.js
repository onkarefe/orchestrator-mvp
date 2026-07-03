import { resolveMasterPath } from '../processing/masterResolver.js';
import { isValidCropRatio } from '../processing/validation.js';

export const MANUAL_REVIEW_REASONS = Object.freeze({
  INVALID_CONFIGURATOR_PAYLOAD: 'invalid_configurator_payload',
  MISSING_MASTER_ASSET_ID: 'missing_master_asset_id',
  MISSING_MASTER_FILE: 'missing_master_file',
  INVALID_OUTPUT_DIMENSIONS: 'invalid_output_dimensions',
  INVALID_CROP_RATIO: 'invalid_crop_ratio',
  MISSING_SKU: 'missing_sku',
  MISSING_LINE_ITEM_ID: 'missing_line_item_id',
});

function findConfiguratorPayloadProperty(lineItem) {
  const properties = Array.isArray(lineItem?.properties)
    ? lineItem.properties
    : [];

  return properties.find(
    (property) => property?.name === 'configurator_payload'
  );
}

function hasLineItemId(lineItem) {
  return !(
    lineItem?.id === null ||
    lineItem?.id === undefined ||
    lineItem.id === ''
  );
}

function hasSku(lineItem) {
  return (
    typeof lineItem?.sku === 'string' && lineItem.sku.trim().length > 0
  );
}

function parseConfiguratorPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      ok: true,
      value,
    };
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return {
      ok: false,
      value: null,
    };
  }

  try {
    const parsed = JSON.parse(value);

    return {
      ok: Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)),
      value:
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : null,
    };
  } catch {
    return {
      ok: false,
      value: null,
    };
  }
}

function isPositiveFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function getMasterAssetId(configuratorPayload) {
  const masterAssetId = configuratorPayload?.master_asset_id;

  return typeof masterAssetId === 'string' && masterAssetId.trim()
    ? masterAssetId.trim()
    : null;
}

function hasValidOutputDimensions(configuratorPayload) {
  return (
    isPositiveFiniteNumber(configuratorPayload?.output?.width) &&
    isPositiveFiniteNumber(configuratorPayload?.output?.height)
  );
}

function checkMasterFile(masterAssetId, resolveMasterPathFn) {
  try {
    return {
      ok: true,
      masterPath: resolveMasterPathFn(masterAssetId),
    };
  } catch {
    return {
      ok: false,
      masterPath: null,
    };
  }
}

export function validateConfiguratorLineItem(
  lineItem,
  { resolveMasterPathFn = resolveMasterPath, checkMasterFileExists = true } = {}
) {
  const payloadProperty = findConfiguratorPayloadProperty(lineItem);

  if (!payloadProperty) {
    return {
      isConfigurable: false,
      ok: true,
      reason: null,
      errors: [],
      configuratorPayload: null,
      masterPath: null,
    };
  }

  const errors = [];
  const parsedPayload = parseConfiguratorPayload(payloadProperty.value);
  const configuratorPayload = parsedPayload.value;
  let masterPath = null;

  if (!hasLineItemId(lineItem)) {
    errors.push(MANUAL_REVIEW_REASONS.MISSING_LINE_ITEM_ID);
  }

  if (!hasSku(lineItem)) {
    errors.push(MANUAL_REVIEW_REASONS.MISSING_SKU);
  }

  if (!parsedPayload.ok) {
    errors.push(MANUAL_REVIEW_REASONS.INVALID_CONFIGURATOR_PAYLOAD);
  }

  if (parsedPayload.ok) {
    const masterAssetId = getMasterAssetId(configuratorPayload);

    if (!masterAssetId) {
      errors.push(MANUAL_REVIEW_REASONS.MISSING_MASTER_ASSET_ID);
    }

    if (!hasValidOutputDimensions(configuratorPayload)) {
      errors.push(MANUAL_REVIEW_REASONS.INVALID_OUTPUT_DIMENSIONS);
    }

    if (!isValidCropRatio(configuratorPayload.crop_ratio)) {
      errors.push(MANUAL_REVIEW_REASONS.INVALID_CROP_RATIO);
    }

    if (masterAssetId && checkMasterFileExists) {
      const masterFile = checkMasterFile(masterAssetId, resolveMasterPathFn);

      if (masterFile.ok) {
        masterPath = masterFile.masterPath;
      } else {
        errors.push(MANUAL_REVIEW_REASONS.MISSING_MASTER_FILE);
      }
    }
  }

  return {
    isConfigurable: true,
    ok: errors.length === 0,
    reason: errors[0] ?? null,
    errors,
    configuratorPayload,
    masterPath,
  };
}

export default {
  MANUAL_REVIEW_REASONS,
  validateConfiguratorLineItem,
};
