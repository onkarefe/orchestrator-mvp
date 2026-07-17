const SHOPIFY_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const SHOPIFY_API_VERSION_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const SHOPIFY_NUMERIC_ID_PATTERN = /^[1-9][0-9]*$/;

function valuesFromInput(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (value === undefined || value === null || String(value).trim() === '') {
    return [];
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeShopifyShopDomain(value) {
  const normalized = String(value ?? '').trim().toLowerCase();

  if (
    !normalized ||
    normalized.length > 253 ||
    !SHOPIFY_DOMAIN_PATTERN.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

export function normalizeShopifyAdminApiVersion(value) {
  const normalized = String(value ?? '').trim();

  return SHOPIFY_API_VERSION_PATTERN.test(normalized) ? normalized : null;
}

export function parseShopifyWriteOrderAllowlist(value) {
  const orderIds = [];
  const invalidEntries = [];
  const seen = new Set();

  for (const entry of valuesFromInput(value)) {
    if (!SHOPIFY_NUMERIC_ID_PATTERN.test(entry)) {
      invalidEntries.push(entry);
      continue;
    }

    if (!seen.has(entry)) {
      seen.add(entry);
      orderIds.push(entry);
    }
  }

  return {
    orderIds,
    invalidEntries,
  };
}

export function normalizeShopifyNumericId(value) {
  const normalized = String(value ?? '').trim();

  return SHOPIFY_NUMERIC_ID_PATTERN.test(normalized) ? normalized : null;
}

export function isShopifyOrderAllowlisted(orderId, allowlist) {
  const normalizedOrderId = normalizeShopifyNumericId(orderId);

  if (!normalizedOrderId) {
    return false;
  }

  return parseShopifyWriteOrderAllowlist(allowlist).orderIds.includes(
    normalizedOrderId
  );
}

export function buildShopifyAdminUrl({ shopDomain, path }) {
  const normalizedDomain = normalizeShopifyShopDomain(shopDomain);
  const normalizedPath = String(path ?? '');

  if (!normalizedDomain) {
    throw new Error('Invalid Shopify shop domain');
  }

  if (!normalizedPath.startsWith('/') || normalizedPath.startsWith('//')) {
    throw new Error('Invalid Shopify Admin API path');
  }

  return `https://${normalizedDomain}${normalizedPath}`;
}

export default {
  buildShopifyAdminUrl,
  isShopifyOrderAllowlisted,
  normalizeShopifyAdminApiVersion,
  normalizeShopifyNumericId,
  normalizeShopifyShopDomain,
  parseShopifyWriteOrderAllowlist,
};
