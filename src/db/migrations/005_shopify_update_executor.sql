-- Shopify Admin API executor audit fields.
-- Additive only. Apply before running the one-shot Shopify update executor.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND COLUMN_NAME = 'completed_at') = 0,
  'ALTER TABLE shopify_update_tasks ADD COLUMN completed_at TIMESTAMP NULL DEFAULT NULL AFTER processed_at',
  'SELECT ''skip existing column shopify_update_tasks.completed_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND COLUMN_NAME = 'failed_at') = 0,
  'ALTER TABLE shopify_update_tasks ADD COLUMN failed_at TIMESTAMP NULL DEFAULT NULL AFTER completed_at',
  'SELECT ''skip existing column shopify_update_tasks.failed_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND COLUMN_NAME = 'skipped_at') = 0,
  'ALTER TABLE shopify_update_tasks ADD COLUMN skipped_at TIMESTAMP NULL DEFAULT NULL AFTER failed_at',
  'SELECT ''skip existing column shopify_update_tasks.skipped_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND COLUMN_NAME = 'external_id') = 0,
  'ALTER TABLE shopify_update_tasks ADD COLUMN external_id VARCHAR(191) NULL AFTER skipped_at',
  'SELECT ''skip existing column shopify_update_tasks.external_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_update_tasks' AND INDEX_NAME = 'idx_shopify_update_tasks_external_id') = 0,
  'ALTER TABLE shopify_update_tasks ADD INDEX idx_shopify_update_tasks_external_id (external_id)',
  'SELECT ''skip existing index idx_shopify_update_tasks_external_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
