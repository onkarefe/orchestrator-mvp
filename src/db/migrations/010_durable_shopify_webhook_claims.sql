-- Durable, bounded Shopify webhook processing claims.
-- Additive only, existing rows remain recoverable with safe defaults.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'attempt_count') = 0,
  'ALTER TABLE webhooks ADD COLUMN attempt_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER hmac_valid',
  'SELECT ''skip existing column webhooks.attempt_count'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'max_attempts') = 0,
  'ALTER TABLE webhooks ADD COLUMN max_attempts INT UNSIGNED NOT NULL DEFAULT 3 AFTER attempt_count',
  'SELECT ''skip existing column webhooks.max_attempts'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'locked_at') = 0,
  'ALTER TABLE webhooks ADD COLUMN locked_at TIMESTAMP NULL DEFAULT NULL AFTER max_attempts',
  'SELECT ''skip existing column webhooks.locked_at'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'locked_by') = 0,
  'ALTER TABLE webhooks ADD COLUMN locked_by VARCHAR(191) NULL AFTER locked_at',
  'SELECT ''skip existing column webhooks.locked_by'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND INDEX_NAME = 'idx_webhooks_processing_lock') = 0,
  'ALTER TABLE webhooks ADD INDEX idx_webhooks_processing_lock (processing_status, locked_at)',
  'SELECT ''skip existing index idx_webhooks_processing_lock'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
