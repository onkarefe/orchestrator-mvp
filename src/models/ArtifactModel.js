import pool from '../db/connection.js';

function normalizePagination(limit, offset) {
  const parsedLimit = Number.parseInt(limit, 10);
  const parsedOffset = Number.parseInt(offset, 10);

  return {
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    offset: Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
  };
}

function normalizeArtifact(row) {
  return row ? { ...row } : null;
}

function getExecutor(db) {
  return db ?? pool;
}

export async function createArtifact(data, db = pool) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `INSERT INTO artifacts (
      order_id,
      job_id,
      type,
      file_name,
      file_path,
      manifest_path,
      checksum,
      file_count,
      total_size_bytes,
      file_size,
      expires_at,
      download_count,
      status,
      validation_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.orderId ?? data.order_id ?? null,
      data.jobId ?? data.job_id ?? null,
      data.type,
      data.fileName ?? data.file_name,
      data.filePath ?? data.file_path,
      data.manifestPath ?? data.manifest_path ?? null,
      data.checksum ?? null,
      data.fileCount ?? data.file_count ?? null,
      data.totalSizeBytes ?? data.total_size_bytes ?? null,
      data.fileSize ?? data.file_size ?? null,
      data.expiresAt ?? data.expires_at ?? null,
      data.downloadCount ?? data.download_count ?? 0,
      data.status ?? 'available',
      data.validationStatus ?? data.validation_status ?? null,
    ]
  );

  return findArtifactById(result.insertId, executor);
}

export async function findArtifactById(id, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute('SELECT * FROM artifacts WHERE id = ? LIMIT 1', [id]);

  return normalizeArtifact(rows[0]);
}

export async function listArtifactsByOrderId(orderId, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM artifacts
    WHERE order_id = ? ORDER BY created_at ASC, id ASC`,
    [orderId]
  );

  return rows.map(normalizeArtifact);
}

export async function listArtifacts({ orderId, jobId, status, limit, offset } = {}) {
  const params = [];
  const conditions = [];
  const pagination = normalizePagination(limit, offset);

  if (orderId !== undefined && orderId !== null) {
    conditions.push('order_id = ?');
    params.push(orderId);
  }

  if (jobId !== undefined && jobId !== null) {
    conditions.push('job_id = ?');
    params.push(jobId);
  }

  if (status !== undefined && status !== null) {
    conditions.push('status = ?');
    params.push(status);
  }

  const whereSql = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

  const [rows] = await pool.execute(
    `SELECT * FROM artifacts${whereSql} ORDER BY created_at DESC LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
    params
  );

  return rows.map(normalizeArtifact);
}

export async function incrementDownloadCount(id) {
  await pool.execute(
    'UPDATE artifacts SET download_count = download_count + 1 WHERE id = ?',
    [id]
  );

  return findArtifactById(id);
}

export async function markArtifactDeleted(id) {
  await pool.execute('UPDATE artifacts SET status = ? WHERE id = ?', ['deleted', id]);

  return findArtifactById(id);
}

export default {
  createArtifact,
  findArtifactById,
  listArtifactsByOrderId,
  listArtifacts,
  incrementDownloadCount,
  markArtifactDeleted,
};
