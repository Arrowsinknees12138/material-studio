CREATE TABLE users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(40) NOT NULL UNIQUE,
  display_name VARCHAR(80) NOT NULL,
  password_hash VARCHAR(100) NOT NULL
);

CREATE TABLE templates (
  id VARCHAR(60) PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  category VARCHAR(40) NOT NULL,
  description VARCHAR(400) NOT NULL,
  cover_url VARCHAR(250) NOT NULL,
  sample_result VARCHAR(80) NOT NULL,
  required_image_count INT NOT NULL,
  accepted_mime_types VARCHAR(100) NOT NULL,
  max_file_size_bytes BIGINT NOT NULL,
  sort_order INT NOT NULL
);

CREATE TABLE assets (
  id CHAR(36) PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  template_id VARCHAR(60) NOT NULL,
  storage_key VARCHAR(100) NOT NULL,
  content_type VARCHAR(40) NOT NULL,
  byte_size BIGINT NOT NULL,
  CONSTRAINT fk_asset_owner FOREIGN KEY (owner_id) REFERENCES users(id),
  CONSTRAINT fk_asset_template FOREIGN KEY (template_id) REFERENCES templates(id)
);

CREATE TABLE tasks (
  id CHAR(36) PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  template_id VARCHAR(60) NOT NULL,
  request_id CHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL,
  stage VARCHAR(20),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at TIMESTAMP(3),
  result_key VARCHAR(100),
  error_message VARCHAR(400),
  fail_at VARCHAR(20),
  check_ms INT NOT NULL,
  generate_ms INT NOT NULL,
  finalize_ms INT NOT NULL,
  CONSTRAINT fk_task_owner FOREIGN KEY (owner_id) REFERENCES users(id),
  CONSTRAINT fk_task_template FOREIGN KEY (template_id) REFERENCES templates(id),
  UNIQUE KEY uk_task_owner_request (owner_id, request_id),
  KEY idx_task_queue (status, created_at, id),
  KEY idx_task_history (owner_id, created_at, id)
);

CREATE TABLE task_assets (
  task_id CHAR(36) NOT NULL,
  slot_index INT NOT NULL,
  asset_id CHAR(36) NOT NULL,
  PRIMARY KEY (task_id, slot_index),
  CONSTRAINT fk_link_task FOREIGN KEY (task_id) REFERENCES tasks(id),
  CONSTRAINT fk_link_asset FOREIGN KEY (asset_id) REFERENCES assets(id)
);
