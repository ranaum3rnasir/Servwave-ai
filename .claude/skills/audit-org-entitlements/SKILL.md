---
name: audit-org-entitlements
description: "Report an organization's plan, resolved features, feature overrides, seat usage, and RBAC grant health — the 'why can't this customer see X module' diagnostic. Read-only; runs against staging or prod. Use when the user asks to audit an org's entitlements, check what plan/features an org has, or diagnose a missing module."
user_invocable: true
---

# Audit org entitlements

Read-only diagnostic. Fetches an org's rows via Supabase MCP and computes the report through the
canonical TS resolver (`buildAuditReport`), so the plan/feature/seat/grant math is never re-derived
by hand.

## Environments

| Env | Supabase project_id | Entitlement columns |
|---|---|---|
| staging | `knriiqdqxgfoecsfarlx` | present |
| prod | `fvcjinnllchzqcupmrah` | **only after PR #937 is promoted to prod** |

## Steps

1. **Ask** which env (default: prod) and which org (name or id).

2. **Precheck the columns exist** on the chosen project:
   ```sql
   SELECT column_name FROM information_schema.columns
   WHERE table_name='organizations' AND column_name IN ('plan','feature_overrides');
   ```
   If fewer than 2 rows come back, stop and report: "Entitlements are not deployed to <env> yet
   (PR #937 not promoted). Nothing to audit." Do not continue.

3. **Fetch the three row sets** via `mcp__supabase__execute_sql` on the chosen project:
   ```sql
   -- org
   SELECT id, name, plan, trial_ends_at, feature_overrides, is_demo
   FROM organizations
   WHERE id = '<id>';            -- or: name ILIKE '%<name>%'  (pick one row; if several match, list them and ask)

   -- active users
   SELECT email, role, has_login FROM users
   WHERE organization_id = '<org id>' AND is_active = true;

   -- grants
   SELECT role, action, subject, conditions FROM role_permissions
   WHERE organization_id = '<org id>';
   ```

4. **Assemble** the JSON object `{ "org": {...}, "users": [...], "grants": [...] }` exactly matching
   the `AuditData` shape (org.trial_ends_at as an ISO string or null; feature_overrides as an object).
   Write it to a temp file in the scratchpad, then run:
   ```bash
   npx tsx backend/scripts/audit-org.ts --from-json <scratchpad>/audit-input.json
   ```
   (`--from-json -` also reads stdin.) This opens no DB connection — it only computes.

5. **Print the report verbatim.** Then, if the report shows missing/unscoped grants or a seat
   overage, add one line of plain-English interpretation (e.g. "SALES will 403 on Leads — the
   DEFAULT_GRANTS seed is incomplete; re-run onboarding's grant seed").

## Notes

- This skill never writes. No confirmation gate needed.
- "Why can't they see X": if a module is missing, check (a) the Features section — is the feature
  off because the plan/override excludes it? and (b) Grant health — is the RBAC grant missing? These
  are two different gates (entitlement vs permission).
