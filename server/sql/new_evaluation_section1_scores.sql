-- Section 1 comparison output columns for deterministic gold-label scoring.
-- Used by server/pipeline.js step "applySection1ScoresByGold".

ALTER TABLE new_evaluation_table
  ADD COLUMN IF NOT EXISTS sec1_q1_score SMALLINT,
  ADD COLUMN IF NOT EXISTS sec1_q2_score SMALLINT,
  ADD COLUMN IF NOT EXISTS sec1_q3_score SMALLINT,
  ADD COLUMN IF NOT EXISTS sec1_q4_score SMALLINT,
  ADD COLUMN IF NOT EXISTS sec1_q5_score SMALLINT,
  ADD COLUMN IF NOT EXISTS section1_total SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_new_eval_sec1_q1_score'
  ) THEN
    ALTER TABLE new_evaluation_table
      ADD CONSTRAINT chk_new_eval_sec1_q1_score CHECK (sec1_q1_score IS NULL OR sec1_q1_score IN (0, 1));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_new_eval_sec1_q2_score'
  ) THEN
    ALTER TABLE new_evaluation_table
      ADD CONSTRAINT chk_new_eval_sec1_q2_score CHECK (sec1_q2_score IS NULL OR sec1_q2_score IN (0, 1));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_new_eval_sec1_q3_score'
  ) THEN
    ALTER TABLE new_evaluation_table
      ADD CONSTRAINT chk_new_eval_sec1_q3_score CHECK (sec1_q3_score IS NULL OR sec1_q3_score IN (0, 1));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_new_eval_sec1_q4_score'
  ) THEN
    ALTER TABLE new_evaluation_table
      ADD CONSTRAINT chk_new_eval_sec1_q4_score CHECK (sec1_q4_score IS NULL OR sec1_q4_score IN (0, 1));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_new_eval_sec1_q5_score'
  ) THEN
    ALTER TABLE new_evaluation_table
      ADD CONSTRAINT chk_new_eval_sec1_q5_score CHECK (sec1_q5_score IS NULL OR sec1_q5_score IN (0, 1));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_new_eval_section1_total'
  ) THEN
    ALTER TABLE new_evaluation_table
      ADD CONSTRAINT chk_new_eval_section1_total CHECK (section1_total IS NULL OR section1_total BETWEEN 0 AND 5);
  END IF;
END $$;
