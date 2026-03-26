-- Dynamic Soul stage-id configuration for both pipeline tabs.
-- purpose values:
--   launchpad_eval   -> Assessment Evaluation ingest
--   annotator_judge  -> Annotator Judge ingest

CREATE TABLE IF NOT EXISTS stage_ids (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('launchpad_eval', 'annotator_judge')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stage_ids_purpose ON stage_ids (purpose);

-- Initial seed (safe if already present)
INSERT INTO stage_ids (id, purpose)
VALUES
  ('stc_260218173538143LSI2M', 'launchpad_eval'),
  ('stc_26020219454705910Z9Z', 'launchpad_eval'),
  ('stc_260226150737582HP0J1', 'launchpad_eval'),
  ('stc_2603051253374341APCA', 'launchpad_eval'),
  ('stc_260307170924816MJKG9', 'launchpad_eval'),
  ('stc_2603111315195612L5NS', 'launchpad_eval'),
  ('stc_260210093443510LIGAL', 'annotator_judge'),
  ('stc_260315191240238RD39P', 'annotator_judge')
ON CONFLICT (id) DO NOTHING;
