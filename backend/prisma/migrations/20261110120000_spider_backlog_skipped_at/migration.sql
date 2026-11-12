-- Spider "Skip them" on Activate (#3431, Ran 10 Nov): when an Admin activates Spider and chooses to skip the starting
-- summary, the lead stays ALREADY past their time limit at that moment are never reported, per lead or in a later
-- starting summary. Every other stay is alerted as normal: one that goes past its limit later for any reason (time, a
-- shortened limit, a status switched on, a lead included again), and any new stay of a skipped lead.
--
--   backlog_skipped_at     when Spider was activated with "Skip them"; NULL after "Send one starting summary".
--   backlog_skipped_stays  the stays skipped then, one key each: "<lead id>|<stage>|<entered-stage instant, ms>"
--                          (services/spider/sweep.ts skippedStayKey). Emptied on Activate with "Send".
--
-- No fill: every existing row reads as "nothing skipped", which is today's behaviour.
-- Idempotent (ADD COLUMN IF NOT EXISTS). Portable: no Supabase-only objects, no secrets.

ALTER TABLE "spider_settings" ADD COLUMN IF NOT EXISTS "backlog_skipped_at" TIMESTAMPTZ(6);
ALTER TABLE "spider_settings" ADD COLUMN IF NOT EXISTS "backlog_skipped_stays" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
