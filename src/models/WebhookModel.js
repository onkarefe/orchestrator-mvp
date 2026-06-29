import pool from '../db/connection.js';

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
      duplicate_of_id,
      headers_json,
      raw_payload_json,
      error_message,
      processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.provider ?? 'shopify',
      data.topic ?? null,
      data.shopifyOrderId ?? data.shopify_order_id ?? null,
      data.deliveryId ?? data.delivery_id ?? null,
      data.status ?? 'received',
      data.processingStatus ?? data.processing_status ?? 'pending',
      tinyIntForWrite(data.hmacValid ?? data.hmac_valid ?? null),
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
    ORDER BY id ASC
    LIMIT 1`,
    [deliveryId]
  );

  return normalizeWebhook(rows[0]);
}

export async function listWebhooks({ status, limit, offset } = {}) {
  const params = [];
  const conditions = [];
  const pagination = normalizePagination(limit, offset);

  if (status !== undefined && status !== null) {
    conditions.push('status = ?');
    params.push(status);
  }

  const whereSql = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

  const [rows] = await pool.execute(
    `SELECT * FROM webhooks${whereSql} ORDER BY created_at DESC LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
    params
  );

  return rows.map(normalizeWebhook);
}

export async function updateWebhookStatus(
  id,
  status,
  errorMessage = null,
  processingStatus = status,
  db = pool
) {
  const executor = getExecutor(db);

  await executor.execute(
    'UPDATE webhooks SET status = ?, processing_status = ?, error_message = ? WHERE id = ?',
    [status, processingStatus, errorMessage, id]
  );

  return findWebhookById(id, executor);
}

export default {
  createWebhook,
  findWebhookById,
  findWebhookByDeliveryId,
  listWebhooks,
  updateWebhookStatus,
};
