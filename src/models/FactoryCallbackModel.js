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

export async function createFactoryCallback(data, db = pool) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `INSERT INTO factory_callbacks (
      order_id,
      shopify_order_id,
      order_number,
      factory_order_id,
      delivery_id,
      status,
      raw_payload_json,
      headers_json,
      auth_valid,
      duplicate_of_id,
      processing_status,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.orderId ?? data.order_id ?? null,
      data.shopifyOrderId ?? data.shopify_order_id ?? null,
      data.orderNumber ?? data.order_number ?? null,
      data.factoryOrderId ?? data.factory_order_id ?? null,
      data.deliveryId ?? data.delivery_id ?? null,
      data.status ?? null,
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

export async function findOriginalFactoryCallbackByDeliveryId(
  deliveryId,
  db = pool
) {
  if (deliveryId === null || deliveryId === undefined || deliveryId === '') {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM factory_callbacks
    WHERE delivery_id = ?
      AND (auth_valid = 1 OR auth_valid IS NULL)
      AND processing_status <> ?
    ORDER BY id ASC
    LIMIT 1`,
    [deliveryId, FACTORY_CALLBACK_PROCESSING_STATUSES.FAILED]
  );

  return normalizeFactoryCallback(rows[0]);
}

export async function updateFactoryCallbackProcessingStatus(
  id,
  {
    processingStatus,
    errorMessage = null,
    orderId = null,
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
      duplicate_of_id = COALESCE(?, duplicate_of_id)
    WHERE id = ?`,
    [processingStatus, errorMessage, orderId, duplicateOfId, id]
  );

  return findFactoryCallbackById(id, executor);
}

export default {
  createFactoryCallback,
  findFactoryCallbackById,
  findOriginalFactoryCallbackByDeliveryId,
  updateFactoryCallbackProcessingStatus,
};
