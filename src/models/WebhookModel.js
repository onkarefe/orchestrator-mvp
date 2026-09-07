import pool from '../db/connection.js';
import { WEBHOOK_PROCESSING_STATUSES } from '../constants/statuses.js';

function jsonForWrite(value) {
  if (value === undefined || value === null) {
    return null;
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseJson(value) {
  if (value === null || value === undefined || typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizePagination(limit, offset) {
  const parsedLimit = Number.parseInt(limit, 10);
  const parsedOffset = Number.parseInt(offset, 10);

  return {
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    offset: Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
  };
}

function tinyIntForWrite(value) {
  if (value === undefined || value === null) {
    return null;
  }

  return value ? 1 : 0;
}

function normalizeWebhook(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    headers_json: parseJson(row.headers_json),
    raw_payload_json: parseJson(row.raw_payload_json),
  };
}

function getExecutor(db) {
  return db ?? pool;
}

function normalizeClaimOptions({
  workerId,
  maxAttempts,
  staleLockMinutes,
} = {}) {
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 191);
  const parsedMaxAttempts = Number.parseInt(maxAttempts, 10);
  const parsedStaleLockMinutes = Number.parseInt(staleLockMinutes, 10);

  return {
    workerId: normalizedWorkerId || 'unknown-webhook-worker',
    maxAttempts:
      Number.isFinite(parsedMaxAttempts) && parsedMaxAttempts > 0
        ? parsedMaxAttempts
        : 3,
    staleLockMinutes:
      Number.isFinite(parsedStaleLockMinutes) && parsedStaleLockMinutes > 0
        ? parsedStaleLockMinutes
        : 30,
  };
}

function normalizeLimit(limit) {
  const parsed = Number.parseInt(limit, 10);

  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 250)
    : 25;
}

export async function createWebhook(data, db = pool) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `INSERT INTO webhooks (
      provider,
      topic,
      shopify_order_id,
      delivery_id,
      status,
      processing_status,
      hmac_valid,
      attempt_count,
      max_attempts,
      locked_at,
      locked_by,
      duplicate_of_id,
      headers_json,
      raw_payload_json,
      error_message,
      processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.provider ?? 'shopify',
      data.topic ?? null,
      data.shopifyOrderId ?? data.shopify_order_id ?? null,
      data.deliveryId ?? data.delivery_id ?? null,
      data.status ?? 'received',
      data.processingStatus ?? data.processing_status ?? 'pending',
      tinyIntForWrite(data.hmacValid ?? data.hmac_valid ?? null),
      data.attemptCount ?? data.attempt_count ?? 0,
      data.maxAttempts ?? data.max_attempts ?? 3,
      data.lockedAt ?? data.locked_at ?? null,
      data.lockedBy ?? data.locked_by ?? null,
      data.duplicateOfId ?? data.duplicate_of_id ?? null,
      jsonForWrite(data.headersJson ?? data.headers_json ?? null),
      jsonForWrite(data.rawPayloadJson ?? data.raw_payload_json ?? null),
      data.errorMessage ?? data.error_message ?? null,
      data.processedAt ?? data.processed_at ?? null,
    ]
  );

  return findWebhookById(result.insertId, executor);
}

export async function findWebhookById(id, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute('SELECT * FROM webhooks WHERE id = ? LIMIT 1', [id]);

  return normalizeWebhook(rows[0]);
}

export async function findWebhookByDeliveryId(deliveryId, db = pool) {
  if (deliveryId === null || deliveryId === undefined || deliveryId === '') {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM webhooks
    WHERE delivery_id = ?
      AND (hmac_valid = 1 OR hmac_valid IS NULL)
      AND processing_status IN (?, ?, ?, ?, ?)
    ORDER BY CASE processing_status
      WHEN ? THEN 0
      WHEN ? THEN 1
      WHEN ? THEN 2
      WHEN ? THEN 3
      WHEN ? THEN 4
      ELSE 5
    END, id DESC
    LIMIT 1`,
    [
      deliveryId,
      WEBHOOK_PROCESSING_STATUSES.PENDING,
      WEBHOOK_PROCESSING_STATUSES.PROCESSING,
      WEBHOOK_PROCESSING_STATUSES.PROCESSED,
      WEBHOOK_PROCESSING_STATUSES.DUPLICATE,
      WEBHOOK_PROCESSING_STATUSES.FAILED,
      WEBHOOK_PROCESSING_STATUSES.PROCESSED,
      WEBHOOK_PROCESSING_STATUSES.PROCESSING,
      WEBHOOK_PROCESSING_STATUSES.PENDING,
      WEBHOOK_PROCESSING_STATUSES.DUPLICATE,
      WEBHOOK_PROCESSING_STATUSES.FAILED,
    ]
  );

  return normalizeWebhook(rows[0]);
}

export async function claimWebhook(id, options = {}, db = pool) {
  const executor = getExecutor(db);
  const claim = normalizeClaimOptions(options);
  const [result] = await executor.execute(
    `UPDATE webhooks
    SET status = ?,
      processing_status = ?,
      attempt_count = COALESCE(attempt_count, 0) + 1,
      max_attempts = LEAST(COALESCE(max_attempts, ?), ?),
      locked_at = CURRENT_TIMESTAMP,
      locked_by = ?,
      error_message = NULL,
      processed_at = NULL
    WHERE id = ?
      AND (hmac_valid = 1 OR hmac_valid IS NULL)
      AND (
        processing_status IN (?, ?)
        OR (
          processing_status = ?
          AND (
            locked_at IS NULL
            OR locked_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)
          )
        )
      )
      AND COALESCE(attempt_count, 0) <
        LEAST(COALESCE(max_attempts, ?), ?)`,
    [
      WEBHOOK_PROCESSING_STATUSES.PROCESSING,
      WEBHOOK_PROCESSING_STATUSES.PROCESSING,
      claim.maxAttempts,
      claim.maxAttempts,
      claim.workerId,
      id,
      WEBHOOK_PROCESSING_STATUSES.PENDING,
      WEBHOOK_PROCESSING_STATUSES.FAILED,
      WEBHOOK_PROCESSING_STATUSES.PROCESSING,
      claim.staleLockMinutes,
      claim.maxAttempts,
      claim.maxAttempts,
    ]
  );

  if (result.affectedRows !== 1) {
    return null;
  }

  return findWebhookById(id, executor);
}

export async function listRecoverableWebhookIds({
  limit,
  staleLockMinutes,
  maxAttempts,
  db = pool,
} = {}) {
  const executor = getExecutor(db);
  const claim = normalizeClaimOptions({ staleLockMinutes, maxAttempts });
  const safeLimit = normalizeLimit(limit);
  const [rows] = await executor.query(
    `SELECT id
    FROM webhooks
    WHERE (hmac_valid = 1 OR hmac_valid IS NULL)
      AND (
        processing_status = ?
        OR (
          processing_status = ?
          AND (
            locked_at IS NULL
            OR locked_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)
          )
        )
      )
      AND COALESCE(attempt_count, 0) <
        LEAST(COALESCE(max_attempts, ?), ?)
    ORDER BY received_at ASC, id ASC
    LIMIT ?`,
    [
      WEBHOOK_PROCESSING_STATUSES.PENDING,
      WEBHOOK_PROCESSING_STATUSES.PROCESSING,
      claim.staleLockMinutes,
      claim.maxAttempts,
      claim.maxAttempts,
      safeLimit,
    ]
  );

  return rows.map((row) => row.id);
}

export async function markExhaustedStaleWebhooksFailed({
  staleLockMinutes,
  maxAttempts,
  db = pool,
} = {}) {
  const executor = getExecutor(db);
  const claim = normalizeClaimOptions({ staleLockMinutes, maxAttempts });
  const [result] = await executor.execute(
    `UPDATE webhooks
    SET status = ?,
      processing_status = ?,
      error_message = ?,
      locked_at = NULL,
      locked_by = NULL,
      processed_at = CURRENT_TIMESTAMP
    WHERE processing_status = ?
      AND (
        locked_at IS NULL
        OR locked_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)
      )
      AND COALESCE(attempt_count, 0) >=
        LEAST(COALESCE(max_attempts, ?), ?)`,
    [
      WEBHOOK_PROCESSING_STATUSES.FAILED,
      WEBHOOK_PROCESSING_STATUSES.FAILED,
      'stale_webhook_claim_max_attempts_exceeded',
      WEBHOOK_PROCESSING_STATUSES.PROCESSING,
      claim.staleLockMinutes,
      claim.maxAttempts,
      claim.maxAttempts,
    ]
  );

  return result.affectedRows;
}

export async function findOriginalWebhookByShopifyOrderId(
  shopifyOrderId,
  excludeId = null,
  db = pool
) {
  if (
    shopifyOrderId === null ||
    shopifyOrderId === undefined ||
    shopifyOrderId === ''
  ) {
    return null;
  }

  const executor = getExecutor(db);
  const params = [shopifyOrderId];
  let excludeSql = '';

  if (excludeId !== null && excludeId !== undefined && excludeId !== '') {
    excludeSql = ' AND id <> ?';
    params.push(excludeId);
  }

  const [rows] = await executor.execute(
    `SELECT * FROM webhooks
    WHERE shopify_order_id = ?${excludeSql}
    ORDER BY id ASC
    LIMIT 1`,
    params
  );

  return normalizeWebhook(rows[0]);
}

export async function listWebhooks({
  status,
  shopifyOrderId,
  limit,
  offset,
} = {}) {
  const params = [];
  const conditions = [];
  const pagination = normalizePagination(limit, offset);

  if (status !== undefined && status !== null) {
    conditions.push('status = ?');
    params.push(status);
  }

  if (shopifyOrderId !== undefined && shopifyOrderId !== null) {
    conditions.push('shopify_order_id = ?');
    params.push(shopifyOrderId);
  }

  const whereSql = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

  const [rows] = await pool.execute(
    `SELECT * FROM webhooks${whereSql} ORDER BY created_at DESC LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
    params
  );

  return rows.map(normalizeWebhook);
}

export async function updateClaimedWebhookStatus(
  id,
  {
    workerId,
    status,
    processingStatus = status,
    errorMessage = null,
  },
  db = pool
) {
  const executor = getExecutor(db);
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 191);
  const [result] = await executor.execute(
    `UPDATE webhooks
    SET status = ?,
      processing_status = ?,
      error_message = ?,
      locked_at = NULL,
      locked_by = NULL,
      processed_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND processing_status = ?
      AND locked_by = ?`,
    [
      status,
      processingStatus,
      errorMessage,
      id,
      WEBHOOK_PROCESSING_STATUSES.PROCESSING,
      normalizedWorkerId,
    ]
  );

  return {
    updated: result.affectedRows === 1,
    webhook:
      result.affectedRows === 1
        ? await findWebhookById(id, executor)
        : null,
  };
}

export async function updateClaimedWebhookDuplicate(
  id,
  {
    workerId,
    duplicateOfId = null,
    errorMessage = 'Duplicate Shopify order webhook',
  } = {},
  db = pool
) {
  const executor = getExecutor(db);
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 191);
  const [result] = await executor.execute(
    `UPDATE webhooks
    SET status = ?,
      processing_status = ?,
      duplicate_of_id = ?,
      error_message = ?,
      locked_at = NULL,
      locked_by = NULL,
      processed_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND processing_status = ?
      AND locked_by = ?`,
    [
      WEBHOOK_PROCESSING_STATUSES.DUPLICATE,
      WEBHOOK_PROCESSING_STATUSES.PROCESSED,
      duplicateOfId,
      errorMessage,
      id,
      WEBHOOK_PROCESSING_STATUSES.PROCESSING,
      normalizedWorkerId,
    ]
  );

  return {
    updated: result.affectedRows === 1,
    webhook:
      result.affectedRows === 1
        ? await findWebhookById(id, executor)
        : null,
  };
}

export default {
  createWebhook,
  claimWebhook,
  findWebhookById,
  findWebhookByDeliveryId,
  findOriginalWebhookByShopifyOrderId,
  listRecoverableWebhookIds,
  listWebhooks,
  markExhaustedStaleWebhooksFailed,
  updateClaimedWebhookDuplicate,
  updateClaimedWebhookStatus,
};
