-- #925 — repair the OWN_NOTIFICATION condition backfilled by 20260618000100.
--
-- WHAT WAS WRONG: that migration (and defaultGrants.ts, until this fix) wrote
-- `{"recipient_id":"{{userId}}"}` for SALES/DISPATCHER/TECHNICIAN read/update/delete
-- Notification grants. `Notification` has no `recipient_id` column — it lives on
-- `NotificationRecipient`, reached through `Notification.recipients`. Predates the
-- notification/recipient split; the condition was never updated.
--
-- WHY THIS WAS SAFE TO LEAVE UNTIL NOW: unlike the #918 class of drift, this condition never
-- reached a Prisma `where` (`Notification` is not in scopeWhereFor's ScopeResource union) and
-- notification.controller.ts scopes by hand against `notificationRecipient.recipient_id`, not
-- through the grant. So the bad shape was inert for every real request path. It IS still fed to
-- CASL by defineAbilityFor — see default-grants-schema-validity.test.ts and
-- define-ability-notification.test.ts for the corrected shape's behavior at that layer.
--
-- THE FIX: repoint to the real relation path (Notification -> recipients[] ->
-- NotificationRecipient.recipient_id), matching the `lead_assignees.some` idiom already used
-- for every other own-row grant.
--
-- IDEMPOTENT: matches on the exact historical condition value, so a row already repaired (or
-- one a per-org customization deliberately diverged from the default) no longer matches and is
-- left untouched. Re-running is a no-op. Qualified on subject = 'Notification' so no other
-- subject that ever happened to carry a bare `recipient_id` condition is touched.
-- PORTABLE: plain UPDATE, no Supabase-only constructs.

UPDATE role_permissions
SET conditions = '{"recipients":{"some":{"recipient_id":"{{userId}}"}}}'::jsonb,
    updated_at = NOW()
WHERE subject = 'Notification'
  AND conditions = '{"recipient_id":"{{userId}}"}'::jsonb;
