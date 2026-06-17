import { createJob, listJobs } from '../models/JobModel.js';

function findConfiguratorPayloadProperty(lineItem) {
  const properties = Array.isArray(lineItem?.properties) ? lineItem.properties : [];

  return properties.find((property) => property?.name === 'configurator_payload');
}

function parseConfiguratorPayload(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidCropRatio(cropRatio) {
  if (!cropRatio || typeof cropRatio !== 'object' || Array.isArray(cropRatio)) {
    return false;
  }

  const { x, y, w, h } = cropRatio;

  if (![x, y, w, h].every(isFiniteNumber)) {
    return false;
  }

  return (
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x <= 1 &&
    y <= 1 &&
    w <= 1 &&
    h <= 1 &&
    x + w <= 1.000001 &&
    y + h <= 1.000001
  );
}

function isValidConfiguratorPayload(configuratorPayload) {
  if (!configuratorPayload || typeof configuratorPayload !== 'object') {
    return false;
  }

  const width = configuratorPayload.output?.width;
  const height = configuratorPayload.output?.height;

  return (
    Boolean(configuratorPayload.master_asset_id) &&
    isFiniteNumber(width) &&
    isFiniteNumber(height) &&
    width > 0 &&
    height > 0 &&
    isValidCropRatio(configuratorPayload.crop_ratio)
  );
}

export async function createConfiguratorJobFromLineItem(orderId, lineItem) {
  const payloadProperty = findConfiguratorPayloadProperty(lineItem);
  const configuratorPayload = parseConfiguratorPayload(payloadProperty?.value);

  if (!isValidConfiguratorPayload(configuratorPayload)) {
    return null;
  }

  return createJob({
    orderId,
    shopifyLineItemId: lineItem.id ?? null,
    productTitle: lineItem.title ?? lineItem.name ?? null,
    variantTitle: lineItem.variant_title ?? null,
    sku: lineItem.sku ?? null,
    masterAssetId: configuratorPayload.master_asset_id ?? null,
    widthMm: configuratorPayload.output?.width ?? null,
    heightMm: configuratorPayload.output?.height ?? null,
    cropRatioJson: configuratorPayload.crop_ratio ?? null,
    rawPayloadJson: {
      lineItem,
      configuratorPayload,
    },
    status: 'pending',
  });
}

export function getJobs(filters) {
  return listJobs(filters);
}

export default {
  createConfiguratorJobFromLineItem,
  getJobs,
};
