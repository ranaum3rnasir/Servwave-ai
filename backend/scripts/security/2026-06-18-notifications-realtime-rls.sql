-- =====================================================================================
-- ServWave Notifications — realtime.messages RLS policy for private per-user channels.
-- (Notifications module 2026-06-18 · Task R2)
--
-- ⚠️  APPLY = RAN, OUT-OF-BAND.  This is deliberately NOT a Prisma migration: it
--     targets the `realtime` schema (a Supabase-managed schema), which Prisma has no
--     visibility over and which does not exist on the vanilla-Postgres CI environment.
--     Run it via the Supabase SQL editor on EACH project (STAGING first, then PROD),
--     or with psql against the project's DATABASE_URL. It is IDEMPOTENT — safe to run
--     more than once (the DO $$ block swallows duplicate_object).
--
-- WHY: The Supabase Realtime feature broadcasts messages over topic strings. Without a
--     policy, any authenticated user can subscribe to any channel topic, including other
--     users' notification channels. This policy restricts SELECT on realtime.messages
--     so a user may only subscribe to a topic that ends with their own auth.uid().
--
-- TOPIC FORMAT: 'org:{organization_id}:user:{user_id}'
--     The {user_id} segment is the authorization key. Because user IDs are globally
--     unique across all orgs, keying off auth.uid() alone is sufficient — the org
--     segment is human-readable context and does not need a separate join or JWT claim.
--
-- DASHBOARD PREREQUISITE: Before applying this SQL, you MUST enable Realtime
--     Authorization (private channels) on the Supabase project dashboard:
--     Project Settings → Realtime → toggle "Realtime Authorization" (or "Private
--     channels") ON. Without this toggle the `realtime.messages` table and the
--     `realtime.topic()` helper may not exist.
--
-- NOTE: Validate the exact `realtime.topic()` helper name/signature against the
--     project's Supabase Realtime version at apply time. If the function is unavailable
--     (older Realtime version) or has been renamed, open a Supabase support ticket or
--     upgrade the Realtime extension. If the org segment must also be validated (e.g.,
--     to prevent cross-org snooping even with a known UUID), a JWT `organization_id`
--     custom claim or a join is required — prefer the auth.uid()-only form to avoid a
--     custom access-token hook until that need is confirmed.
-- =====================================================================================

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "notifications_own_channel_read" ON realtime.messages
    FOR SELECT TO authenticated
    USING ( realtime.topic() LIKE ('org:%:user:' || auth.uid()::text) );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- (No INSERT policy for authenticated: clients only RECEIVE via subscription;
--  the backend service role publishes notifications and bypasses RLS by design.)

-- VERIFY after applying — confirm the policy exists:
--   SELECT policyname, cmd, roles, qual
--   FROM pg_policies
--   WHERE schemaname = 'realtime' AND tablename = 'messages';
--   -- expect: policyname = 'notifications_own_channel_read', cmd = 'SELECT'
