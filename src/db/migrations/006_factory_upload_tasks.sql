-- Factory FTP upload task ledger.
-- Additive only. Apply before running code that includes the FTP upload worker.

CREATE TABLE IF NOT EXISTS factory_upload_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  job_id BIGINT UNSIGNED NOT NULL,
  artifact_id BIGINT UNSIGNED NOT NULL,
  shopify_order_id VARCHAR(64) NOT NULL,
  factory_reference VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  upload_mode VARCHAR(32) NOT NULL DEFAULT 'files',
  remote_dir VARCHAR(1024) NULL,
  uploaded_files_json LONGTEXT NULL,
  suppressed_reason VARCHAR(255) NULL,
  last_error LONGTEXT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  locked_at DATETIME NULL,
  locked_by VARCHAR(128) NULL,
  uploaded_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_factory_upload_tasks_artifact_id (artifact_id),
  KEY idx_factory_upload_tasks_job_id (job_id),
  KEY idx_factory_upload_tasks_order_id (order_id),
  KEY idx_factory_upload_tasks_shopify_order_id (shopify_order_id),
  KEY idx_factory_upload_tasks_factory_reference (factory_reference),
  KEY idx_factory_upload_tasks_status (status),
  CONSTRAINT fk_factory_upload_tasks_order_id
    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_factory_upload_tasks_job_id
    FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE RESTRICT,
  CONSTRAINT fk_factory_upload_tasks_artifact_id
    FOREIGN KEY (artifact_id) REFERENCES artifacts (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
