import pool from '../db/connection.js';
import { createArtifact } from './ArtifactModel.js';
import { assertFlatSqlParams } from '../db/sqlParams.js';
import { JOB_STATUSES } from '../constants/statuses.js';
import { buildFactoryReference } from '../utils/factoryReference.js';

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
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);

  return {
    limit: Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    offset:
      Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
  };
}

function normalizeJob(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    crop_ratio_json: parseJson(row.crop_ratio_json),
    raw_payload_json: parseJson(row.raw_payload_json),
  };
}

function getExecutor(db) {
  return db ?? pool;
}

function normalizeClaimOptions({ workerId, maxAttempts } = {}) {
  const normalizedWorkerId = String(workerId ?? '').trim().slice(0, 191);
  const parsedMaxAttempts = Number.parseInt(maxAttempts, 10);

  return {
    workerId: normalizedWorkerId || 'unknown-worker',
    maxAttempts:
      Number.isFinite(parsedMaxAttempts) && parsedMaxAttempts > 0
        ? parsedMaxAttempts
        : 3,
  };
}

export async function createJob(data, db = pool) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `INSERT INTO jobs (
      order_id,
      shopify_order_id,
      shopify_line_item_id,
      product_title,
      variant_title,
      sku,
      master_asset_id,
      width_mm,
      height_mm,
      crop_ratio_json,
      panel_count,
      panel_width_cm,
      status,
      attempt_count,
      manual_review_reason,
      last_error,
      raw_payload_json,
      started_at,
      completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.orderId ?? data.order_id ?? null,
      data.shopifyOrderId ?? data.shopify_order_id ?? null,
      data.shopifyLineItemId ?? data.shopify_line_item_id ?? null,
      data.productTitle ?? data.product_title ?? null,
      data.variantTitle ?? data.variant_title ?? null,
      data.sku ?? null,
      data.masterAssetId ?? data.master_asset_id ?? null,
      data.widthMm ?? data.width_mm ?? null,
      data.heightMm ?? data.height_mm ?? null,
      jsonForWrite(data.cropRatioJson ?? data.crop_ratio_json ?? null),
      data.panelCount ?? data.panel_count ?? null,
      data.panelWidthCm ?? data.panel_width_cm ?? null,
      data.status ?? 'pending',
      data.attemptCount ?? data.attempt_count ?? 0,
      data.manualReviewReason ?? data.manual_review_reason ?? null,
      data.lastError ?? data.last_error ?? null,
      jsonForWrite(data.rawPayloadJson ?? data.raw_payload_json ?? null),
      data.startedAt ?? data.started_at ?? null,
      data.completedAt ?? data.completed_at ?? null,
    ]
  );

  const shopifyOrderId =
    data.shopifyOrderId ?? data.shopify_order_id ?? null;

  if (shopifyOrderId !== null && shopifyOrderId !== undefined && shopifyOrderId !== '') {
    const factoryReference = buildFactoryReference({
      shopifyOrderId,
      jobId: result.insertId,
    });

    await executor.execute(
      `UPDATE jobs
      SET factory_reference = COALESCE(factory_reference, ?)
      WHERE id = ?`,
      [factoryReference, result.insertId]
    );
  }

  return findJobById(result.insertId, executor);
}

export async function findJobById(id, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute('SELECT * FROM jobs WHERE id = ? LIMIT 1', [id]);

  return normalizeJob(rows[0]);
}

export async function findJobByShopifyOrderAndLineItem(
  shopifyOrderId,
  shopifyLineItemId,
  db = pool
) {
  if (
    shopifyOrderId === null ||
    shopifyOrderId === undefined ||
    shopifyOrderId === '' ||
    shopifyLineItemId === null ||
    shopifyLineItemId === undefined ||
    shopifyLineItemId === ''
  ) {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM jobs
    WHERE shopify_order_id = ?
      AND shopify_line_item_id = ?
    LIMIT 1`,
    [shopifyOrderId, shopifyLineItemId]
  );

  return normalizeJob(rows[0]);
}

export async function findJobByFactoryReferenceForUpdate(factoryReference, db) {
  if (!factoryReference) {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM jobs
    WHERE factory_reference = ?
    LIMIT 1
    FOR UPDATE`,
    [factoryReference]
  );

  return normalizeJob(rows[0]);
}

export async function findJobByNexoJobIdForUpdate(nexoJobId, db) {
  if (!nexoJobId) {
    return null;
  }

  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM jobs
    WHERE nexo_job_id = ?
    LIMIT 1
    FOR UPDATE`,
    [nexoJobId]
  );

  return normalizeJob(rows[0]);
}

export async function updateJobNexoState(
  id,
  { nexoJobId, nexoStatus },
  db = pool
) {
  const executor = getExecutor(db);

  await executor.execute(
    `UPDATE jobs
    SET nexo_job_id = COALESCE(NULLIF(nexo_job_id, ''), ?),
      nexo_status = ?
    WHERE id = ?`,
    [nexoJobId, nexoStatus, id]
  );

  return findJobById(id, executor);
}

export async function listJobs({ status, orderId, limit, offset } = {}) {
  const params = [];
  const conditions = [];
  const pagination = normalizePagination(limit, offset);

  if (status !== undefined && status !== null) {
    conditions.push('status = ?');
    params.push(status);
  }

  if (orderId !== undefined && orderId !== null) {
    conditions.push('order_id = ?');
    params.push(orderId);
  }

  const whereSql = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  params.push(pagination.limit, pagination.offset);
  const sql = `SELECT * FROM jobs${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`;

  assertFlatSqlParams(sql, params);

  // Use mysql2's escaped text-query path for dynamic list reads. Staging's
  // server-prepared path rejects the otherwise valid LIMIT/OFFSET bindings.
  const [rows] = await pool.query(sql, params);

  return rows.map(normalizeJob);
}

export async function listJobsByOrderId(orderId, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM jobs
    WHERE order_id = ? ORDER BY created_at ASC, id ASC`,
    [orderId]
  );

  return rows.map(normalizeJob);
}

export async function claimNextPendingJob(options = {}) {
  const { workerId, maxAttempts } = normalizeClaimOptions(options);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT * FROM jobs
      WHERE status = ?
        AND COALESCE(attempt_count, 0) < COALESCE(max_attempts, ?)
      ORDER BY created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE`,
      [JOB_STATUSES.PENDING, maxAttempts]
    );

    const candidate = rows[0];

    if (!candidate) {
      await connection.commit();
      return null;
    }

    const [result] = await connection.execute(
      `UPDATE jobs
      SET status = ?,
        attempt_count = COALESCE(attempt_count, 0) + 1,
        max_attempts = COALESCE(max_attempts, ?),
        locked_at = CURRENT_TIMESTAMP,
        locked_by = ?,
        started_at = CURRENT_TIMESTAMP,
        last_error = NULL
      WHERE id = ?
        AND status = ?
        AND COALESCE(attempt_count, 0) < COALESCE(max_attempts, ?)`,
      [
        JOB_STATUSES.PROCESSING,
        maxAttempts,
        workerId,
        candidate.id,
        JOB_STATUSES.PENDING,
        maxAttempts,
      ]
    );

    if (result.affectedRows !== 1) {
      await connection.rollback();
      return null;
    }

    const claimedJob = await findJobById(candidate.id, connection);

    await connection.commit();
    return claimedJob;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function claimPendingJobById(id, options = {}) {
  const { workerId, maxAttempts } = normalizeClaimOptions(options);
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [result] = await connection.execute(
      `UPDATE jobs
      SET status = ?,
        attempt_count = COALESCE(attempt_count, 0) + 1,
        max_attempts = COALESCE(max_attempts, ?),
        locked_at = CURRENT_TIMESTAMP,
        locked_by = ?,
        started_at = CURRENT_TIMESTAMP,
        last_error = NULL
      WHERE id = ?
        AND status = ?
        AND COALESCE(attempt_count, 0) < COALESCE(max_attempts, ?)`,
      [
        JOB_STATUSES.PROCESSING,
        maxAttempts,
        workerId,
        id,
        JOB_STATUSES.PENDING,
        maxAttempts,
      ]
    );

    if (result.affectedRows !== 1) {
      await connection.commit();
      transactionStarted = false;
      return null;
    }

    const claimedJob = await findJobById(id, connection);
    await connection.commit();
    transactionStarted = false;
    return claimedJob;
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateJobStatus(id, status) {
  await pool.execute('UPDATE jobs SET status = ? WHERE id = ?', [status, id]);

  return findJobById(id);
}

export async function updateJobManualReview(
  id,
  manualReviewReason,
  db = pool
) {
  const executor = getExecutor(db);

  await executor.execute(
    'UPDATE jobs SET status = ?, manual_review_reason = ? WHERE id = ?',
    ['manual_review', manualReviewReason, id]
  );

  return findJobById(id, executor);
}

export async function markJobProcessing(id) {
  await pool.execute(
    'UPDATE jobs SET status = ?, started_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JOB_STATUSES.PROCESSING, id]
  );

  return findJobById(id);
}

function claimLostError() {
  const error = new Error('Render job claim is no longer owned');
  error.code = 'JOB_CLAIM_LOST';
  return error;
}

function claimParams(claim) {
  const attempt = Number(claim?.attempt_count);
  if (!claim?.locked_by || !Number.isSafeInteger(attempt) || attempt <= 0) {
    throw claimLostError();
  }
  // The attempt fences a re-claim even if the worker identity is reused.
  return [JOB_STATUSES.PROCESSING, claim.locked_by, attempt];
}

async function mutateClaimedJob(id, assignments, values, claim, db) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    'UPDATE jobs SET ' + assignments +
      ' WHERE id = ? AND status = ? AND locked_by = ? AND attempt_count = ?',
    [...values, id, ...claimParams(claim)]
  );
  if (result.affectedRows !== 1) {
    throw claimLostError();
  }
  return findJobById(id, executor);
}

export async function markJobCompleted(id, claim, db = pool) {
  return mutateClaimedJob(id,
    'status = ?, locked_at = NULL, locked_by = NULL, completed_at = CURRENT_TIMESTAMP',
    [JOB_STATUSES.COMPLETED], claim, db);
}

export async function markJobCompletedWithArtifactManifest(
  id, artifactManifestPath, claim, db = pool
) {
  return mutateClaimedJob(id,
    'status = ?, artifact_manifest_path = ?, locked_at = NULL, locked_by = NULL, completed_at = CURRENT_TIMESTAMP',
    [JOB_STATUSES.COMPLETED, artifactManifestPath], claim, db);
}

export async function markJobFailed(id, errorMessage, claim, db = pool) {
  return mutateClaimedJob(id,
    'status = ?, last_error = ?, locked_at = NULL, locked_by = NULL, completed_at = CURRENT_TIMESTAMP',
    [JOB_STATUSES.FAILED, errorMessage], claim, db);
}

export async function markJobPendingForRetry(id, errorMessage, claim, db = pool) {
  return mutateClaimedJob(id,
    'status = ?, last_error = ?, locked_at = NULL, locked_by = NULL',
    [JOB_STATUSES.PENDING, errorMessage], claim, db);
}

export async function publishCompletedJobArtifact(job, data, db = pool) {
  const ownership = claimParams(job);
  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.execute(
      'SELECT * FROM jobs WHERE id = ? AND status = ? AND locked_by = ? AND attempt_count = ? FOR UPDATE',
      [job.id, ...ownership]
    );
    if (rows.length !== 1) {
      throw claimLostError();
    }
    if (!data.manifestPath || String(data.orderId) !== String(rows[0].order_id)) {
      throw new Error('Render artifact output identity is invalid');
    }
    const artifact = await createArtifact(
      { ...data, jobId: job.id, orderId: rows[0].order_id }, connection
    );
    await markJobCompletedWithArtifactManifest(
      job.id, data.manifestPath, job, connection
    );
    await connection.commit();
    transactionStarted = false;
    return artifact;
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }
    throw error;
  } finally {
    connection.release();
  }
}

export async function incrementJobAttempt(id) {
  await pool.execute('UPDATE jobs SET attempt_count = attempt_count + 1 WHERE id = ?', [id]);

  return findJobById(id);
}

export async function releaseStaleProcessingJobs({
  staleLockMinutes,
  maxAttempts,
  retryErrorMessage = 'stale_lock_released',
  finalErrorMessage = 'stale_processing_lock_max_attempts_exceeded',
  db = pool,
} = {}) {
  const parsedStaleLockMinutes = Number.parseInt(staleLockMinutes, 10);
  const parsedMaxAttempts = Number.parseInt(maxAttempts, 10);
  const safeStaleLockMinutes =
    Number.isFinite(parsedStaleLockMinutes) && parsedStaleLockMinutes > 0
      ? parsedStaleLockMinutes
      : 30;
  const safeMaxAttempts =
    Number.isFinite(parsedMaxAttempts) && parsedMaxAttempts > 0
      ? parsedMaxAttempts
      : 3;

  const executor = getExecutor(db);
  const [requeuedResult] = await executor.execute(
    `UPDATE jobs
    SET status = ?,
      last_error = ?,
      locked_at = NULL,
      locked_by = NULL
    WHERE status = ?
      AND locked_at IS NOT NULL
      AND locked_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)
      AND COALESCE(attempt_count, 0) < COALESCE(max_attempts, ?)`,
    [
      JOB_STATUSES.PENDING,
      retryErrorMessage,
      JOB_STATUSES.PROCESSING,
      safeStaleLockMinutes,
      safeMaxAttempts,
    ]
  );

  const [failedResult] = await executor.execute(
    `UPDATE jobs
    SET status = ?,
      last_error = ?,
      locked_at = NULL,
      locked_by = NULL,
      completed_at = CURRENT_TIMESTAMP
    WHERE status = ?
      AND locked_at IS NOT NULL
      AND locked_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? MINUTE)
      AND COALESCE(attempt_count, 0) >= COALESCE(max_attempts, ?)`,
    [
      JOB_STATUSES.FAILED,
      finalErrorMessage,
      JOB_STATUSES.PROCESSING,
      safeStaleLockMinutes,
      safeMaxAttempts,
    ]
  );

  return {
    requeued: requeuedResult.affectedRows,
    failed: failedResult.affectedRows,
  };
}

export default {
  createJob,
  findJobById,
  findJobByShopifyOrderAndLineItem,
  findJobByFactoryReferenceForUpdate,
  findJobByNexoJobIdForUpdate,
  updateJobNexoState,
  listJobs,
  listJobsByOrderId,
  claimNextPendingJob,
  claimPendingJobById,
  updateJobStatus,
  updateJobManualReview,
  markJobProcessing,
  markJobCompleted,
  markJobCompletedWithArtifactManifest,
  publishCompletedJobArtifact,
  markJobFailed,
  markJobPendingForRetry,
  incrementJobAttempt,
  releaseStaleProcessingJobs,
};
