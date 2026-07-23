const SHOPIFY_ORDER_ID_PATTERN = /^[1-9][0-9]*$/;
const SUPPORTED_PROTOCOLS = new Set(['ftp', 'ftps']);

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

export function parseFtpUploadOrderAllowlist(value) {
  const orderIds = [];
  const invalidEntries = [];
  const seen = new Set();

  for (const entry of valuesFromInput(value)) {
    if (!SHOPIFY_ORDER_ID_PATTERN.test(entry)) {
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

export function normalizeFtpProtocol(value) {
  return String(value ?? 'ftp').trim().toLowerCase();
}

export function isSupportedFtpProtocol(value) {
  return SUPPORTED_PROTOCOLS.has(normalizeFtpProtocol(value));
}

export function normalizeFtpRemoteDir(value) {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/');

  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.includes('://') ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    return null;
  }

  const collapsed = normalized.replace(/\/{2,}/g, '/');

  return collapsed.length > 1 ? collapsed.replace(/\/+$/g, '') : collapsed;
}

export function normalizeFtpTempSuffix(value) {
  const normalized = String(value ?? '').trim();

  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.includes('/') ||
    normalized.includes('\\')
  ) {
    return null;
  }

  return normalized;
}

export function isFtpUploadOrderAllowlisted(orderId, allowlist) {
  const normalizedOrderId = String(orderId ?? '').trim();

  if (!SHOPIFY_ORDER_ID_PATTERN.test(normalizedOrderId)) {
    return false;
  }

  return parseFtpUploadOrderAllowlist(allowlist).orderIds.includes(
    normalizedOrderId
  );
}

export default {
  isFtpUploadOrderAllowlisted,
  isSupportedFtpProtocol,
  normalizeFtpProtocol,
  normalizeFtpRemoteDir,
  normalizeFtpTempSuffix,
  parseFtpUploadOrderAllowlist,
};
