ALTER TABLE tasks
  ADD COLUMN next_run_at TIMESTAMP(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN generated_sample VARCHAR(80),
  ADD INDEX idx_task_due (next_run_at, created_at, id);

UPDATE tasks SET next_run_at = NULL WHERE status IN ('SUCCEEDED', 'FAILED');

UPDATE tasks t JOIN templates p ON p.id = t.template_id
SET t.generated_sample = p.sample_result
WHERE t.status = 'RUNNING' AND t.stage = 'FINALIZE';

ALTER TABLE assets
  ADD COLUMN created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN state VARCHAR(12) NOT NULL DEFAULT 'READY',
  ADD INDEX idx_asset_cleanup (state, created_at, id);
