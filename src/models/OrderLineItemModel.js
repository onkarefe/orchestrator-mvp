import pool from '../db/connection.js';
import { isDuplicateKeyError } from '../db/errors.js';

function getExecutor(db) {
  return db ?? pool;
}

function normalizeOrderLineItem(row) {
  return row ? { ...row } : null;
}

function requiredIdentity(value, name) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new Error(`${name} is required for order line-item persistence`);
  }

  return String(value).trim();
}

export async function findOrderLineItemByIdentity(
  shopifyOrderId,
  shopifyLineItemId,
  sourcePosition,
  db = pool
) {
  const executor = getExecutor(db);
  const normalizedLineItemId =
    shopifyLineItemId === null || shopifyLineItemId === undefined ||
    String(shopifyLineItemId).trim() === ''
      ? null
      : String(shopifyLineItemId).trim();
  const [rows] = normalizedLineItemId
    ? await executor.execute(
        `SELECT * FROM order_line_items
        WHERE shopify_order_id = ? AND shopify_line_item_id = ? LIMIT 1`,
        [String(shopifyOrderId), normalizedLineItemId]
      )
    : await executor.execute(
        `SELECT * FROM order_line_items
        WHERE shopify_order_id = ? AND source_position = ? LIMIT 1`,
        [String(shopifyOrderId), sourcePosition]
      );

  return normalizeOrderLineItem(rows[0]);
}

export async function createOrderLineItem(data, db = pool) {
  const executor = getExecutor(db);
  const shopifyOrderId = requiredIdentity(
    data.shopifyOrderId ?? data.shopify_order_id,
    'Shopify order id'
  );
  const rawLineItemId = data.shopifyLineItemId ?? data.shopify_line_item_id;
  const shopifyLineItemId =
    rawLineItemId === null || rawLineItemId === undefined ||
    String(rawLineItemId).trim() === ''
      ? null
      : String(rawLineItemId).trim();
  const sourcePosition = Number(data.sourcePosition ?? data.source_position);

  if (!Number.isSafeInteger(sourcePosition) || sourcePosition < 0) {
    throw new Error('Source position is required for order line-item persistence');
  }

  try {
    const [result] = await executor.execute(
      `INSERT INTO order_line_items (
        order_id,
        shopify_order_id,
        shopify_line_item_id,
        source_position,
        sku,
        title,
        quantity,
        classification,
        routing_state,
        routing_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.orderId ?? data.order_id,
        shopifyOrderId,
        shopifyLineItemId,
        sourcePosition,
        data.sku ?? null,
        data.title ?? data.name ?? null,
        data.quantity ?? 0,
        data.classification,
        data.routingState ?? data.routing_state,
        data.routingReason ?? data.routing_reason ?? null,
      ]
    );

    const [rows] = await executor.execute(
      'SELECT * FROM order_line_items WHERE id = ? LIMIT 1',
      [result.insertId]
    );

    return { lineItem: normalizeOrderLineItem(rows[0]), created: true };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const existing = await findOrderLineItemByIdentity(
      shopifyOrderId,
      shopifyLineItemId,
      sourcePosition,
      executor
    );

    if (!existing) {
      throw error;
    }

    return { lineItem: existing, created: false };
  }
}

export async function listOrderLineItemsByOrderId(orderId, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM order_line_items
    WHERE order_id = ? ORDER BY source_position ASC, id ASC`,
    [orderId]
  );

  return rows.map(normalizeOrderLineItem);
}

export default {
  createOrderLineItem,
  findOrderLineItemByIdentity,
  listOrderLineItemsByOrderId,
};
