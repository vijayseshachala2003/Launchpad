-- Add Section 1 scoring columns to new_evaluation_table.
-- Note: PostgreSQL appends new columns at the end of the table definition.
-- If you need display order after ans_5, select columns explicitly in that order in queries/views.

ALTER TABLE new_evaluation_table
  ADD COLUMN IF NOT EXISTS "Sec 1 - Q1" TEXT,
  ADD COLUMN IF NOT EXISTS "Sec 1 - Q2" TEXT,
  ADD COLUMN IF NOT EXISTS "Sec 1 - Q3" TEXT,
  ADD COLUMN IF NOT EXISTS "Sec 1 - Q4" TEXT,
  ADD COLUMN IF NOT EXISTS "Sec 1 - Q5" TEXT,
  ADD COLUMN IF NOT EXISTS "Total - Section" TEXT;
