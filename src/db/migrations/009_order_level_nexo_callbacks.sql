-- Package-owned NEXO callback state. Historical job-owned callback data is preserved.
SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_factory_packages' AND COLUMN_NAME = 'nexo_order_id') = 0,
  'ALTER TABLE order_factory_packages ADD COLUMN nexo_order_id VARCHAR(191) NULL AFTER status',
  'SELECT ''skip existing column order_factory_packages.nexo_order_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_factory_packages' AND COLUMN_NAME = 'factory_status') = 0,
  'ALTER TABLE order_factory_packages ADD COLUMN factory_status VARCHAR(100) NULL AFTER nexo_order_id',
  'SELECT ''skip existing column order_factory_packages.factory_status'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_factory_packages' AND INDEX_NAME = 'uq_order_factory_packages_nexo_order_id') = 0,
  'ALTER TABLE order_factory_packages ADD UNIQUE KEY uq_order_factory_packages_nexo_order_id (nexo_order_id)',
  'SELECT ''skip existing index uq_order_factory_packages_nexo_order_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_factory_packages' AND INDEX_NAME = 'idx_order_factory_packages_factory_status') = 0,
  'ALTER TABLE order_factory_packages ADD INDEX idx_order_factory_packages_factory_status (factory_status)',
  'SELECT ''skip existing index idx_order_factory_packages_factory_status'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND COLUMN_NAME = 'order_factory_package_id') = 0,
  'ALTER TABLE factory_callbacks ADD COLUMN order_factory_package_id BIGINT UNSIGNED NULL AFTER job_id',
  'SELECT ''skip existing column factory_callbacks.order_factory_package_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND INDEX_NAME = 'idx_factory_callbacks_order_package') = 0,
  'ALTER TABLE factory_callbacks ADD INDEX idx_factory_callbacks_order_package (order_factory_package_id)',
  'SELECT ''skip existing index idx_factory_callbacks_order_package'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND CONSTRAINT_NAME = 'fk_factory_callbacks_order_package') = 0,
  'ALTER TABLE factory_callbacks ADD CONSTRAINT fk_factory_callbacks_order_package FOREIGN KEY (order_factory_package_id) REFERENCES order_factory_packages (id) ON DELETE SET NULL',
  'SELECT ''skip existing constraint fk_factory_callbacks_order_package'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
