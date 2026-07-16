const MAX_FACTORY_REFERENCE_LENGTH = 191;

function sanitizeReferencePart(value, fallback) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

export function buildFactoryReference({ shopifyOrderId, jobId }) {
  if (jobId === null || jobId === undefined || jobId === '') {
    throw new Error('jobId is required for factory reference');
  }

  const safeJobId = sanitizeReferencePart(jobId, 'unknown-job');
  const suffix = `-J${safeJobId}`;
  const prefix = 'WANDINI-S';
  const maxShopifyIdLength = Math.max(
    1,
    MAX_FACTORY_REFERENCE_LENGTH - prefix.length - suffix.length
  );
  const safeShopifyOrderId = sanitizeReferencePart(
    shopifyOrderId,
    'unknown-order'
  ).slice(0, maxShopifyIdLength);

  return `${prefix}${safeShopifyOrderId}${suffix}`;
}

export default {
  buildFactoryReference,
};
