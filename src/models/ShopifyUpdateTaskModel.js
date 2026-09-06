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
    result_json: parseJson(row.result_json),
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

function normalizeExecutorOptions({ workerId, maxAttempts, excludeIds } = {}) {
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 191);
  const parsedMaxAttempts = Number(maxAttempts);
  const normalizedExcludeIds = [
    ...new Set(
      (Array.isArray(excludeIds) ? excludeIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ].slice(0, 100);

  return {
    workerId: normalizedWorkerId,
    maxAttempts:
      Number.isSafeInteger(parsedMaxAttempts) && parsedMaxAttempts > 0
        ? parsedMaxAttempts
        : 3,
    excludeIds: normalizedExcludeIds,
  };
}

export async function createShopifyUpdateTask(data, db = pool) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `INSERT INTO shopify_update_tasks (
      order_id,
      shopify_order_id,
      task_type,
      idempotency_key,
      source_type,
      source_id,
      status,
      payload_json,
      result_json,
      dry_run,
      attempt_count,
      max_attempts,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.orderId ?? data.order_id ?? null,
      data.shopifyOrderId ?? data.shopify_order_id ?? null,
      data.taskType ?? data.task_type,
      data.idempotencyKey ?? data.idempotency_key ?? null,
      data.sourceType ?? data.source_type ?? null,
      data.sourceId ?? data.source_id ?? null,
      data.status ??
        data.processingStatus ??
        data.processing_status ??
        SHOPIFY_UPDATE_TASK_STATUSES.PENDING,
      jsonForWrite(data.payloadJson ?? data.payload_json ?? null),
      jsonForWrite(data.resultJson ?? data.result_json ?? null),
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

export async function findShopifyUpdateTaskByIdempotencyKey(
  idempotencyKey,
  db = pool
) {
  if (
    idempotencyKey === null ||
    idempotencyKey === undefined ||
    idempotencyKey === ''
  ) {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM shopify_update_tasks
    WHERE idempotency_key = ?
    LIMIT 1`,
    [String(idempotencyKey)]
  );

  return normalizeShopifyUpdateTask(rows[0]);
}

export async function listShopifyUpdateTasks({ orderId, limit, offset } = {}) {
  const pagination = normalizePagination(limit, offset);
  const params = [];
  const whereSql =
    orderId !== undefined && orderId !== null
      ? ' WHERE order_id = ?'
      : '';

  if (whereSql) {
    params.push(orderId);
  }

  const [rows] = await pool.execute(
    `SELECT * FROM shopify_update_tasks${whereSql}
    ORDER BY created_at DESC
    LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
    params
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

export async function claimNextPendingShopifyUpdateTask(options = {}) {
  const { workerId, maxAttempts, excludeIds } =
    normalizeExecutorOptions(options);

  if (!workerId) {
    throw new Error('Shopify update executor worker ID is required');
  }

  const connection = await (options.db ?? pool).getConnection();

  try {
    await connection.beginTransaction();

    const exclusionSql = excludeIds.length
      ? ` AND id NOT IN (${excludeIds.map(() => '?').join(', ')})`
      : '';

    const [rows] = await connection.execute(
      `SELECT * FROM shopify_update_tasks
      WHERE status = ?
        AND COALESCE(attempt_count, 0) <
          LEAST(COALESCE(max_attempts, ?), ?)${exclusionSql}
      ORDER BY created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
      [
        SHOPIFY_UPDATE_TASK_STATUSES.PENDING,
        maxAttempts,
        maxAttempts,
        ...excludeIds,
      ]
    );
    const candidate = rows[0];

    if (!candidate) {
      await connection.commit();
      return null;
    }

    const [result] = await connection.execute(
      `UPDATE shopify_update_tasks
      SET status = ?,
        attempt_count = COALESCE(attempt_count, 0) + 1,
        max_attempts = LEAST(COALESCE(max_attempts, ?), ?),
        locked_at = CURRENT_TIMESTAMP,
        locked_by = ?,
        last_error = NULL
      WHERE id = ?
        AND status = ?
        AND COALESCE(attempt_count, 0) <
          LEAST(COALESCE(max_attempts, ?), ?)`,
      [
        SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING,
        maxAttempts,
        maxAttempts,
        workerId,
        candidate.id,
        SHOPIFY_UPDATE_TASK_STATUSES.PENDING,
        maxAttempts,
        maxAttempts,
      ]
    );

    if (result.affectedRows !== 1) {
      await connection.rollback();
      return null;
    }

    const claimedTask = await findShopifyUpdateTaskById(
      candidate.id,
      connection
    );

    await connection.commit();
    return claimedTask;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function findOwnedShopifyUpdateTaskClaim(
  id,
  workerId,
  db = pool
) {
  const normalizedWorkerId = String(workerId ?? '').trim();

  if (!normalizedWorkerId) {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM shopify_update_tasks
    WHERE id = ?
      AND status = ?
      AND locked_by = ?
      AND locked_at IS NOT NULL
    LIMIT 1`,
    [id, SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING, normalizedWorkerId]
  );

  return normalizeShopifyUpdateTask(rows[0]);
}

export async function finalizeShopifyUpdateTask(
  id,
  { status, resultJson, lastError = null, externalId = null, workerId },
  db = pool
) {
  const timestampColumnByStatus = {
    [SHOPIFY_UPDATE_TASK_STATUSES.COMPLETED]: 'completed_at',
    [SHOPIFY_UPDATE_TASK_STATUSES.SKIPPED]: 'skipped_at',
    [SHOPIFY_UPDATE_TASK_STATUSES.FAILED]: 'failed_at',
    [SHOPIFY_UPDATE_TASK_STATUSES.MANUAL_REVIEW]: 'failed_at',
  };
  const timestampColumn = timestampColumnByStatus[status];
  const normalizedWorkerId = String(workerId ?? '').trim();

  if (!timestampColumn || !normalizedWorkerId) {
    throw new Error('Invalid Shopify update task finalization request');
  }

  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `UPDATE shopify_update_tasks
    SET status = ?,
      result_json = ?,
      last_error = ?,
      external_id = ?,
      locked_at = NULL,
      locked_by = NULL,
      processed_at = CURRENT_TIMESTAMP,
      ${timestampColumn} = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = ?
      AND locked_by = ?`,
    [
      status,
      jsonForWrite(resultJson),
      lastError,
      externalId,
      id,
      SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING,
      normalizedWorkerId,
    ]
  );

  return {
    updated: result.affectedRows === 1,
    task:
      result.affectedRows === 1
        ? await findShopifyUpdateTaskById(id, executor)
        : null,
  };
}

export async function requeueShopifyUpdateTask(
  id,
  { resultJson, lastError, workerId },
  db = pool
) {
  const normalizedWorkerId = String(workerId ?? '').trim();

  if (!normalizedWorkerId) {
    throw new Error('Shopify update executor worker ID is required');
  }

  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `UPDATE shopify_update_tasks
    SET status = ?,
      result_json = ?,
      last_error = ?,
      locked_at = NULL,
      locked_by = NULL
    WHERE id = ?
      AND status = ?
      AND locked_by = ?`,
    [
      SHOPIFY_UPDATE_TASK_STATUSES.PENDING,
      jsonForWrite(resultJson),
      lastError,
      id,
      SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING,
      normalizedWorkerId,
    ]
  );

  return result.affectedRows === 1;
}

export async function releaseStaleShopifyUpdateTaskClaims({
  staleLockMinutes,
  maxAttempts,
} = {}) {
  const parsedStaleMinutes = Number(staleLockMinutes);
  const parsedMaxAttempts = Number(maxAttempts);
  const safeStaleMinutes =
    Number.isSafeInteger(parsedStaleMinutes) && parsedStaleMinutes > 0
      ? parsedStaleMinutes
      : 30;
  const safeMaxAttempts =
    Number.isSafeInteger(parsedMaxAttempts) && parsedMaxAttempts > 0
      ? parsedMaxAttempts
      : 3;

  const [requeued] = await pool.execute(
    `UPDATE shopify_update_tasks
    SET status = ?,
      last_error = ?,
      locked_at = NULL,
      locked_by = NULL
    WHERE status = ?
      AND locked_at IS NOT NULL
      AND locked_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)
      AND COALESCE(attempt_count, 0) <
        LEAST(COALESCE(max_attempts, ?), ?)`,
    [
      SHOPIFY_UPDATE_TASK_STATUSES.PENDING,
      'shopify_update_executor_stale_claim_released',
      SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING,
      safeStaleMinutes,
      safeMaxAttempts,
      safeMaxAttempts,
    ]
  );
  const [failed] = await pool.execute(
    `UPDATE shopify_update_tasks
    SET status = ?,
      last_error = ?,
      locked_at = NULL,
      locked_by = NULL,
      processed_at = CURRENT_TIMESTAMP,
      failed_at = CURRENT_TIMESTAMP
    WHERE status = ?
      AND locked_at IS NOT NULL
      AND locked_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)
      AND COALESCE(attempt_count, 0) >=
        LEAST(COALESCE(max_attempts, ?), ?)`,
    [
      SHOPIFY_UPDATE_TASK_STATUSES.FAILED,
      'shopify_update_executor_stale_claim_max_attempts_exceeded',
      SHOPIFY_UPDATE_TASK_STATUSES.PROCESSING,
      safeStaleMinutes,
      safeMaxAttempts,
      safeMaxAttempts,
    ]
  );

  return {
    requeued: requeued.affectedRows,
    failed: failed.affectedRows,
  };
}

export default {
  createShopifyUpdateTask,
  findShopifyUpdateTaskById,
  findShopifyUpdateTaskByIdempotencyKey,
  listShopifyUpdateTasks,
  findShopifyUpdateTaskByFactoryCallbackId,
  claimNextPendingShopifyUpdateTask,
  findOwnedShopifyUpdateTaskClaim,
  finalizeShopifyUpdateTask,
  requeueShopifyUpdateTask,
  releaseStaleShopifyUpdateTaskClaims,
};
