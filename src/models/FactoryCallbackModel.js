import pool from '../db/connection.js';
import { FACTORY_CALLBACK_PROCESSING_STATUSES } from '../constants/statuses.js';

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

function tinyIntForWrite(value) {
  if (value === undefined || value === null) {
    return null;
  }

  return value ? 1 : 0;
}

function normalizeFactoryCallback(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    raw_payload_json: parseJson(row.raw_payload_json),
    headers_json: parseJson(row.headers_json),
  };
}

function getExecutor(db) {
  return db ?? pool;
}

function normalizePagination(limit, offset) {
  const parsedLimit = Number.parseInt(limit, 10);
  const parsedOffset = Number.parseInt(offset, 10);

  return {
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    offset: Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
  };
}

export const RECOVERABLE_NEXO_CALLBACK_REASONS = Object.freeze([
  'nexo_order_factory_package_not_found',
  'order_factory_package_not_dispatched',
]);

export async function findFactoryCallbackByIdForUpdate(id, db) {
  const [rows] = await getExecutor(db).execute(
    'SELECT * FROM factory_callbacks WHERE id = ? LIMIT 1 FOR UPDATE', [id]
  );
  return normalizeFactoryCallback(rows[0]);
}

export async function holdNexoReplayTaskConflict(id, db = pool) {
  // A concurrent successful replay must never be moved back to manual review.
  const [result] = await getExecutor(db).execute(
    `UPDATE factory_callbacks
    SET error_message = 'nexo_shopify_task_idempotency_conflict'
    WHERE id = ? AND provider = 'nexo' AND auth_valid = 1
      AND processing_status = 'manual_review'
      AND error_message IN (?, ?)`,
    [id, ...RECOVERABLE_NEXO_CALLBACK_REASONS]
  );
  return result.affectedRows === 1;
}

export async function listRecoverableNexoCallbackIds({ limit = 25, db = pool } = {}) {
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0
    ? Math.min(Number(limit), 250) : 25;
  const [rows] = await getExecutor(db).query(
    `SELECT c.id FROM factory_callbacks c
      INNER JOIN order_factory_packages p ON p.shopify_order_id = c.shopify_order_id
      INNER JOIN factory_upload_tasks t ON t.order_factory_package_id = p.id
      WHERE c.provider = 'nexo' AND c.auth_valid = 1
        AND c.processing_status = 'manual_review'
        AND c.error_message IN (?, ?)
        AND p.status = 'ready' AND t.status = 'uploaded'
      ORDER BY c.id ASC LIMIT ?`,
    [...RECOVERABLE_NEXO_CALLBACK_REASONS, safeLimit]
  );
  return rows.map((row) => row.id);
}

export async function createFactoryCallback(data, db = pool) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `INSERT INTO factory_callbacks (
      provider,
      order_id,
      job_id,
      order_factory_package_id,
      factory_reference,
      shopify_order_id,
      order_number,
      factory_order_id,
      delivery_id,
      status,
      tracking_count,
      raw_payload_json,
      headers_json,
      auth_valid,
      duplicate_of_id,
      processing_status,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.provider ?? 'factory_simulation',
      data.orderId ?? data.order_id ?? null,
      data.jobId ?? data.job_id ?? null,
      data.orderFactoryPackageId ?? data.order_factory_package_id ?? null,
      data.factoryReference ?? data.factory_reference ?? null,
      data.shopifyOrderId ?? data.shopify_order_id ?? null,
      data.orderNumber ?? data.order_number ?? null,
      data.factoryOrderId ?? data.factory_order_id ?? null,
      data.deliveryId ?? data.delivery_id ?? null,
      data.status ?? null,
      data.trackingCount ?? data.tracking_count ?? 0,
      jsonForWrite(data.rawPayloadJson ?? data.raw_payload_json ?? null),
      jsonForWrite(data.headersJson ?? data.headers_json ?? null),
      tinyIntForWrite(data.authValid ?? data.auth_valid ?? null),
      data.duplicateOfId ?? data.duplicate_of_id ?? null,
      data.processingStatus ??
        data.processing_status ??
        FACTORY_CALLBACK_PROCESSING_STATUSES.RECEIVED,
      data.errorMessage ?? data.error_message ?? null,
    ]
  );

  return findFactoryCallbackById(result.insertId, executor);
}

export async function findFactoryCallbackById(id, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    'SELECT * FROM factory_callbacks WHERE id = ? LIMIT 1',
    [id]
  );

  return normalizeFactoryCallback(rows[0]);
}

export async function listFactoryCallbacks({ orderId, limit, offset } = {}) {
  const pagination = normalizePagination(limit, offset);
  const conditions = [];
  const params = [];

  if (orderId !== undefined && orderId !== null) {
    conditions.push('order_id = ?');
    params.push(orderId);
  }

  const whereSql = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.execute(
    `SELECT * FROM factory_callbacks${whereSql}
    ORDER BY created_at DESC
    LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
    params
  );

  return rows.map(normalizeFactoryCallback);
}

export async function findOriginalFactoryCallbackByDeliveryId(
  deliveryId,
  db = pool,
  provider = 'factory_simulation'
) {
  if (deliveryId === null || deliveryId === undefined || deliveryId === '') {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM factory_callbacks
    WHERE provider = ?
      AND delivery_id = ?
      AND (auth_valid = 1 OR auth_valid IS NULL)
      AND processing_status IN (?, ?, ?)
    ORDER BY id ASC
    LIMIT 1`,
    [
      provider,
      deliveryId,
      FACTORY_CALLBACK_PROCESSING_STATUSES.RECEIVED,
      FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSING,
      FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED,
    ]
  );

  return normalizeFactoryCallback(rows[0]);
}

export async function findLatestNexoCallbackByJobAndStatus(
  { jobId, nexoJobId, status } = {},
  db = pool
) {
  if (!jobId || !nexoJobId || !status) {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM factory_callbacks
    WHERE provider = 'nexo'
      AND job_id = ?
      AND factory_order_id = ?
      AND status = ?
      AND processing_status IN (?, ?)
    ORDER BY id DESC
    LIMIT 1`,
    [
      jobId,
      nexoJobId,
      status,
      FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED,
      FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
    ]
  );

  return normalizeFactoryCallback(rows[0]);
}

export async function findLatestNexoCallbackByPackageAndStatus(
  { orderFactoryPackageId, nexoOrderId, status } = {},
  db = pool
) {
  if (!orderFactoryPackageId || !nexoOrderId || !status) {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM factory_callbacks
    WHERE provider = 'nexo'
      AND order_factory_package_id = ?
      AND factory_order_id = ?
      AND status = ?
      AND processing_status IN (?, ?)
    ORDER BY id DESC
    LIMIT 1`,
    [
      orderFactoryPackageId,
      nexoOrderId,
      status,
      FACTORY_CALLBACK_PROCESSING_STATUSES.PROCESSED,
      FACTORY_CALLBACK_PROCESSING_STATUSES.MANUAL_REVIEW,
    ]
  );

  return normalizeFactoryCallback(rows[0]);
}

export async function updateFactoryCallbackProcessingStatus(
  id,
  {
    processingStatus,
    errorMessage = null,
    orderId = null,
    jobId = null,
    orderFactoryPackageId = null,
    duplicateOfId = null,
  } = {},
  db = pool
) {
  const executor = getExecutor(db);

  await executor.execute(
    `UPDATE factory_callbacks
    SET processing_status = ?,
      error_message = ?,
      order_id = COALESCE(?, order_id),
      job_id = COALESCE(?, job_id),
      order_factory_package_id = COALESCE(?, order_factory_package_id),
      duplicate_of_id = COALESCE(?, duplicate_of_id)
    WHERE id = ?`,
    [
      processingStatus,
      errorMessage,
      orderId,
      jobId,
      orderFactoryPackageId,
      duplicateOfId,
      id,
    ]
  );

  return findFactoryCallbackById(id, executor);
}

export default {
  createFactoryCallback,
  findFactoryCallbackById,
  listFactoryCallbacks,
  findOriginalFactoryCallbackByDeliveryId,
  findLatestNexoCallbackByJobAndStatus,
  findLatestNexoCallbackByPackageAndStatus,
  updateFactoryCallbackProcessingStatus,
};
