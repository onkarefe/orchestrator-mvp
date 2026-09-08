import { resolveMasterPath } from '../processing/masterResolver.js';
import { isValidCropRatio } from '../processing/validation.js';
import env from '../config/env.js';
import { resolveConfiguratorProperties } from './ConfiguratorPropertyResolver.js';

export const MANUAL_REVIEW_REASONS = Object.freeze({
  INVALID_CONFIGURATOR_PAYLOAD: 'invalid_configurator_payload',
  MISSING_CONFIGURATOR_PAYLOAD: 'missing_configurator_payload',
  MISSING_MASTER_ASSET_ID: 'missing_master_asset_id',
  MISSING_MASTER_FILE: 'missing_master_file',
  INVALID_OUTPUT_DIMENSIONS: 'invalid_output_dimensions',
  INVALID_CROP_RATIO: 'invalid_crop_ratio',
  MISSING_SKU: 'missing_sku',
  MISSING_LINE_ITEM_ID: 'missing_line_item_id',
  OUTPUT_WIDTH_EXCEEDS_LIMIT: 'output_width_exceeds_limit',
  OUTPUT_HEIGHT_EXCEEDS_LIMIT: 'output_height_exceeds_limit',
  OUTPUT_AREA_EXCEEDS_LIMIT: 'output_area_exceeds_limit',
  INVALID_CONFIGURATOR_PAYLOAD_VERSION:
    'invalid_configurator_payload_version',
  INVALID_CONFIGURATOR_OUTPUT_UNIT: 'invalid_configurator_output_unit',
  INVALID_WALLPAPER_QUANTITY: 'invalid_wallpaper_quantity',
  MISSING_SHIPPING_ADDRESS: 'missing_shipping_address',
  INVALID_SHIPPING_ADDRESS: 'invalid_shipping_address',
});

function normalizeAddressText(value) {
  return String(value ?? '').trim();
}

export function validateShopifyShippingAddress(payload) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Object.prototype.hasOwnProperty.call(payload, 'shipping_address') ||
    payload.shipping_address === null ||
    payload.shipping_address === undefined
  ) {
    return {
      ok: false,
      reason: MANUAL_REVIEW_REASONS.MISSING_SHIPPING_ADDRESS,
      errors: ['shipping_address'],
      normalized: null,
    };
  }

  const address = payload.shipping_address;

  if (typeof address !== 'object' || Array.isArray(address)) {
    return {
      ok: false,
      reason: MANUAL_REVIEW_REASONS.INVALID_SHIPPING_ADDRESS,
      errors: ['shipping_address'],
      normalized: null,
    };
  }

  const fullName = [address.first_name, address.last_name]
    .map(normalizeAddressText)
    .filter(Boolean)
    .join(' ');
  const company =
    normalizeAddressText(address.company) ||
    normalizeAddressText(address.name) ||
    fullName;
  const contactPerson =
    normalizeAddressText(address.name) || fullName || company;
  const normalized = {
    company,
    contactPerson,
    street: [address.address1, address.address2]
      .map(normalizeAddressText)
      .filter(Boolean)
      .join(', '),
    postcode: normalizeAddressText(address.zip),
    city: normalizeAddressText(address.city),
    country: normalizeAddressText(address.country_code),
    phone:
      normalizeAddressText(address.phone) ||
      normalizeAddressText(payload.phone) ||
      normalizeAddressText(payload.customer?.phone) ||
      '0000',
  };
  const requiredFields = {
    company: normalized.company,
    contact_person: normalized.contactPerson,
    street: normalized.street,
    postcode: normalized.postcode,
    city: normalized.city,
    country: normalized.country,
  };
  const errors = Object.entries(requiredFields)
    .filter(([, value]) => !value)
    .map(([field]) => field);

  return {
    ok: errors.length === 0,
    reason:
      errors.length === 0
        ? null
        : MANUAL_REVIEW_REASONS.INVALID_SHIPPING_ADDRESS,
    errors,
    normalized: errors.length === 0 ? normalized : null,
  };
}

function hasConfiguratorPayloadValue(value) {
  return Boolean(
    (typeof value === 'string' && value.trim()) ||
      (value && typeof value === 'object' && !Array.isArray(value))
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

export function isWallpaperSku(
  sku,
  wallpaperSkus = env.WALLPAPER_SKUS
) {
  if (typeof sku !== 'string' || sku.length === 0) {
    return false;
  }

  return (Array.isArray(wallpaperSkus) ? wallpaperSkus : []).some(
    (configuredSku) =>
      typeof configuredSku === 'string' && configuredSku.trim() === sku
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

function getOutputDimensionLimitErrors(configuratorPayload) {
  if (!hasValidOutputDimensions(configuratorPayload)) {
    return [];
  }

  const widthMm = configuratorPayload.output.width;
  const heightMm = configuratorPayload.output.height;
  const areaM2 = (widthMm * heightMm) / 1_000_000;
  const errors = [];

  if (widthMm > env.CONFIGURATOR_MAX_OUTPUT_WIDTH_MM) {
    errors.push(MANUAL_REVIEW_REASONS.OUTPUT_WIDTH_EXCEEDS_LIMIT);
  }

  if (heightMm > env.CONFIGURATOR_MAX_OUTPUT_HEIGHT_MM) {
    errors.push(MANUAL_REVIEW_REASONS.OUTPUT_HEIGHT_EXCEEDS_LIMIT);
  }

  if (areaM2 > env.CONFIGURATOR_MAX_OUTPUT_AREA_M2) {
    errors.push(MANUAL_REVIEW_REASONS.OUTPUT_AREA_EXCEEDS_LIMIT);
  }

  return errors;
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
  {
    resolveMasterPathFn = resolveMasterPath,
    checkMasterFileExists = true,
    wallpaperSkus = env.WALLPAPER_SKUS,
  } = {}
) {
  const { payload: configuratorPayloadValue } =
    resolveConfiguratorProperties(lineItem?.properties);
  const configuratorSkuRequired = isWallpaperSku(
    lineItem?.sku,
    wallpaperSkus
  );

  if (!configuratorSkuRequired) {
    return {
      isConfigurable: false,
      ok: true,
      reason: null,
      errors: [],
      configuratorPayload: null,
      masterPath: null,
    };
  }

  if (!hasConfiguratorPayloadValue(configuratorPayloadValue)) {
    return {
      isConfigurable: true,
      ok: false,
      reason: MANUAL_REVIEW_REASONS.MISSING_CONFIGURATOR_PAYLOAD,
      errors: [MANUAL_REVIEW_REASONS.MISSING_CONFIGURATOR_PAYLOAD],
      configuratorPayload: null,
      masterPath: null,
    };
  }

  const errors = [];
  const parsedPayload = parseConfiguratorPayload(configuratorPayloadValue);
  const configuratorPayload = parsedPayload.value;
  let masterPath = null;

  if (!hasLineItemId(lineItem)) {
    errors.push(MANUAL_REVIEW_REASONS.MISSING_LINE_ITEM_ID);
  }

  if (!hasSku(lineItem)) {
    errors.push(MANUAL_REVIEW_REASONS.MISSING_SKU);
  }

  if (lineItem?.quantity !== 1) {
    errors.push(MANUAL_REVIEW_REASONS.INVALID_WALLPAPER_QUANTITY);
  }

  if (!parsedPayload.ok) {
    errors.push(MANUAL_REVIEW_REASONS.INVALID_CONFIGURATOR_PAYLOAD);
  }

  if (parsedPayload.ok) {
    const masterAssetId = getMasterAssetId(configuratorPayload);

    if (configuratorPayload.version !== 1) {
      errors.push(
        MANUAL_REVIEW_REASONS.INVALID_CONFIGURATOR_PAYLOAD_VERSION
      );
    }

    if (configuratorPayload?.output?.unit !== 'mm') {
      errors.push(MANUAL_REVIEW_REASONS.INVALID_CONFIGURATOR_OUTPUT_UNIT);
    }

    if (!masterAssetId) {
      errors.push(MANUAL_REVIEW_REASONS.MISSING_MASTER_ASSET_ID);
    }

    if (!hasValidOutputDimensions(configuratorPayload)) {
      errors.push(MANUAL_REVIEW_REASONS.INVALID_OUTPUT_DIMENSIONS);
    } else {
      errors.push(...getOutputDimensionLimitErrors(configuratorPayload));
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
  isWallpaperSku,
  validateConfiguratorLineItem,
  validateShopifyShippingAddress,
};
