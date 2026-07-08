import pool from '../db/connection.js';

function normalizeAdminSession(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    admin_user_id: row.admin_user_id,
    expires_at: row.expires_at,
    created_at: row.created_at,
    user: {
      id: row.user_id,
      username: row.username,
      is_active: Boolean(row.user_is_active),
      last_login_at: row.last_login_at,
      created_at: row.user_created_at,
      updated_at: row.user_updated_at,
    },
  };
}

export async function createAdminSession({ adminUserId, tokenHash, expiresAt }) {
  const [result] = await pool.execute(
    `INSERT INTO admin_sessions (
      admin_user_id,
      token_hash,
      expires_at
    ) VALUES (?, ?, ?)`,
    [adminUserId, tokenHash, expiresAt]
  );

  return result.insertId;
}

export async function findValidAdminSessionByTokenHash(tokenHash) {
  const [rows] = await pool.execute(
    `SELECT
      s.id,
      s.admin_user_id,
      s.expires_at,
      s.created_at,
      u.id AS user_id,
      u.username,
      u.is_active AS user_is_active,
      u.last_login_at,
      u.created_at AS user_created_at,
      u.updated_at AS user_updated_at
    FROM admin_sessions s
    INNER JOIN admin_users u ON u.id = s.admin_user_id
    WHERE s.token_hash = ?
      AND s.expires_at > CURRENT_TIMESTAMP
      AND u.is_active = 1
    LIMIT 1`,
    [tokenHash]
  );

  return normalizeAdminSession(rows[0]);
}

export async function deleteAdminSessionByTokenHash(tokenHash) {
  await pool.execute('DELETE FROM admin_sessions WHERE token_hash = ?', [
    tokenHash,
  ]);
}

export default {
  createAdminSession,
  deleteAdminSessionByTokenHash,
  findValidAdminSessionByTokenHash,
};
