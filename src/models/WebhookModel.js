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

export async function createWebhook(data) {
  const [result] = await pool.execute(
    `INSERT INTO webhooks (
      provider,
      topic,
      shopify_order_id,
      status,
      hmac_valid,
      headers_json,
      raw_payload_json,
      error_message,
      processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.provider ?? 'shopify',
      data.topic ?? null,
      data.shopifyOrderId ?? data.shopify_order_id ?? null,
      data.status ?? 'received',
      tinyIntForWrite(data.hmacValid ?? data.hmac_valid ?? null),
      jsonForWrite(data.headersJson ?? data.headers_json ?? null),
      jsonForWrite(data.rawPayloadJson ?? data.raw_payload_json ?? null),
      data.errorMessage ?? data.error_message ?? null,
      data.processedAt ?? data.processed_at ?? null,
    ]
  );

  return findWebhookById(result.insertId);
}

export async function findWebhookById(id) {
  const [rows] = await pool.execute('SELECT * FROM webhooks WHERE id = ? LIMIT 1', [id]);

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
  params.push(pagination.limit, pagination.offset);

  const [rows] = await pool.execute(
    `SELECT * FROM webhooks${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    params
  );

  return rows.map(normalizeWebhook);
}

export async function updateWebhookStatus(id, status, errorMessage = null) {
  await pool.execute(
    'UPDATE webhooks SET status = ?, error_message = ? WHERE id = ?',
    [status, errorMessage, id]
  );

  return findWebhookById(id);
}

export default {
  createWebhook,
  findWebhookById,
  listWebhooks,
  updateWebhookStatus,
};
