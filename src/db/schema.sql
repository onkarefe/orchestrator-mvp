CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shopify_order_id VARCHAR(191) NULL,
  shopify_order_number VARCHAR(191) NULL,
  customer_name VARCHAR(191) NULL,
  customer_email VARCHAR(191) NULL,
  financial_status VARCHAR(50) NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'received',
  raw_payload_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_orders_shopify_order_id (shopify_order_id),
  KEY idx_orders_shopify_order_number (shopify_order_number),
  KEY idx_orders_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NULL,
  shopify_line_item_id VARCHAR(191) NULL,
  product_title VARCHAR(255) NULL,
  variant_title VARCHAR(255) NULL,
  sku VARCHAR(191) NULL,
  master_asset_id VARCHAR(255) NULL,
  width_mm DECIMAL(10,2) NULL,
  height_mm DECIMAL(10,2) NULL,
  crop_ratio_json JSON NULL,
  panel_count INT UNSIGNED NULL,
  panel_width_cm DECIMAL(10,4) NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  raw_payload_json JSON NULL,
  started_at TIMESTAMP NULL DEFAULT NULL,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_jobs_order_id (order_id),
  KEY idx_jobs_status (status),
  KEY idx_jobs_shopify_line_item_id (shopify_line_item_id),
  CONSTRAINT fk_jobs_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS webhooks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider VARCHAR(100) NOT NULL DEFAULT 'shopify',
  topic VARCHAR(100) NULL,
  shopify_order_id VARCHAR(191) NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'received',
  hmac_valid TINYINT(1) NULL,
  headers_json JSON NULL,
  raw_payload_json JSON NULL,
  error_message TEXT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_webhooks_provider (provider),
  KEY idx_webhooks_topic (topic),
  KEY idx_webhooks_status (status),
  KEY idx_webhooks_shopify_order_id (shopify_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope_type VARCHAR(50) NOT NULL DEFAULT 'system',
  order_id BIGINT UNSIGNED NULL,
  job_id BIGINT UNSIGNED NULL,
  level VARCHAR(20) NOT NULL DEFAULT 'info',
  step VARCHAR(100) NULL,
  message TEXT NOT NULL,
  details_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_logs_scope_type (scope_type),
  KEY idx_logs_order_id (order_id),
  KEY idx_logs_job_id (job_id),
  KEY idx_logs_level (level),
  KEY idx_logs_step (step),
  CONSTRAINT fk_logs_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_logs_job_id FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS artifacts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NULL,
  job_id BIGINT UNSIGNED NULL,
  type VARCHAR(50) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_size BIGINT UNSIGNED NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  download_count INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'available',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_artifacts_order_id (order_id),
  KEY idx_artifacts_job_id (job_id),
  KEY idx_artifacts_type (type),
  KEY idx_artifacts_status (status),
  KEY idx_artifacts_expires_at (expires_at),
  CONSTRAINT fk_artifacts_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_artifacts_job_id FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  setting_key VARCHAR(191) NOT NULL,
  setting_value JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_settings_setting_key (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
