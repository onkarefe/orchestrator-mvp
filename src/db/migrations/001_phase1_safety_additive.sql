-- Phase 1 production-safety additive schema changes.
-- This file intentionally avoids destructive changes and unsafe unique constraints.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schema_migrations_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'delivery_id') = 0,
  'ALTER TABLE webhooks ADD COLUMN delivery_id VARCHAR(191) NULL AFTER shopify_order_id',
  'SELECT ''skip existing column webhooks.delivery_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'processing_status') = 0,
  'ALTER TABLE webhooks ADD COLUMN processing_status VARCHAR(50) NOT NULL DEFAULT ''pending'' AFTER status',
  'SELECT ''skip existing column webhooks.processing_status'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'duplicate_of_id') = 0,
  'ALTER TABLE webhooks ADD COLUMN duplicate_of_id BIGINT UNSIGNED NULL AFTER hmac_valid',
  'SELECT ''skip existing column webhooks.duplicate_of_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND INDEX_NAME = 'idx_webhooks_processing_status') = 0,
  'ALTER TABLE webhooks ADD INDEX idx_webhooks_processing_status (processing_status)',
  'SELECT ''skip existing index idx_webhooks_processing_status'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND INDEX_NAME = 'idx_webhooks_delivery_id') = 0,
  'ALTER TABLE webhooks ADD INDEX idx_webhooks_delivery_id (delivery_id)',
  'SELECT ''skip existing index idx_webhooks_delivery_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND INDEX_NAME = 'idx_webhooks_duplicate_of_id') = 0,
  'ALTER TABLE webhooks ADD INDEX idx_webhooks_duplicate_of_id (duplicate_of_id)',
  'SELECT ''skip existing index idx_webhooks_duplicate_of_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND CONSTRAINT_NAME = 'fk_webhooks_duplicate_of_id') = 0,
  'ALTER TABLE webhooks ADD CONSTRAINT fk_webhooks_duplicate_of_id FOREIGN KEY (duplicate_of_id) REFERENCES webhooks (id) ON DELETE SET NULL',
  'SELECT ''skip existing constraint fk_webhooks_duplicate_of_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'manual_review_reason') = 0,
  'ALTER TABLE orders ADD COLUMN manual_review_reason TEXT NULL AFTER status',
  'SELECT ''skip existing column orders.manual_review_reason'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'last_error') = 0,
  'ALTER TABLE orders ADD COLUMN last_error TEXT NULL AFTER manual_review_reason',
  'SELECT ''skip existing column orders.last_error'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'validated_at') = 0,
  'ALTER TABLE orders ADD COLUMN validated_at TIMESTAMP NULL DEFAULT NULL AFTER last_error',
  'SELECT ''skip existing column orders.validated_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'artifact_ready_at') = 0,
  'ALTER TABLE orders ADD COLUMN artifact_ready_at TIMESTAMP NULL DEFAULT NULL AFTER validated_at',
  'SELECT ''skip existing column orders.artifact_ready_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'ftp_uploaded_at') = 0,
  'ALTER TABLE orders ADD COLUMN ftp_uploaded_at TIMESTAMP NULL DEFAULT NULL AFTER artifact_ready_at',
  'SELECT ''skip existing column orders.ftp_uploaded_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'factory_status') = 0,
  'ALTER TABLE orders ADD COLUMN factory_status VARCHAR(100) NULL AFTER ftp_uploaded_at',
  'SELECT ''skip existing column orders.factory_status'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'factory_order_id') = 0,
  'ALTER TABLE orders ADD COLUMN factory_order_id VARCHAR(191) NULL AFTER factory_status',
  'SELECT ''skip existing column orders.factory_order_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_orders_factory_status') = 0,
  'ALTER TABLE orders ADD INDEX idx_orders_factory_status (factory_status)',
  'SELECT ''skip existing index idx_orders_factory_status'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_orders_factory_order_id') = 0,
  'ALTER TABLE orders ADD INDEX idx_orders_factory_order_id (factory_order_id)',
  'SELECT ''skip existing index idx_orders_factory_order_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_orders_artifact_ready_at') = 0,
  'ALTER TABLE orders ADD INDEX idx_orders_artifact_ready_at (artifact_ready_at)',
  'SELECT ''skip existing index idx_orders_artifact_ready_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'shopify_order_id') = 0,
  'ALTER TABLE jobs ADD COLUMN shopify_order_id VARCHAR(191) NULL AFTER order_id',
  'SELECT ''skip existing column jobs.shopify_order_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'max_attempts') = 0,
  'ALTER TABLE jobs ADD COLUMN max_attempts INT UNSIGNED NOT NULL DEFAULT 3 AFTER attempt_count',
  'SELECT ''skip existing column jobs.max_attempts'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'locked_at') = 0,
  'ALTER TABLE jobs ADD COLUMN locked_at TIMESTAMP NULL DEFAULT NULL AFTER max_attempts',
  'SELECT ''skip existing column jobs.locked_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'locked_by') = 0,
  'ALTER TABLE jobs ADD COLUMN locked_by VARCHAR(191) NULL AFTER locked_at',
  'SELECT ''skip existing column jobs.locked_by'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'manual_review_reason') = 0,
  'ALTER TABLE jobs ADD COLUMN manual_review_reason TEXT NULL AFTER locked_by',
  'SELECT ''skip existing column jobs.manual_review_reason'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'artifact_manifest_path') = 0,
  'ALTER TABLE jobs ADD COLUMN artifact_manifest_path VARCHAR(500) NULL',
  'SELECT ''skip existing column jobs.artifact_manifest_path'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND INDEX_NAME = 'idx_jobs_shopify_order_id') = 0,
  'ALTER TABLE jobs ADD INDEX idx_jobs_shopify_order_id (shopify_order_id)',
  'SELECT ''skip existing index idx_jobs_shopify_order_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND INDEX_NAME = 'idx_jobs_shopify_order_line_item') = 0,
  'ALTER TABLE jobs ADD INDEX idx_jobs_shopify_order_line_item (shopify_order_id, shopify_line_item_id)',
  'SELECT ''skip existing index idx_jobs_shopify_order_line_item'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND INDEX_NAME = 'idx_jobs_locked_at') = 0,
  'ALTER TABLE jobs ADD INDEX idx_jobs_locked_at (locked_at)',
  'SELECT ''skip existing index idx_jobs_locked_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND INDEX_NAME = 'idx_jobs_status_locked_at') = 0,
  'ALTER TABLE jobs ADD INDEX idx_jobs_status_locked_at (status, locked_at)',
  'SELECT ''skip existing index idx_jobs_status_locked_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artifacts' AND COLUMN_NAME = 'manifest_path') = 0,
  'ALTER TABLE artifacts ADD COLUMN manifest_path VARCHAR(500) NULL AFTER file_path',
  'SELECT ''skip existing column artifacts.manifest_path'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artifacts' AND COLUMN_NAME = 'checksum') = 0,
  'ALTER TABLE artifacts ADD COLUMN checksum VARCHAR(128) NULL AFTER manifest_path',
  'SELECT ''skip existing column artifacts.checksum'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artifacts' AND COLUMN_NAME = 'file_count') = 0,
  'ALTER TABLE artifacts ADD COLUMN file_count INT UNSIGNED NULL AFTER checksum',
  'SELECT ''skip existing column artifacts.file_count'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artifacts' AND COLUMN_NAME = 'total_size_bytes') = 0,
  'ALTER TABLE artifacts ADD COLUMN total_size_bytes BIGINT UNSIGNED NULL AFTER file_count',
  'SELECT ''skip existing column artifacts.total_size_bytes'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artifacts' AND COLUMN_NAME = 'validation_status') = 0,
  'ALTER TABLE artifacts ADD COLUMN validation_status VARCHAR(50) NULL AFTER status',
  'SELECT ''skip existing column artifacts.validation_status'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artifacts' AND INDEX_NAME = 'idx_artifacts_validation_status') = 0,
  'ALTER TABLE artifacts ADD INDEX idx_artifacts_validation_status (validation_status)',
  'SELECT ''skip existing index idx_artifacts_validation_status'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artifacts' AND INDEX_NAME = 'idx_artifacts_checksum') = 0,
  'ALTER TABLE artifacts ADD INDEX idx_artifacts_checksum (checksum)',
  'SELECT ''skip existing index idx_artifacts_checksum'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS factory_callbacks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NULL,
  shopify_order_id VARCHAR(191) NULL,
  order_number VARCHAR(191) NULL,
  factory_order_id VARCHAR(191) NULL,
  delivery_id VARCHAR(191) NULL,
  status VARCHAR(100) NULL,
  raw_payload_json JSON NULL,
  headers_json JSON NULL,
  auth_valid TINYINT(1) NULL,
  duplicate_of_id BIGINT UNSIGNED NULL,
  processing_status VARCHAR(50) NOT NULL DEFAULT 'received',
  error_message TEXT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_factory_callbacks_order_id (order_id),
  KEY idx_factory_callbacks_shopify_order_id (shopify_order_id),
  KEY idx_factory_callbacks_factory_order_id (factory_order_id),
  KEY idx_factory_callbacks_delivery_id (delivery_id),
  KEY idx_factory_callbacks_status (status),
  KEY idx_factory_callbacks_processing_status (processing_status),
  KEY idx_factory_callbacks_duplicate_of_id (duplicate_of_id),
  CONSTRAINT fk_factory_callbacks_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_factory_callbacks_duplicate_of_id FOREIGN KEY (duplicate_of_id) REFERENCES factory_callbacks (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shopify_update_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NULL,
  shopify_order_id VARCHAR(191) NULL,
  task_type VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  payload_json JSON NULL,
  dry_run TINYINT(1) NOT NULL DEFAULT 1,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 3,
  locked_at TIMESTAMP NULL DEFAULT NULL,
  locked_by VARCHAR(191) NULL,
  last_error TEXT NULL,
  processed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_shopify_update_tasks_order_id (order_id),
  KEY idx_shopify_update_tasks_shopify_order_id (shopify_order_id),
  KEY idx_shopify_update_tasks_status (status),
  KEY idx_shopify_update_tasks_status_locked_at (status, locked_at),
  KEY idx_shopify_update_tasks_task_type (task_type),
  CONSTRAINT fk_shopify_update_tasks_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Duplicate prechecks required before future unique constraints are added:
--
-- 1. Webhook delivery id uniqueness:
-- SELECT delivery_id, COUNT(*) AS duplicate_count
-- FROM webhooks
-- WHERE delivery_id IS NOT NULL AND delivery_id <> ''
-- GROUP BY delivery_id
-- HAVING COUNT(*) > 1;
-- Proposed constraint after clean precheck:
-- ALTER TABLE webhooks ADD UNIQUE KEY uq_webhooks_delivery_id (delivery_id);
--
-- 2. Shopify order id uniqueness:
-- SELECT shopify_order_id, COUNT(*) AS duplicate_count
-- FROM orders
-- WHERE shopify_order_id IS NOT NULL AND shopify_order_id <> ''
-- GROUP BY shopify_order_id
-- HAVING COUNT(*) > 1;
-- Proposed constraint after clean precheck:
-- ALTER TABLE orders ADD UNIQUE KEY uq_orders_shopify_order_id (shopify_order_id);
--
-- 3. Shopify order + line item job uniqueness:
-- SELECT
--   COALESCE(j.shopify_order_id, o.shopify_order_id) AS shopify_order_id,
--   j.shopify_line_item_id,
--   COUNT(*) AS duplicate_count
-- FROM jobs j
-- LEFT JOIN orders o ON o.id = j.order_id
-- WHERE COALESCE(j.shopify_order_id, o.shopify_order_id) IS NOT NULL
--   AND COALESCE(j.shopify_order_id, o.shopify_order_id) <> ''
--   AND j.shopify_line_item_id IS NOT NULL
--   AND j.shopify_line_item_id <> ''
-- GROUP BY COALESCE(j.shopify_order_id, o.shopify_order_id), j.shopify_line_item_id
-- HAVING COUNT(*) > 1;
-- Proposed constraint after clean precheck and backfill of jobs.shopify_order_id:
-- ALTER TABLE jobs ADD UNIQUE KEY uq_jobs_shopify_order_line_item (shopify_order_id, shopify_line_item_id);
--
-- 4. Factory callback delivery id uniqueness:
-- SELECT delivery_id, COUNT(*) AS duplicate_count
-- FROM factory_callbacks
-- WHERE delivery_id IS NOT NULL AND delivery_id <> ''
-- GROUP BY delivery_id
-- HAVING COUNT(*) > 1;
-- Proposed constraint after clean precheck:
-- ALTER TABLE factory_callbacks ADD UNIQUE KEY uq_factory_callbacks_delivery_id (delivery_id);
