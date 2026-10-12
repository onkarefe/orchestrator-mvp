-- Position-owned NEXO state. Existing package/job identities and callback history are preserved.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_line_items' AND COLUMN_NAME = 'nexo_job_id') = 0,
  'ALTER TABLE order_line_items ADD COLUMN nexo_job_id VARCHAR(191) NULL',
  'SELECT ''skip existing order_line_items.nexo_job_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_line_items' AND COLUMN_NAME = 'nexo_status') = 0,
  'ALTER TABLE order_line_items ADD COLUMN nexo_status VARCHAR(100) NULL',
  'SELECT ''skip existing order_line_items.nexo_status'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_line_items' AND COLUMN_NAME = 'nexo_parcel_service') = 0,
  'ALTER TABLE order_line_items ADD COLUMN nexo_parcel_service VARCHAR(191) NULL',
  'SELECT ''skip existing order_line_items.nexo_parcel_service'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_line_items' AND COLUMN_NAME = 'nexo_tracking_json') = 0,
  'ALTER TABLE order_line_items ADD COLUMN nexo_tracking_json JSON NULL',
  'SELECT ''skip existing order_line_items.nexo_tracking_json'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_line_items' AND INDEX_NAME = 'uq_order_line_items_nexo_job_id') = 0,
  'ALTER TABLE order_line_items ADD UNIQUE KEY uq_order_line_items_nexo_job_id (nexo_job_id)',
  'SELECT ''skip existing order_line_items.uq_order_line_items_nexo_job_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND COLUMN_NAME = 'order_line_item_id') = 0,
  'ALTER TABLE factory_callbacks ADD COLUMN order_line_item_id BIGINT UNSIGNED NULL',
  'SELECT ''skip existing factory_callbacks.order_line_item_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND INDEX_NAME = 'idx_factory_callbacks_order_line_item') = 0,
  'ALTER TABLE factory_callbacks ADD INDEX idx_factory_callbacks_order_line_item (order_line_item_id)',
  'SELECT ''skip existing factory_callbacks.idx_factory_callbacks_order_line_item'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND CONSTRAINT_NAME = 'fk_factory_callbacks_order_line_item') = 0,
  'ALTER TABLE factory_callbacks ADD CONSTRAINT fk_factory_callbacks_order_line_item FOREIGN KEY (order_line_item_id) REFERENCES order_line_items (id) ON DELETE SET NULL',
  'SELECT ''skip existing factory_callbacks.fk_factory_callbacks_order_line_item'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

