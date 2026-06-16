import pool from '../db/connection.js';

function jsonForWrite(value) {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.stringify(value);
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

function normalizeSetting(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    setting_value: parseJson(row.setting_value),
  };
}

export async function getSetting(key) {
  const [rows] = await pool.execute(
    'SELECT * FROM settings WHERE setting_key = ? LIMIT 1',
    [key]
  );

  return normalizeSetting(rows[0]);
}

export async function setSetting(key, value) {
  await pool.execute(
    `INSERT INTO settings (setting_key, setting_value)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE
      setting_value = VALUES(setting_value),
      updated_at = CURRENT_TIMESTAMP`,
    [key, jsonForWrite(value)]
  );

  return getSetting(key);
}

export async function listSettings() {
  const [rows] = await pool.execute('SELECT * FROM settings ORDER BY setting_key ASC');

  return rows.map(normalizeSetting);
}

export default {
  getSetting,
  setSetting,
  listSettings,
};
