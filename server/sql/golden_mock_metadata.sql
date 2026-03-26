-- Metadata/versioning for gold labels.
-- Lets you load a new active gold set and deprecate older sets by purpose.

ALTER TABLE "golden_datasets"
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS gold_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_golden_mock_purpose_active
  ON "golden_datasets" (purpose, is_active);

CREATE INDEX IF NOT EXISTS idx_golden_mock_created
  ON "golden_datasets" (gold_created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_golden_datasets_purpose_subtask
  ON "golden_datasets" (purpose, subtask_id);
