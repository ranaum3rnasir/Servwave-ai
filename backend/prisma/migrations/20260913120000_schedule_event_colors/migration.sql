-- Per-org scheduler event colours: partial map of EventType -> design-system token name
-- (e.g. {"job": "sage-700"}); the allowed names are SCHEDULE_EVENT_COLOR_TOKENS in
-- organization.controller.ts.
-- Portable + idempotent: IF NOT EXISTS so a re-run on an already-promoted database is a no-op.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "schedule_event_colors" JSONB NOT NULL DEFAULT '{}';
