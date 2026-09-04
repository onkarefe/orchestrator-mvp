import { sanitizePathSegment } from './jobWorkspace.js';

function positiveInteger(value, name) {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function buildWallpaperPanelFileName({
  shopifyOrderId,
  sourcePosition,
  panelNumber,
}) {
  if (
    shopifyOrderId === null ||
    shopifyOrderId === undefined ||
    String(shopifyOrderId).trim() === ''
  ) {
    throw new Error('shopifyOrderId is required');
  }

  const persistedPosition = Number(sourcePosition);

  if (!Number.isSafeInteger(persistedPosition) || persistedPosition < 0) {
    throw new Error('sourcePosition must be a non-negative integer');
  }

  const safeOrderId = sanitizePathSegment(shopifyOrderId, 'shopify-order');
  const position = String(persistedPosition + 1).padStart(2, '0');
  const variant = String(positiveInteger(panelNumber, 'panelNumber')).padStart(
    2,
    '0'
  );

  return `w-${safeOrderId}-p${position}-v${variant}.pdf`;
}

export function buildOrderFactoryIdentity(shopifyOrderId) {
  if (
    shopifyOrderId === null ||
    shopifyOrderId === undefined ||
    String(shopifyOrderId).trim() === ''
  ) {
    throw new Error('shopifyOrderId is required');
  }

  const safeOrderId = sanitizePathSegment(shopifyOrderId, 'shopify-order');

  return `WANDINI-S${safeOrderId}`;
}

export default {
  buildOrderFactoryIdentity,
  buildWallpaperPanelFileName,
};
