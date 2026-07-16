-- Phase 2 safety foundation.
-- Additive only. This migration intentionally fails on unsafe duplicate data
-- when a unique index is created. Run the documented prechecks first.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'factory_reference') = 0,
  'ALTER TABLE jobs ADD COLUMN factory_reference VARCHAR(191) NULL AFTER shopify_line_item_id',
  'SELECT ''skip existing column jobs.factory_reference'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'dedupe_delivery_id') = 0,
  'ALTER TABLE webhooks ADD COLUMN dedupe_delivery_id VARCHAR(191) GENERATED ALWAYS AS (CASE WHEN delivery_id IS NOT NULL AND delivery_id <> '''' AND (hmac_valid = 1 OR hmac_valid IS NULL) AND processing_status IN (''pending'', ''processing'', ''processed'') THEN delivery_id ELSE NULL END) STORED AFTER hmac_valid',
  'SELECT ''skip existing column webhooks.dedupe_delivery_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND COLUMN_NAME = 'provider') = 0,
  'ALTER TABLE factory_callbacks ADD COLUMN provider VARCHAR(100) NOT NULL DEFAULT ''factory_simulation'' AFTER id',
  'SELECT ''skip existing column factory_callbacks.provider'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND COLUMN_NAME = 'dedupe_delivery_id') = 0,
  'ALTER TABLE factory_callbacks ADD COLUMN dedupe_delivery_id VARCHAR(191) GENERATED ALWAYS AS (CASE WHEN delivery_id IS NOT NULL AND delivery_id <> '''' AND (auth_valid = 1 OR auth_valid IS NULL) AND processing_status IN (''received'', ''processing'', ''processed'') THEN delivery_id ELSE NULL END) STORED AFTER processing_status',
  'SELECT ''skip existing column factory_callbacks.dedupe_delivery_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND COLUMN_NAME = 'idempotency_key') = 0,
  'ALTER TABLE shopify_update_tasks ADD COLUMN idempotency_key VARCHAR(191) NULL AFTER task_type',
  'SELECT ''skip existing column shopify_update_tasks.idempotency_key'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND COLUMN_NAME = 'source_type') = 0,
  'ALTER TABLE shopify_update_tasks ADD COLUMN source_type VARCHAR(100) NULL AFTER idempotency_key',
  'SELECT ''skip existing column shopify_update_tasks.source_type'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND COLUMN_NAME = 'source_id') = 0,
  'ALTER TABLE shopify_update_tasks ADD COLUMN source_id VARCHAR(191) NULL AFTER source_type',
  'SELECT ''skip existing column shopify_update_tasks.source_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND COLUMN_NAME = 'result_json') = 0,
  'ALTER TABLE shopify_update_tasks ADD COLUMN result_json JSON NULL AFTER payload_json',
  'SELECT ''skip existing column shopify_update_tasks.result_json'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- The following unique indexes are deliberately added only after the columns.
-- MySQL permits multiple NULL values in unique indexes, so legacy rows without
-- factory references/idempotency keys remain compatible.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'uq_orders_shopify_order_id') = 0,
  'ALTER TABLE orders ADD UNIQUE KEY uq_orders_shopify_order_id (shopify_order_id)',
  'SELECT ''skip existing index uq_orders_shopify_order_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND INDEX_NAME = 'uq_jobs_shopify_order_line_item') = 0,
  'ALTER TABLE jobs ADD UNIQUE KEY uq_jobs_shopify_order_line_item (shopify_order_id, shopify_line_item_id)',
  'SELECT ''skip existing index uq_jobs_shopify_order_line_item'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND INDEX_NAME = 'uq_jobs_factory_reference') = 0,
  'ALTER TABLE jobs ADD UNIQUE KEY uq_jobs_factory_reference (factory_reference)',
  'SELECT ''skip existing index uq_jobs_factory_reference'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND INDEX_NAME = 'uq_webhooks_provider_dedupe_delivery') = 0,
  'ALTER TABLE webhooks ADD UNIQUE KEY uq_webhooks_provider_dedupe_delivery (provider, dedupe_delivery_id)',
  'SELECT ''skip existing index uq_webhooks_provider_dedupe_delivery'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND INDEX_NAME = 'uq_factory_callbacks_provider_dedupe_delivery') = 0,
  'ALTER TABLE factory_callbacks ADD UNIQUE KEY uq_factory_callbacks_provider_dedupe_delivery (provider, dedupe_delivery_id)',
  'SELECT ''skip existing index uq_factory_callbacks_provider_dedupe_delivery'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND INDEX_NAME = 'uq_shopify_update_tasks_idempotency_key') = 0,
  'ALTER TABLE shopify_update_tasks ADD UNIQUE KEY uq_shopify_update_tasks_idempotency_key (idempotency_key)',
  'SELECT ''skip existing index uq_shopify_update_tasks_idempotency_key'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND INDEX_NAME = 'idx_shopify_update_tasks_source') = 0,
  'ALTER TABLE shopify_update_tasks ADD INDEX idx_shopify_update_tasks_source (source_type, source_id)',
  'SELECT ''skip existing index idx_shopify_update_tasks_source'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Required pre-migration duplicate checks (all must return zero rows):
--
-- SELECT shopify_order_id, COUNT(*) AS duplicate_count
-- FROM orders
-- WHERE shopify_order_id IS NOT NULL
-- GROUP BY shopify_order_id HAVING COUNT(*) > 1;
--
-- SELECT shopify_order_id, shopify_line_item_id, COUNT(*) AS duplicate_count
-- FROM jobs
-- WHERE shopify_order_id IS NOT NULL
--   AND shopify_line_item_id IS NOT NULL
-- GROUP BY shopify_order_id, shopify_line_item_id HAVING COUNT(*) > 1;
--
-- SELECT provider, delivery_id, COUNT(*) AS duplicate_count
-- FROM webhooks
-- WHERE delivery_id IS NOT NULL AND delivery_id <> ''
--   AND (hmac_valid = 1 OR hmac_valid IS NULL)
--   AND processing_status IN ('pending', 'processing', 'processed')
-- GROUP BY provider, delivery_id HAVING COUNT(*) > 1;
--
-- SELECT 'factory_simulation' AS provider,
--   delivery_id, COUNT(*) AS duplicate_count
-- FROM factory_callbacks
-- WHERE delivery_id IS NOT NULL AND delivery_id <> ''
--   AND (auth_valid = 1 OR auth_valid IS NULL)
--   AND processing_status IN ('received', 'processing', 'processed')
-- GROUP BY delivery_id
-- HAVING COUNT(*) > 1;
