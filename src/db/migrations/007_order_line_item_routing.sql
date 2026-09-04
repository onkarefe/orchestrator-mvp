-- Durable, fail-closed classification for every Shopify order line item.
CREATE TABLE IF NOT EXISTS order_line_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  shopify_order_id VARCHAR(191) NOT NULL,
  shopify_line_item_id VARCHAR(191) NULL,
  source_position INT UNSIGNED NOT NULL,
  sku VARCHAR(191) NULL,
  title VARCHAR(255) NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 0,
  classification VARCHAR(20) NOT NULL,
  routing_state VARCHAR(50) NOT NULL,
  routing_reason TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_line_items_shopify_identity (shopify_order_id, shopify_line_item_id),
  UNIQUE KEY uq_order_line_items_order_position (order_id, source_position),
  KEY idx_order_line_items_order_id (order_id),
  KEY idx_order_line_items_classification (classification),
  KEY idx_order_line_items_routing_state (routing_state),
  CONSTRAINT fk_order_line_items_order_id
    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
