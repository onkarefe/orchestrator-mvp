import pool from '../db/connection.js';
import { SHOPIFY_UPDATE_TASK_STATUSES } from '../constants/statuses.js';

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

function normalizeShopifyUpdateTask(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    dry_run: Boolean(row.dry_run),
    payload_json: parseJson(row.payload_json),
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

export async function createShopifyUpdateTask(data, db = pool) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `INSERT INTO shopify_update_tasks (
      order_id,
      shopify_order_id,
      task_type,
      status,
      payload_json,
      dry_run,
      attempt_count,
      max_attempts,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.orderId ?? data.order_id ?? null,
      data.shopifyOrderId ?? data.shopify_order_id ?? null,
      data.taskType ?? data.task_type,
      data.status ??
        data.processingStatus ??
        data.processing_status ??
        SHOPIFY_UPDATE_TASK_STATUSES.PENDING,
      jsonForWrite(data.payloadJson ?? data.payload_json ?? null),
      tinyIntForWrite(data.dryRun ?? data.dry_run ?? true),
      data.attemptCount ?? data.attempt_count ?? 0,
      data.maxAttempts ?? data.max_attempts ?? 3,
      data.lastError ?? data.last_error ?? null,
    ]
  );

  return findShopifyUpdateTaskById(result.insertId, executor);
}

export async function findShopifyUpdateTaskById(id, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    'SELECT * FROM shopify_update_tasks WHERE id = ? LIMIT 1',
    [id]
  );

  return normalizeShopifyUpdateTask(rows[0]);
}

export async function listShopifyUpdateTasks({ limit, offset } = {}) {
  const pagination = normalizePagination(limit, offset);
  const [rows] = await pool.execute(
    `SELECT * FROM shopify_update_tasks
    ORDER BY created_at DESC
    LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
  );

  return rows.map(normalizeShopifyUpdateTask);
}

export async function findShopifyUpdateTaskByFactoryCallbackId(
  factoryCallbackId,
  db = pool
) {
  if (
    factoryCallbackId === null ||
    factoryCallbackId === undefined ||
    factoryCallbackId === ''
  ) {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM shopify_update_tasks
    WHERE JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.factoryCallbackId')) = ?
    ORDER BY id ASC
    LIMIT 1`,
    [String(factoryCallbackId)]
  );

  return normalizeShopifyUpdateTask(rows[0]);
}

export default {
  createShopifyUpdateTask,
  findShopifyUpdateTaskById,
  listShopifyUpdateTasks,
  findShopifyUpdateTaskByFactoryCallbackId,
};
