-- Weighted final score + post-eval status columns for Assessment Evaluation.
-- Run once on Supabase.

ALTER TABLE new_evaluation_table
  ADD COLUMN IF NOT EXISTS final_score NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS post_eval_status TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_new_eval_post_eval_status'
  ) THEN
    ALTER TABLE new_evaluation_table
      ADD CONSTRAINT chk_new_eval_post_eval_status
      CHECK (post_eval_status IS NULL OR post_eval_status IN ('SELECTED', 'REJECTED'));
  END IF;
END $$;
