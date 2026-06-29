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

function normalizeOrder(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    raw_payload_json: parseJson(row.raw_payload_json),
  };
}

function getExecutor(db) {
  return db ?? pool;
}

export async function createOrder(data, db = pool) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `INSERT INTO orders (
      shopify_order_id,
      shopify_order_number,
      customer_name,
      customer_email,
      financial_status,
      status,
      raw_payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.shopifyOrderId ?? data.shopify_order_id ?? null,
      data.shopifyOrderNumber ?? data.shopify_order_number ?? null,
      data.customerName ?? data.customer_name ?? null,
      data.customerEmail ?? data.customer_email ?? null,
      data.financialStatus ?? data.financial_status ?? null,
      data.status ?? 'received',
      jsonForWrite(data.rawPayloadJson ?? data.raw_payload_json ?? null),
    ]
  );

  return findOrderById(result.insertId, executor);
}

export async function findOrderById(id, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute('SELECT * FROM orders WHERE id = ? LIMIT 1', [id]);

  return normalizeOrder(rows[0]);
}

export async function findOrderByShopifyOrderId(shopifyOrderId, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    'SELECT * FROM orders WHERE shopify_order_id = ? LIMIT 1',
    [shopifyOrderId]
  );

  return normalizeOrder(rows[0]);
}

export async function listOrders({ status, limit, offset } = {}) {
  const params = [];
  const conditions = [];
  const pagination = normalizePagination(limit, offset);

  if (status !== undefined && status !== null) {
    conditions.push('status = ?');
    params.push(status);
  }

  const whereSql = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

  const [rows] = await pool.execute(
    `SELECT * FROM orders${whereSql} ORDER BY created_at DESC LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
    params
  );

  return rows.map(normalizeOrder);
}

export async function updateOrderStatus(id, status, db = pool) {
  const executor = getExecutor(db);

  await executor.execute('UPDATE orders SET status = ? WHERE id = ?', [status, id]);

  return findOrderById(id, executor);
}

export default {
  createOrder,
  findOrderById,
  findOrderByShopifyOrderId,
  listOrders,
  updateOrderStatus,
};
