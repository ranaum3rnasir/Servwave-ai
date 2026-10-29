---
name: change-org-plan
description: "Change an organization's plan (upgrade/downgrade), start/extend/end a trial, or set/clear a single feature override. Generates idempotent SQL via the canonical TS logic and applies it via Supabase MCP after review. Prod requires a typed confirmation. Use when the user wants to upgrade or downgrade an org, put an org on a trial, or toggle a feature for a specific customer."
user_invocable: true
---

# Change org plan

Applies a plan/trial/feature-override change as reviewed, idempotent SQL. The SQL is produced by
`set-plan.ts --print-sql` (same `buildSetPlanSql` the tests cover), so nothing is hand-written.

## Environments

| Env | Supabase project_id |
|---|---|
| staging | `knriiqdqxgfoecsfarlx` |
| prod (default) | `fvcjinnllchzqcupmrah` |

## Steps

1. **Ask** env (default: prod), the org id, and the change:
   - plan: `--plan STARTER|PRO|SCALE|ENTERPRISE`
   - trial: `--trial <days>` (trials resolve to SCALE) or `--end-trial`
   - feature override: `--feature <key> --enable|--disable|--clear`

2. **Precheck columns exist** on the chosen project (same query as `/audit-org-entitlements` step 2).
   If absent, stop: "Entitlements not deployed to <env> yet." Do not continue.

3. **Confirm the org** — fetch its current state so the operator sees what they're changing:
   ```sql
   SELECT id, name, plan, trial_ends_at, feature_overrides FROM organizations WHERE id = '<id>';
   ```

4. **Generate the SQL** (no DB touched):
   ```bash
   npx tsx backend/scripts/set-plan.ts --org-id <id> [flags] --print-sql
   ```
   If the script exits non-zero, show its stderr and stop (e.g. attempting to grant a
   declared-but-unbuilt feature is rejected here, by design).

5. **Show the operator** the generated SQL **and** a plain-English summary: the resulting effective
   plan and what features/seats it unlocks or removes. For a downgrade, name what the org will lose.

6. **Confirm, then apply:**
   - **staging:** one confirmation.
   - **prod:** require the operator to type the exact org name before applying.
   Apply via `mcp__supabase__execute_sql` against the chosen project_id.

7. **Print the refresh note:** "Users on this org just need to reload the page — no sign-out
   required." `org_features` is NOT baked into the token: `authenticate` re-resolves the user from
   the DB on every request and recomputes it from the org's live `plan` + `feature_overrides`
   (`middleware/authenticate.ts` -> `lib/auth-user.ts`), and `/api/auth/me` returns that. The
   frontend's `servwave_user` localStorage entry is only a first-paint cache, overwritten by the
   next `/me`. Verified live on staging 2026-07-27.

## Notes

- All generated SQL is idempotent (`|| jsonb`, `- key`, plain `UPDATE`). Re-applying is safe.
- Clearing a feature override (`--clear`) is always allowed, even for unbuilt features — removing an
  override can never over-grant.
- To verify the result afterward, run `/audit-org-entitlements` on the same org/env.
