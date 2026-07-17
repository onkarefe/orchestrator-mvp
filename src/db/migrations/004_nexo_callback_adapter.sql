-- NEXO callback adapter identity and audit fields.
-- Additive only. Apply this migration before restarting code that includes the
-- NEXO adapter because the models reference these columns directly.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'nexo_job_id') = 0,
  'ALTER TABLE jobs ADD COLUMN nexo_job_id VARCHAR(191) NULL AFTER factory_reference',
  'SELECT ''skip existing column jobs.nexo_job_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'nexo_status') = 0,
  'ALTER TABLE jobs ADD COLUMN nexo_status VARCHAR(100) NULL AFTER nexo_job_id',
  'SELECT ''skip existing column jobs.nexo_status'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND COLUMN_NAME = 'job_id') = 0,
  'ALTER TABLE factory_callbacks ADD COLUMN job_id BIGINT UNSIGNED NULL AFTER order_id',
  'SELECT ''skip existing column factory_callbacks.job_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND COLUMN_NAME = 'factory_reference') = 0,
  'ALTER TABLE factory_callbacks ADD COLUMN factory_reference VARCHAR(191) NULL AFTER job_id',
  'SELECT ''skip existing column factory_callbacks.factory_reference'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND COLUMN_NAME = 'tracking_count') = 0,
  'ALTER TABLE factory_callbacks ADD COLUMN tracking_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER status',
  'SELECT ''skip existing column factory_callbacks.tracking_count'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND INDEX_NAME = 'uq_jobs_nexo_job_id') = 0,
  'ALTER TABLE jobs ADD UNIQUE KEY uq_jobs_nexo_job_id (nexo_job_id)',
  'SELECT ''skip existing index uq_jobs_nexo_job_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND INDEX_NAME = 'idx_factory_callbacks_job_id') = 0,
  'ALTER TABLE factory_callbacks ADD INDEX idx_factory_callbacks_job_id (job_id)',
  'SELECT ''skip existing index idx_factory_callbacks_job_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND INDEX_NAME = 'idx_factory_callbacks_factory_reference') = 0,
  'ALTER TABLE factory_callbacks ADD INDEX idx_factory_callbacks_factory_reference (factory_reference)',
  'SELECT ''skip existing index idx_factory_callbacks_factory_reference'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'factory_callbacks' AND CONSTRAINT_NAME = 'fk_factory_callbacks_job_id') = 0,
  'ALTER TABLE factory_callbacks ADD CONSTRAINT fk_factory_callbacks_job_id FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL',
  'SELECT ''skip existing constraint fk_factory_callbacks_job_id'''
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Optional precheck. This should return zero rows before the unique index is
-- added if nexo_job_id was populated manually before running this migration:
--
-- SELECT nexo_job_id, COUNT(*) AS duplicate_count
-- FROM jobs
-- WHERE nexo_job_id IS NOT NULL
-- GROUP BY nexo_job_id HAVING COUNT(*) > 1;
