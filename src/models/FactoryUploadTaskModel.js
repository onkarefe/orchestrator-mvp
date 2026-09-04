import pool from '../db/connection.js';
import { assertFlatSqlParams } from '../db/sqlParams.js';
import { FACTORY_UPLOAD_TASK_STATUSES } from '../constants/statuses.js';

function getExecutor(db) {
  return db ?? pool;
}

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

function normalizeFactoryUploadTask(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    uploaded_files_json: parseJson(row.uploaded_files_json),
  };
}

function normalizePagination(limit, offset) {
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);

  return {
    limit: Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    offset:
      Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
  };
}

function normalizeClaimOptions({ workerId, maxAttempts } = {}) {
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 128);
  const parsedMaxAttempts = Number(maxAttempts);

  if (!normalizedWorkerId) {
    throw new Error('Factory upload worker ID is required');
  }

  return {
    workerId: normalizedWorkerId,
    maxAttempts:
      Number.isSafeInteger(parsedMaxAttempts) && parsedMaxAttempts > 0
        ? parsedMaxAttempts
        : 3,
  };
}

function normalizeShopifyOrderIds(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map((orderId) => String(orderId).trim())
        .filter((orderId) => /^[1-9][0-9]*$/.test(orderId))
    ),
  ].slice(0, 1000);
}

export async function createFactoryUploadTask(data, db = pool) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `INSERT INTO factory_upload_tasks (
      order_id,
      job_id,
      artifact_id,
      order_factory_package_id,
      shopify_order_id,
      factory_reference,
      status,
      upload_mode,
      remote_dir,
      uploaded_files_json,
      suppressed_reason,
      last_error,
      attempt_count,
      max_attempts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.orderId ?? data.order_id,
      data.jobId ?? data.job_id ?? null,
      data.artifactId ?? data.artifact_id,
      data.orderFactoryPackageId ?? data.order_factory_package_id ?? null,
      String(data.shopifyOrderId ?? data.shopify_order_id),
      data.factoryReference ?? data.factory_reference,
      data.status ?? FACTORY_UPLOAD_TASK_STATUSES.PENDING,
      data.uploadMode ?? data.upload_mode ?? 'files',
      data.remoteDir ?? data.remote_dir ?? null,
      jsonForWrite(data.uploadedFilesJson ?? data.uploaded_files_json ?? []),
      data.suppressedReason ?? data.suppressed_reason ?? null,
      data.lastError ?? data.last_error ?? null,
      data.attemptCount ?? data.attempt_count ?? 0,
      data.maxAttempts ?? data.max_attempts ?? 3,
    ]
  );

  return findFactoryUploadTaskById(result.insertId, executor);
}

export async function findFactoryUploadTaskById(id, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    'SELECT * FROM factory_upload_tasks WHERE id = ? LIMIT 1',
    [id]
  );

  return normalizeFactoryUploadTask(rows[0]);
}

export async function findFactoryUploadTaskByArtifactId(
  artifactId,
  db = pool
) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    'SELECT * FROM factory_upload_tasks WHERE artifact_id = ? LIMIT 1',
    [artifactId]
  );

  return normalizeFactoryUploadTask(rows[0]);
}

export async function findFactoryUploadTaskByOrderPackageId(
  orderFactoryPackageId,
  db = pool
) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM factory_upload_tasks
    WHERE order_factory_package_id = ? LIMIT 1`,
    [orderFactoryPackageId]
  );

  return normalizeFactoryUploadTask(rows[0]);
}

export async function listFactoryUploadTasks({
  jobId,
  jobIds,
  status,
  limit,
  offset,
} = {}) {
  const conditions = [];
  const params = [];
  const pagination = normalizePagination(limit, offset);
  const normalizedJobIds = [
    ...new Set(
      (Array.isArray(jobIds) ? jobIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ].slice(0, 100);

  if (jobId !== undefined && jobId !== null) {
    conditions.push('job_id = ?');
    params.push(jobId);
  } else if (normalizedJobIds.length > 0) {
    conditions.push(
      `job_id IN (${normalizedJobIds.map(() => '?').join(', ')})`
    );
    params.push(...normalizedJobIds);
  }

  if (status !== undefined && status !== null) {
    conditions.push('status = ?');
    params.push(status);
  }

  const whereSql = conditions.length
    ? ` WHERE ${conditions.join(' AND ')}`
    : '';
  params.push(pagination.limit, pagination.offset);
  const sql = `SELECT * FROM factory_upload_tasks${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?`;

  assertFlatSqlParams(sql, params);
  const [rows] = await pool.query(sql, params);

  return rows.map(normalizeFactoryUploadTask);
}

export async function markFactoryUploadTaskDisposition(
  id,
  { status, reason, workerId = null }
) {
  if (
    ![
      FACTORY_UPLOAD_TASK_STATUSES.SKIPPED,
      FACTORY_UPLOAD_TASK_STATUSES.SUPPRESSED,
    ].includes(status)
  ) {
    throw new Error('Invalid factory upload task disposition');
  }

  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 128);
  const ownershipSql = normalizedWorkerId
    ? 'status = ? AND locked_by = ?'
    : 'status IN (?, ?)';
  const ownershipParams = normalizedWorkerId
    ? [FACTORY_UPLOAD_TASK_STATUSES.UPLOADING, normalizedWorkerId]
    : [
        FACTORY_UPLOAD_TASK_STATUSES.PENDING,
        FACTORY_UPLOAD_TASK_STATUSES.FAILED,
      ];
  const [result] = await pool.execute(
    `UPDATE factory_upload_tasks
    SET status = ?,
      suppressed_reason = ?,
      last_error = NULL,
      locked_at = NULL,
      locked_by = NULL
    WHERE id = ?
      AND ${ownershipSql}`,
    [status, reason, id, ...ownershipParams]
  );

  return {
    updated: result.affectedRows === 1,
    task: await findFactoryUploadTaskById(id),
  };
}

async function claimFactoryUploadTask(
  candidate,
  { workerId, maxAttempts },
  connection
) {
  const [result] = await connection.execute(
    `UPDATE factory_upload_tasks
    SET status = ?,
      attempt_count = COALESCE(attempt_count, 0) + 1,
      max_attempts = LEAST(COALESCE(max_attempts, ?), ?),
      locked_at = CURRENT_TIMESTAMP,
      locked_by = ?,
      suppressed_reason = NULL,
      last_error = NULL
    WHERE id = ?
      AND status IN (?, ?)
      AND COALESCE(attempt_count, 0) <
        LEAST(COALESCE(max_attempts, ?), ?)`,
    [
      FACTORY_UPLOAD_TASK_STATUSES.UPLOADING,
      maxAttempts,
      maxAttempts,
      workerId,
      candidate.id,
      FACTORY_UPLOAD_TASK_STATUSES.PENDING,
      FACTORY_UPLOAD_TASK_STATUSES.FAILED,
      maxAttempts,
      maxAttempts,
    ]
  );

  return result.affectedRows === 1
    ? findFactoryUploadTaskById(candidate.id, connection)
    : null;
}

export async function claimFactoryUploadTaskById(id, options = {}) {
  const claimOptions = normalizeClaimOptions(options);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT * FROM factory_upload_tasks
      WHERE id = ?
        AND status IN (?, ?)
        AND COALESCE(attempt_count, 0) <
          LEAST(COALESCE(max_attempts, ?), ?)
      LIMIT 1
      FOR UPDATE`,
      [
        id,
        FACTORY_UPLOAD_TASK_STATUSES.PENDING,
        FACTORY_UPLOAD_TASK_STATUSES.FAILED,
        claimOptions.maxAttempts,
        claimOptions.maxAttempts,
      ]
    );
    const candidate = rows[0];

    if (!candidate) {
      await connection.commit();
      return null;
    }

    const task = await claimFactoryUploadTask(
      candidate,
      claimOptions,
      connection
    );

    await connection.commit();
    return task;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function claimNextFactoryUploadTask(options = {}) {
  const claimOptions = normalizeClaimOptions(options);
  const hasShopifyOrderFilter = options.shopifyOrderIds !== undefined;
  const shopifyOrderIds = normalizeShopifyOrderIds(options.shopifyOrderIds);

  if (hasShopifyOrderFilter && shopifyOrderIds.length === 0) {
    return null;
  }

  const shopifyOrderFilterSql = hasShopifyOrderFilter
    ? ` AND shopify_order_id IN (${shopifyOrderIds
        .map(() => '?')
        .join(', ')})`
    : '';
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT * FROM factory_upload_tasks
      WHERE status IN (?, ?)
        AND COALESCE(attempt_count, 0) <
          LEAST(COALESCE(max_attempts, ?), ?)${shopifyOrderFilterSql}
      ORDER BY created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
      [
        FACTORY_UPLOAD_TASK_STATUSES.PENDING,
        FACTORY_UPLOAD_TASK_STATUSES.FAILED,
        claimOptions.maxAttempts,
        claimOptions.maxAttempts,
        ...shopifyOrderIds,
      ]
    );
    const candidate = rows[0];

    if (!candidate) {
      await connection.commit();
      return null;
    }

    const task = await claimFactoryUploadTask(
      candidate,
      claimOptions,
      connection
    );

    await connection.commit();
    return task;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function releaseFactoryUploadTaskClaimToPending(
  id,
  { workerId }
) {
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 128);
  const [result] = await pool.execute(
    `UPDATE factory_upload_tasks
    SET status = ?,
      suppressed_reason = NULL,
      last_error = NULL,
      locked_at = NULL,
      locked_by = NULL
    WHERE id = ?
      AND status = ?
      AND locked_by = ?`,
    [
      FACTORY_UPLOAD_TASK_STATUSES.PENDING,
      id,
      FACTORY_UPLOAD_TASK_STATUSES.UPLOADING,
      normalizedWorkerId,
    ]
  );

  return {
    updated: result.affectedRows === 1,
    task: await findFactoryUploadTaskById(id),
  };
}

export async function requeueTemporarilySuppressedFactoryUploadTask(id) {
  const [result] = await pool.execute(
    `UPDATE factory_upload_tasks
    SET status = ?,
      suppressed_reason = NULL,
      last_error = NULL,
      locked_at = NULL,
      locked_by = NULL
    WHERE id = ?
      AND status = ?
      AND suppressed_reason IN (?, ?)`,
    [
      FACTORY_UPLOAD_TASK_STATUSES.PENDING,
      id,
      FACTORY_UPLOAD_TASK_STATUSES.SUPPRESSED,
      'ftp_upload_disabled',
      'order_not_allowlisted',
    ]
  );

  return {
    updated: result.affectedRows === 1,
    task: await findFactoryUploadTaskById(id),
  };
}

export async function requeueEligibleTemporarilySuppressedFactoryUploadTasks({
  shopifyOrderIds,
} = {}) {
  const normalizedOrderIds = normalizeShopifyOrderIds(shopifyOrderIds);

  if (normalizedOrderIds.length === 0) {
    return 0;
  }

  const placeholders = normalizedOrderIds.map(() => '?').join(', ');
  const [result] = await pool.execute(
    `UPDATE factory_upload_tasks
    SET status = ?,
      suppressed_reason = NULL,
      last_error = NULL,
      locked_at = NULL,
      locked_by = NULL
    WHERE status = ?
      AND suppressed_reason IN (?, ?)
      AND shopify_order_id IN (${placeholders})`,
    [
      FACTORY_UPLOAD_TASK_STATUSES.PENDING,
      FACTORY_UPLOAD_TASK_STATUSES.SUPPRESSED,
      'ftp_upload_disabled',
      'order_not_allowlisted',
      ...normalizedOrderIds,
    ]
  );

  return result.affectedRows;
}

export async function updateFactoryUploadTaskProgress(
  id,
  { workerId, uploadedFiles }
) {
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 128);
  const [result] = await pool.execute(
    `UPDATE factory_upload_tasks
    SET uploaded_files_json = ?
    WHERE id = ?
      AND status = ?
      AND locked_by = ?`,
    [
      jsonForWrite(uploadedFiles),
      id,
      FACTORY_UPLOAD_TASK_STATUSES.UPLOADING,
      normalizedWorkerId,
    ]
  );

  return result.affectedRows === 1;
}

export async function markFactoryUploadTaskUploaded(
  id,
  { workerId, uploadedFiles, remoteDir }
) {
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 128);
  const [result] = await pool.execute(
    `UPDATE factory_upload_tasks
    SET status = ?,
      remote_dir = ?,
      uploaded_files_json = ?,
      suppressed_reason = NULL,
      last_error = NULL,
      locked_at = NULL,
      locked_by = NULL,
      uploaded_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = ?
      AND locked_by = ?`,
    [
      FACTORY_UPLOAD_TASK_STATUSES.UPLOADED,
      remoteDir,
      jsonForWrite(uploadedFiles),
      id,
      FACTORY_UPLOAD_TASK_STATUSES.UPLOADING,
      normalizedWorkerId,
    ]
  );

  return {
    updated: result.affectedRows === 1,
    task:
      result.affectedRows === 1
        ? await findFactoryUploadTaskById(id)
        : null,
  };
}

export async function markFactoryUploadTaskFailed(
  id,
  { workerId, lastError, retryable = true }
) {
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 128);
  const [result] = await pool.execute(
    `UPDATE factory_upload_tasks
    SET status = ?,
      last_error = ?,
      max_attempts = CASE
        WHEN ? = 1 THEN max_attempts
        ELSE LEAST(max_attempts, attempt_count)
      END,
      locked_at = NULL,
      locked_by = NULL
    WHERE id = ?
      AND status = ?
      AND locked_by = ?`,
    [
      FACTORY_UPLOAD_TASK_STATUSES.FAILED,
      lastError,
      retryable ? 1 : 0,
      id,
      FACTORY_UPLOAD_TASK_STATUSES.UPLOADING,
      normalizedWorkerId,
    ]
  );

  return {
    updated: result.affectedRows === 1,
    task: await findFactoryUploadTaskById(id),
  };
}

export async function releaseStaleFactoryUploadTaskClaims({
  staleLockMinutes,
} = {}) {
  const parsedStaleMinutes = Number(staleLockMinutes);
  const safeStaleMinutes =
    Number.isSafeInteger(parsedStaleMinutes) && parsedStaleMinutes > 0
      ? parsedStaleMinutes
      : 30;
  const [result] = await pool.execute(
    `UPDATE factory_upload_tasks
    SET status = ?,
      last_error = ?,
      locked_at = NULL,
      locked_by = NULL
    WHERE status = ?
      AND locked_at IS NOT NULL
      AND locked_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)`,
    [
      FACTORY_UPLOAD_TASK_STATUSES.FAILED,
      'factory_upload_stale_claim_released',
      FACTORY_UPLOAD_TASK_STATUSES.UPLOADING,
      safeStaleMinutes,
    ]
  );

  return result.affectedRows;
}

export default {
  claimFactoryUploadTaskById,
  claimNextFactoryUploadTask,
  createFactoryUploadTask,
  findFactoryUploadTaskByArtifactId,
  findFactoryUploadTaskById,
  findFactoryUploadTaskByOrderPackageId,
  listFactoryUploadTasks,
  markFactoryUploadTaskDisposition,
  markFactoryUploadTaskFailed,
  markFactoryUploadTaskUploaded,
  releaseFactoryUploadTaskClaimToPending,
  releaseStaleFactoryUploadTaskClaims,
  requeueEligibleTemporarilySuppressedFactoryUploadTasks,
  requeueTemporarilySuppressedFactoryUploadTask,
  updateFactoryUploadTaskProgress,
};
