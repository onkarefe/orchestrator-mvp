import pool from '../db/connection.js';
import { assertFlatSqlParams } from '../db/sqlParams.js';
import {
  LINE_ITEM_CLASSIFICATIONS,
  LINE_ITEM_ROUTING_STATES,
} from '../constants/lineItemRouting.js';
import { JOB_STATUSES } from '../constants/statuses.js';

function normalizeLimit(limit) {
  const parsed = Number(limit);

  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 250)
    : 25;
}

export async function listOrdersMissingFactoryPackage({
  limit = 25,
  db = pool,
} = {}) {
  const safeLimit = normalizeLimit(limit);
  const params = [
    LINE_ITEM_CLASSIFICATIONS.WALLPAPER,
    LINE_ITEM_ROUTING_STATES.PRODUCTION_READY,
    JOB_STATUSES.COMPLETED,
    safeLimit,
  ];
  const sql = `SELECT o.id AS order_id
    FROM orders o
    WHERE o.shopify_order_id IS NOT NULL
      AND JSON_LENGTH(o.raw_payload_json, '$.line_items') > 0
      AND NOT EXISTS (
        SELECT 1 FROM order_factory_packages p WHERE p.order_id = o.id
      )
      AND EXISTS (
        SELECT 1 FROM order_line_items li WHERE li.order_id = o.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM order_line_items li
        WHERE li.order_id = o.id
          AND (li.classification <> ? OR li.routing_state <> ?)
      )
      AND (
        SELECT COUNT(*) FROM order_line_items li WHERE li.order_id = o.id
      ) = JSON_LENGTH(o.raw_payload_json, '$.line_items')
      AND (
        SELECT COUNT(*) FROM jobs j WHERE j.order_id = o.id
      ) = (
        SELECT COUNT(*) FROM order_line_items li WHERE li.order_id = o.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jobs j
        WHERE j.order_id = o.id
          AND (
            j.status <> ?
            OR (
              SELECT COUNT(*)
              FROM artifacts a
              WHERE a.job_id = j.id
                AND a.order_id = o.id
                AND a.type = 'zip'
                AND a.status = 'available'
                AND a.validation_status = 'passed'
            ) <> 1
          )
      )
    ORDER BY o.id ASC
    LIMIT ?`;

  assertFlatSqlParams(sql, params);
  const [rows] = await db.query(sql, params);

  return rows.map((row) => row.order_id);
}

export async function listOrdersWithPackageMissingFactoryTask({
  limit = 25,
  db = pool,
} = {}) {
  const safeLimit = normalizeLimit(limit);
  const params = [safeLimit];
  const sql = `SELECT p.order_id
    FROM order_factory_packages p
    INNER JOIN artifacts a ON a.id = p.artifact_id
    LEFT JOIN factory_upload_tasks t
      ON t.order_factory_package_id = p.id
    WHERE t.id IS NULL
      AND p.status = 'ready'
      AND a.order_id = p.order_id
      AND a.job_id IS NULL
      AND a.type = 'factory_package'
      AND a.status = 'available'
      AND a.validation_status = 'passed'
    ORDER BY p.order_id ASC
    LIMIT ?`;

  assertFlatSqlParams(sql, params);
  const [rows] = await db.query(sql, params);

  return rows.map((row) => row.order_id);
}

export default {
  listOrdersMissingFactoryPackage,
  listOrdersWithPackageMissingFactoryTask,
};
