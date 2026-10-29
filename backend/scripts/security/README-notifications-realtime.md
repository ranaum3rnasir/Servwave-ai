# Notifications: Realtime RLS Runbook

**Script:** `backend/scripts/security/2026-06-18-notifications-realtime-rls.sql`
**Author:** Task R2 · 2026-06-18
**Who applies:** Ran (out-of-band, via Supabase SQL editor)

---

## What this does

Locks down Supabase Realtime so an authenticated user can only subscribe to **their own** private notification channel. Without this policy any authenticated user can subscribe to any topic string, including other users' notification feeds.

Policy added: `notifications_own_channel_read` — allows `SELECT` on `realtime.messages` only when the topic matches `org:%:user:<auth.uid()>`.

---

## Dashboard prerequisite (do this FIRST)

1. Open the Supabase project dashboard for the target environment.
2. Go to **Project Settings → Realtime** (or the **Realtime** section of the dashboard).
3. Enable **Realtime Authorization** (sometimes labelled **Private channels**).

Without this toggle the `realtime.messages` table and the `realtime.topic()` helper do not exist and the SQL will fail.

---

## Apply steps

### STAGING first

1. Open the **Supabase SQL Editor** for the **staging** project (`knriiqdqxgfoecsfarlx`).
2. Apply the table migration `20260618000000_add_notifications_tables` (run `npx prisma migrate deploy` or paste the migration SQL directly).
3. **Re-run the keystone RLS revoke script** — paste and execute `backend/scripts/security/2026-06-15-keystone-rls-revoke.sql` in the SQL editor.  The script loops over `pg_tables` and auto-covers any new tables added since it was last run, so the two new tables `notifications` and `notification_recipients` will receive `FORCE ROW LEVEL SECURITY` and have all `anon`/`authenticated` grants revoked.  This ensures they are never reachable via the Supabase Data API (spec §8.1).
4. Paste the contents of `2026-06-18-notifications-realtime-rls.sql` and run.
5. Verify the Realtime policy was created:

   ```sql
   SELECT policyname, cmd, roles, qual
   FROM pg_policies
   WHERE schemaname = 'realtime' AND tablename = 'messages';
   ```

   Expected: one row — `policyname = 'notifications_own_channel_read'`, `cmd = 'SELECT'`.

6. Smoke-test: open two browser sessions as two different users; confirm a user cannot receive events on the other user's topic.

### PROD

7. Repeat steps 1–5 on the **production** project (`dtumfibsalttuiukxtoy`).
8. The Realtime script is **idempotent** — running it more than once is safe (the `DO $$` block swallows `duplicate_object`).  The keystone script is also idempotent (re-revoking a revoked grant is a no-op).

---

## Anon key check

Confirm the frontend environment variable `VITE_SUPABASE_ANON_KEY` (and the backend `SUPABASE_ANON_KEY`) are set to the **rotated** key per the keystone runbook (`2026-06-15-keystone-rls-revoke.sql` → dashboard step 2). An un-rotated anon key that was previously shipped in the JS bundle remains valid until rotated.

---

## SSE fallback

If Realtime Authorization is unavailable on this Supabase plan, or proves troublesome to configure, **Task R3-alt** provides a Server-Sent Events fallback endpoint (`GET /api/notifications/stream`). The frontend notification hook detects the Realtime channel error and falls back to SSE automatically. In that case this SQL script is not required.

---

## Related

- `backend/scripts/security/2026-06-15-keystone-rls-revoke.sql` — deny-all RLS for the `public` schema
- GitHub issue: see the notifications feature branch `feat/in-app-notifications`
