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

function normalizeLog(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    details_json: parseJson(row.details_json),
  };
}

async function findLogById(id) {
  const [rows] = await pool.execute('SELECT * FROM logs WHERE id = ? LIMIT 1', [id]);

  return normalizeLog(rows[0]);
}

export async function createLog(data) {
  const [result] = await pool.execute(
    `INSERT INTO logs (
      scope_type,
      order_id,
      job_id,
      level,
      step,
      message,
      details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.scopeType ?? data.scope_type ?? 'system',
      data.orderId ?? data.order_id ?? null,
      data.jobId ?? data.job_id ?? null,
      data.level ?? 'info',
      data.step ?? null,
      data.message,
      jsonForWrite(data.detailsJson ?? data.details_json ?? null),
    ]
  );

  return findLogById(result.insertId);
}

export async function listLogs({ scopeType, orderId, jobId, level, limit, offset } = {}) {
  const params = [];
  const conditions = [];
  const pagination = normalizePagination(limit, offset);

  if (scopeType !== undefined && scopeType !== null) {
    conditions.push('scope_type = ?');
    params.push(scopeType);
  }

  if (orderId !== undefined && orderId !== null) {
    conditions.push('order_id = ?');
    params.push(orderId);
  }

  if (jobId !== undefined && jobId !== null) {
    conditions.push('job_id = ?');
    params.push(jobId);
  }

  if (level !== undefined && level !== null) {
    conditions.push('level = ?');
    params.push(level);
  }

  const whereSql = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

  const [rows] = await pool.execute(
    `SELECT * FROM logs${whereSql} ORDER BY created_at DESC LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
    params
  );

  return rows.map(normalizeLog);
}

export default {
  createLog,
  listLogs,
};
