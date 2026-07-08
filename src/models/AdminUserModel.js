import pool from '../db/connection.js';

function normalizeAdminUser(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    is_active: Boolean(row.is_active),
  };
}

export async function findAdminUserByUsername(username) {
  const [rows] = await pool.execute(
    'SELECT * FROM admin_users WHERE username = ? LIMIT 1',
    [username]
  );

  return normalizeAdminUser(rows[0]);
}

export async function updateAdminUserLastLoginAt(id) {
  await pool.execute(
    'UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?',
    [id]
  );
}

export default {
  findAdminUserByUsername,
  updateAdminUserLastLoginAt,
};
