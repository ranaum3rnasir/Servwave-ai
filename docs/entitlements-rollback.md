# Plan Entitlements — Rollback

## Symptom → action

**Orgs are 402-ing on modules they should have.** Do this first — no redeploy needed:

    UPDATE "organizations" SET "plan" = 'SCALE', "feature_overrides" = '{}'::jsonb;

Restores full access to every tenant within one login cycle. Then diagnose.

**Note:** users must sign out and back in. `org_features` is resolved at auth
time and cached in the login payload, so a DB change does not reach a live session.

## Full code rollback

1. Revert the route-wiring commit ("gate 5 module groups with requireFeature").
   That alone disarms every gate — the columns become inert data.
2. Do **NOT** drop the columns or the `Plan` enum. They are additive and harmless
   when unread, and dropping them means a re-deploy re-runs the backfill against
   a table that may by then hold real plan assignments.
3. Leave `frontend` deployed. With the backend gates gone, `useFeature` still
   reads `org_features` from the login payload; if the payload stops carrying it,
   `useFeature` fails OPEN and every module shows. That is the intended
   degradation.

## What the migration did

- Set `plan = 'SCALE'` on every org created before 2026-07-21.
- Merged `{"phone": false}` into `feature_overrides` for every such org EXCEPT
  demo orgs and Alpha Doors (`d40afcec-…`) — preserving the exact Communication
  access that the retired `communicationAccess.ts` allowlist granted.

Both statements are scoped by `created_at`, so replaying the migration cannot
touch an org created after it landed.

## Verifying an org

    cd backend && npm run org:audit -- --org-name "<name>"
