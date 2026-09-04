import pool from '../db/connection.js';

function getExecutor(db) {
  return db ?? pool;
}

function normalizePackage(row) {
  return row ? { ...row } : null;
}

export async function createOrderFactoryPackage(data, db = pool) {
  const executor = getExecutor(db);
  const [result] = await executor.execute(
    `INSERT INTO order_factory_packages (
      order_id,
      shopify_order_id,
      artifact_id,
      order_number,
      status,
      package_dir,
      manifest_path,
      xml_file_name,
      file_count,
      content_checksum
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.orderId ?? data.order_id,
      String(data.shopifyOrderId ?? data.shopify_order_id),
      data.artifactId ?? data.artifact_id,
      data.orderNumber ?? data.order_number,
      data.status ?? 'ready',
      data.packageDir ?? data.package_dir,
      data.manifestPath ?? data.manifest_path,
      data.xmlFileName ?? data.xml_file_name,
      data.fileCount ?? data.file_count,
      data.contentChecksum ?? data.content_checksum,
    ]
  );

  return findOrderFactoryPackageById(result.insertId, executor);
}

export async function findOrderFactoryPackageById(id, db = pool) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    'SELECT * FROM order_factory_packages WHERE id = ? LIMIT 1',
    [id]
  );

  return normalizePackage(rows[0]);
}

export async function findOrderFactoryPackageByOrderId(
  orderId,
  db = pool,
  { forUpdate = false } = {}
) {
  const executor = getExecutor(db);
  const [rows] = await executor.execute(
    `SELECT * FROM order_factory_packages
    WHERE order_id = ? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [orderId]
  );

  return normalizePackage(rows[0]);
}

export default {
  createOrderFactoryPackage,
  findOrderFactoryPackageById,
  findOrderFactoryPackageByOrderId,
};
