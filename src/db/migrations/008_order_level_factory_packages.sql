-- Order-level factory packages. Legacy job-owned task rows remain readable.
CREATE TABLE IF NOT EXISTS order_factory_packages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  shopify_order_id VARCHAR(191) NOT NULL,
  artifact_id BIGINT UNSIGNED NOT NULL,
  order_number VARCHAR(191) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ready',
  package_dir VARCHAR(500) NOT NULL,
  manifest_path VARCHAR(500) NOT NULL,
  xml_file_name VARCHAR(255) NOT NULL,
  file_count INT UNSIGNED NOT NULL,
  content_checksum VARCHAR(128) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_factory_packages_order_id (order_id),
  UNIQUE KEY uq_order_factory_packages_shopify_order_id (shopify_order_id),
  UNIQUE KEY uq_order_factory_packages_artifact_id (artifact_id),
  KEY idx_order_factory_packages_status (status),
  CONSTRAINT fk_order_factory_packages_order_id
    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_factory_packages_artifact_id
    FOREIGN KEY (artifact_id) REFERENCES artifacts (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @migration_sql = IF(
  (SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_upload_tasks' AND COLUMN_NAME = 'job_id') = 'NO',
  'ALTER TABLE factory_upload_tasks MODIFY COLUMN job_id BIGINT UNSIGNED NULL',
  'SELECT ''skip nullable factory_upload_tasks.job_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_upload_tasks' AND COLUMN_NAME = 'order_factory_package_id') = 0,
  'ALTER TABLE factory_upload_tasks ADD COLUMN order_factory_package_id BIGINT UNSIGNED NULL AFTER artifact_id',
  'SELECT ''skip existing column factory_upload_tasks.order_factory_package_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_upload_tasks' AND INDEX_NAME = 'uq_factory_upload_tasks_order_package') = 0,
  'ALTER TABLE factory_upload_tasks ADD UNIQUE KEY uq_factory_upload_tasks_order_package (order_factory_package_id)',
  'SELECT ''skip existing index uq_factory_upload_tasks_order_package'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_upload_tasks' AND CONSTRAINT_NAME = 'fk_factory_upload_tasks_order_package') = 0,
  'ALTER TABLE factory_upload_tasks ADD CONSTRAINT fk_factory_upload_tasks_order_package FOREIGN KEY (order_factory_package_id) REFERENCES order_factory_packages (id) ON DELETE RESTRICT',
  'SELECT ''skip existing constraint fk_factory_upload_tasks_order_package'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
