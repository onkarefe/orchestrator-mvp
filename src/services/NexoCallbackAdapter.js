import crypto from 'node:crypto';

import { ORDER_STATUSES } from '../constants/statuses.js';

const MAX_IDENTIFIER_LENGTH = 191;
const MAX_STATUS_LENGTH = 100;
const MAX_TIMESTAMP_LENGTH = 191;
const MAX_TRACKING_URL_LENGTH = 2048;

export const NEXO_CALLBACK_STATUSES = Object.freeze([
  'accepted',
  'ready_to_print',
  'printed',
  'cancelled',
  'error',
  'shipped',
]);

const NEXO_CALLBACK_STATUS_SET = new Set(NEXO_CALLBACK_STATUSES);

export const NEXO_STATUS_TO_ORDER_STATUS = Object.freeze({
  accepted: ORDER_STATUSES.FACTORY_RECEIVED,
  ready_to_print: ORDER_STATUSES.PRODUCTION_STARTED,
  printed: ORDER_STATUSES.PRODUCTION_COMPLETED,
  cancelled: ORDER_STATUSES.MANUAL_REVIEW,
  error: ORDER_STATUSES.MANUAL_REVIEW,
  shipped: ORDER_STATUSES.SHIPPED,
});

const NEXO_PROGRESS_RANK = Object.freeze({
  accepted: 0,
  ready_to_print: 1,
  printed: 2,
  shipped: 3,
});

const NEXO_TERMINAL_EXCEPTION_STATUSES = new Set(['cancelled', 'error']);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPayloadObject(payload) {
  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload);
}

function normalizeRequiredString(
  payload,
  fieldName,
  errors,
  { maxLength = MAX_IDENTIFIER_LENGTH, keepRaw = false } = {}
) {
  if (!hasOwn(payload, fieldName)) {
    errors.push(`${fieldName}_required`);
    return null;
  }

  const value = payload[fieldName];

  if (typeof value !== 'string') {
    errors.push(`${fieldName}_must_be_string`);
    return null;
  }

  if (!value.trim()) {
    errors.push(`${fieldName}_required`);
    return null;
  }

  if (value.length > maxLength) {
    errors.push(`${fieldName}_too_long`);
    return null;
  }

  return keepRaw ? value : value.trim();
}

function normalizeNexoJobId(payload, errors) {
  if (!hasOwn(payload, 'job_id')) {
    errors.push('job_id_required');
    return null;
  }

  const value = payload.job_id;

  if (typeof value !== 'string' && typeof value !== 'number') {
    errors.push('job_id_must_be_string_or_number');
    return null;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    errors.push('job_id_must_be_finite');
    return null;
  }

  const normalized = String(value).trim();

  if (!normalized) {
    errors.push('job_id_required');
    return null;
  }

  if (normalized.length > MAX_IDENTIFIER_LENGTH) {
    errors.push('job_id_too_long');
    return null;
  }

  return normalized;
}

function normalizeNexoStatus(payload, errors) {
  const status = normalizeRequiredString(payload, 'status', errors, {
    maxLength: MAX_STATUS_LENGTH,
  })?.toLowerCase();

  if (!status) {
    return null;
  }

  if (!NEXO_CALLBACK_STATUS_SET.has(status)) {
    errors.push('unsupported_nexo_status');
  }

  return status;
}

function normalizeParcelService(payload, errors) {
  if (!hasOwn(payload, 'parcel_service')) {
    return null;
  }

  if (typeof payload.parcel_service !== 'string') {
    errors.push('parcel_service_must_be_string');
    return null;
  }

  if (payload.parcel_service.length > MAX_IDENTIFIER_LENGTH) {
    errors.push('parcel_service_too_long');
    return null;
  }

  return payload.parcel_service.trim() || null;
}

function normalizeTrackingNumber(value, index, errors) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    errors.push(`tracking_numbers_${index}_number_must_be_string_or_number`);
    return null;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    errors.push(`tracking_numbers_${index}_number_must_be_finite`);
    return null;
  }

  const normalized = String(value).trim();

  if (!normalized) {
    errors.push(`tracking_numbers_${index}_number_required`);
    return null;
  }

  if (normalized.length > MAX_IDENTIFIER_LENGTH) {
    errors.push(`tracking_numbers_${index}_number_too_long`);
    return null;
  }

  return normalized;
}

function normalizeTrackingNumbers(payload, status, errors) {
  if (status !== 'shipped') {
    return [];
  }

  if (!Array.isArray(payload.tracking_numbers) || payload.tracking_numbers.length === 0) {
    errors.push('tracking_numbers_required_for_shipped');
    return [];
  }

  const trackingByNumber = new Map();

  for (const [index, tracking] of payload.tracking_numbers.entries()) {
    if (!isPayloadObject(tracking)) {
      errors.push(`tracking_numbers_${index}_must_be_object`);
      continue;
    }

    if (!hasOwn(tracking, 'number')) {
      errors.push(`tracking_numbers_${index}_number_required`);
      continue;
    }

    const number = normalizeTrackingNumber(tracking.number, index, errors);
    let url = null;

    if (hasOwn(tracking, 'url')) {
      if (typeof tracking.url !== 'string') {
        errors.push(`tracking_numbers_${index}_url_must_be_string`);
      } else if (tracking.url.length > MAX_TRACKING_URL_LENGTH) {
        errors.push(`tracking_numbers_${index}_url_too_long`);
      } else {
        url = tracking.url;
      }
    }

    if (!number) {
      continue;
    }

    const existing = trackingByNumber.get(number);

    if (!existing) {
      trackingByNumber.set(number, { number, url });
      continue;
    }

    if (!existing.url && url) {
      existing.url = url;
      continue;
    }

    if (existing.url && url && existing.url !== url) {
      errors.push(`tracking_numbers_${index}_conflicting_url_for_number`);
    }
  }

  return [...trackingByNumber.values()];
}

export function parseNexoFactoryReference(reference) {
  if (typeof reference !== 'string') {
    return null;
  }

  const match = reference.match(/^WANDINI-S([1-9][0-9]*)-J([1-9][0-9]*)$/);

  if (!match) {
    return null;
  }

  return {
    shopifyOrderId: match[1],
    internalJobId: match[2],
  };
}

export function validateNexoCallbackPayload(payload) {
  const errors = [];

  if (!isPayloadObject(payload)) {
    return {
      ok: false,
      errors: ['payload_must_be_object'],
      normalized: {
        timestamp: null,
        nexoJobId: null,
        reference: null,
        referenceParts: null,
        status: null,
        parcelService: null,
        trackingNumbers: [],
      },
    };
  }

  const timestamp = normalizeRequiredString(payload, 'timestamp', errors, {
    maxLength: MAX_TIMESTAMP_LENGTH,
    keepRaw: true,
  });
  const nexoJobId = normalizeNexoJobId(payload, errors);
  const reference = normalizeRequiredString(payload, 'reference', errors);
  const referenceParts = parseNexoFactoryReference(reference);

  if (reference && !referenceParts) {
    errors.push('reference_invalid_format');
  }

  const status = normalizeNexoStatus(payload, errors);
  const parcelService = normalizeParcelService(payload, errors);
  const trackingNumbers = normalizeTrackingNumbers(payload, status, errors);

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      timestamp,
      nexoJobId,
      reference,
      referenceParts,
      status,
      parcelService,
      trackingNumbers,
    },
  };
}

export function getNexoOrderStatus(nexoStatus) {
  return NEXO_STATUS_TO_ORDER_STATUS[nexoStatus] ?? null;
}

export function getNexoStatusSequenceIssue(previousStatus, nextStatus) {
  if (!NEXO_CALLBACK_STATUS_SET.has(nextStatus)) {
    return 'unsupported_nexo_status';
  }

  if (!previousStatus) {
    return nextStatus === 'accepted' || NEXO_TERMINAL_EXCEPTION_STATUSES.has(nextStatus)
      ? null
      : 'nexo_status_out_of_order';
  }

  if (!NEXO_CALLBACK_STATUS_SET.has(previousStatus)) {
    return 'unknown_existing_nexo_status';
  }

  if (previousStatus === nextStatus) {
    return null;
  }

  if (NEXO_TERMINAL_EXCEPTION_STATUSES.has(previousStatus)) {
    return 'nexo_status_after_terminal_status';
  }

  if (nextStatus === 'cancelled' || nextStatus === 'error') {
    return previousStatus === 'shipped' ? 'nexo_status_after_shipped' : null;
  }

  const previousRank = NEXO_PROGRESS_RANK[previousStatus];
  const nextRank = NEXO_PROGRESS_RANK[nextStatus];

  if (previousRank === undefined || nextRank !== previousRank + 1) {
    return 'nexo_status_out_of_order';
  }

  return null;
}

function normalizeHeaders(headers) {
  const result = {};

  for (const [name, value] of Object.entries(headers ?? {})) {
    result[String(name).toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }

  return result;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareCanonicalString(left, right) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

export function canonicalizeNexoTrackingPayload(normalized) {
  if (normalized?.status !== 'shipped') {
    return null;
  }

  const trackingNumbers = [...(normalized.trackingNumbers ?? [])]
    .map(({ number, url = null }) => ({ number, url }))
    .sort((left, right) => {
      const numberCompare = compareCanonicalString(left.number, right.number);

      if (numberCompare !== 0) {
        return numberCompare;
      }

      return compareCanonicalString(
        String(left.url ?? ''),
        String(right.url ?? '')
      );
    });

  return {
    parcelService: normalized.parcelService ?? null,
    trackingNumbers,
  };
}

export function getNexoDeliveryIdentity({ headers, normalized }) {
  const normalizedHeaders = normalizeHeaders(headers);
  const explicitHeaders = [
    'x-nexo-callback-id',
    'x-nexo-event-id',
    'x-request-id',
  ];

  for (const headerName of explicitHeaders) {
    const headerValue = String(normalizedHeaders[headerName] ?? '').trim();

    if (headerValue) {
      return {
        deliveryId: `nexo-header:${sha256(headerValue)}`,
        source: 'header',
        headerName,
      };
    }
  }

  const canonicalEvent = JSON.stringify({
    provider: 'nexo',
    nexoJobId: normalized?.nexoJobId ?? null,
    reference: normalized?.reference ?? null,
    status: normalized?.status ?? null,
    timestamp: normalized?.timestamp ?? null,
    tracking: canonicalizeNexoTrackingPayload(normalized),
  });

  return {
    deliveryId: `nexo-event:${sha256(canonicalEvent)}`,
    source: 'derived',
    headerName: null,
  };
}

export function buildNexoShopifyTaskIdempotencyKey({
  jobId,
  reference,
  taskType,
  trackingNumbers = [],
}) {
  const baseIdentity = `${String(jobId)}\0${String(reference)}`;

  if (taskType === 'order_produced') {
    return `nexo:produced:${sha256(baseIdentity)}`;
  }

  if (taskType === 'order_shipped') {
    const trackingSet = [...new Set(trackingNumbers.map(({ number }) => number))]
      .sort(compareCanonicalString);

    return `nexo:shipped:${sha256(`${baseIdentity}\0${JSON.stringify(trackingSet)}`)}`;
  }

  return null;
}

export default {
  NEXO_CALLBACK_STATUSES,
  NEXO_STATUS_TO_ORDER_STATUS,
  buildNexoShopifyTaskIdempotencyKey,
  canonicalizeNexoTrackingPayload,
  getNexoDeliveryIdentity,
  getNexoOrderStatus,
  getNexoStatusSequenceIssue,
  parseNexoFactoryReference,
  validateNexoCallbackPayload,
};
