CREATE INDEX idx_task_template_history ON tasks (owner_id, template_id, created_at, id);
CREATE INDEX idx_task_active_history ON tasks (owner_id, status, created_at, id);
