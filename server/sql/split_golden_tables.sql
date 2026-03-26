-- Split gold tables:
-- 1) Keep `golden_datasets` for annotator judge (subtask_id based).
-- 2) Create `golden_datasets_assessments` for Launchpad eval (uniqueid based).
--
-- Run this once in Supabase SQL editor.

BEGIN;

-- New assessment table (Launchpad Section 1 labels).
CREATE TABLE IF NOT EXISTS public.golden_datasets_assessments (
  id BIGSERIAL PRIMARY KEY,
  uniqueid TEXT NOT NULL,
  q1_label TEXT,
  q2_label TEXT,
  q3_label TEXT,
  q4_label TEXT,
  q5_label TEXT,
  purpose TEXT NOT NULL DEFAULT 'Launchpad - eval',
  is_active BOOLEAN NOT NULL DEFAULT true,
  gold_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deprecated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_golden_datasets_assessments_uniqueid
  ON public.golden_datasets_assessments (uniqueid);

CREATE INDEX IF NOT EXISTS idx_golden_datasets_assessments_purpose_active
  ON public.golden_datasets_assessments (purpose, is_active);

CREATE INDEX IF NOT EXISTS idx_golden_datasets_assessments_created
  ON public.golden_datasets_assessments (gold_created_at DESC);

-- Optional cleanup in existing annotator table if launchpad columns/indexes exist there.
DROP INDEX IF EXISTS public.uq_golden_datasets_purpose_uniqueid;

ALTER TABLE public.golden_datasets
  DROP COLUMN IF EXISTS uniqueid,
  DROP COLUMN IF EXISTS q1_label,
  DROP COLUMN IF EXISTS q2_label,
  DROP COLUMN IF EXISTS q3_label,
  DROP COLUMN IF EXISTS q4_label,
  DROP COLUMN IF EXISTS q5_label;

COMMIT;
