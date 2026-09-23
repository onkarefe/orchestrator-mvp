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
    checkout_security_json: parseJson(row.checkout_security_json),
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
      manual_review_reason,
      raw_payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.shopifyOrderId ?? data.shopify_order_id ?? null,
      data.shopifyOrderNumber ?? data.shopify_order_number ?? null,
      data.customerName ?? data.customer_name ?? null,
      data.customerEmail ?? data.customer_email ?? null,
      data.financialStatus ?? data.financial_status ?? null,
      data.status ?? 'received',
      data.manualReviewReason ?? data.manual_review_reason ?? null,
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

export async function findOrderByIdForUpdate(id, db) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    'SELECT * FROM orders WHERE id = ? LIMIT 1 FOR UPDATE',
    [id]
  );

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

export async function findOrderByShopifyOrderIdForUpdate(shopifyOrderId, db) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    'SELECT * FROM orders WHERE shopify_order_id = ? LIMIT 1 FOR UPDATE',
    [shopifyOrderId]
  );

  return normalizeOrder(rows[0]);
}

export async function findOrderByFactoryOrderId(factoryOrderId, db = pool) {
  if (
    factoryOrderId === null ||
    factoryOrderId === undefined ||
    factoryOrderId === ''
  ) {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    'SELECT * FROM orders WHERE factory_order_id = ? LIMIT 1',
    [factoryOrderId]
  );

  return normalizeOrder(rows[0]);
}

export async function findOrderByFactoryOrderIdForUpdate(factoryOrderId, db) {
  if (
    factoryOrderId === null ||
    factoryOrderId === undefined ||
    factoryOrderId === ''
  ) {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    'SELECT * FROM orders WHERE factory_order_id = ? LIMIT 1 FOR UPDATE',
    [factoryOrderId]
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

  await executor.execute("UPDATE orders SET status = ? WHERE id = ? AND status <> 'SECURITY_HOLD'", [status, id]);

  return findOrderById(id, executor);
}

export async function updateOrderFactoryState(id, data = {}, db = pool) {
  const executor = getExecutor(db);
  const updates = [];
  const params = [];
  const factoryStatus = data.factoryStatus ?? data.factory_status;
  const factoryOrderId = data.factoryOrderId ?? data.factory_order_id;
  const status = data.status;
  const manualReviewReason =
    data.manualReviewReason ?? data.manual_review_reason;

  if (factoryStatus !== undefined) {
    updates.push('factory_status = ?');
    params.push(factoryStatus);
  }

  if (
    factoryOrderId !== undefined &&
    factoryOrderId !== null &&
    factoryOrderId !== ''
  ) {
    updates.push('factory_order_id = ?');
    params.push(factoryOrderId);
  }

  if (status !== undefined && status !== null && status !== '') {
    updates.push('status = ?');
    params.push(status);
  }

  if (
    manualReviewReason !== undefined &&
    manualReviewReason !== null &&
    manualReviewReason !== ''
  ) {
    updates.push('manual_review_reason = ?');
    params.push(manualReviewReason);
  }

  if (updates.length === 0) {
    return findOrderById(id, executor);
  }

  params.push(id);

  await executor.execute(
    `UPDATE orders SET ${updates.join(', ')} WHERE id = ? AND status <> 'SECURITY_HOLD'`,
    params
  );

  return findOrderById(id, executor);
}

export async function updateOrderManualReview(
  id,
  manualReviewReason,
  db = pool
) {
  const executor = getExecutor(db);

  await executor.execute(
    "UPDATE orders SET status = ?, manual_review_reason = ? WHERE id = ? AND status <> 'SECURITY_HOLD'",
    ['manual_review', manualReviewReason, id]
  );

  return findOrderById(id, executor);
}

export default {
  createOrder,
  findOrderById,
  findOrderByIdForUpdate,
  findOrderByFactoryOrderId,
  findOrderByFactoryOrderIdForUpdate,
  findOrderByShopifyOrderId,
  findOrderByShopifyOrderIdForUpdate,
  listOrders,
  updateOrderFactoryState,
  updateOrderStatus,
  updateOrderManualReview,
};
