-- Launchpad Section 1 gold labels table (separate from annotator judge table).
-- Safe to run multiple times.

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
