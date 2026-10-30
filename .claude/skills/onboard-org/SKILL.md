---
name: onboard-org
description: "Stand up a brand-new customer organization end-to-end: collect real org data, provision the org row + app settings + payment methods via reviewed SQL over Supabase MCP, verify the state tax row, then create the first admin (who then adds the rest of the team). Prod requires a typed confirmation. Use when the user wants to onboard a new organization, provision a new customer/tenant, or set up a new company on a plan."
user_invocable: true
---

# Onboard a new organization

Guided intake that lands a new tenant with a working first admin. All DB writes go through reviewed,
idempotent SQL (`create-org.ts --print-sql`, the same `buildCreateOrgSql` the tests cover) applied
via Supabase MCP. **No `TBD`/`00000` placeholders are ever written** — they would render onto
customer-facing estimate/invoice PDFs.

## Environments

| Env | Supabase project_id | First-admin creds |
|---|---|---|
| staging | `knriiqdqxgfoecsfarlx` | local worktree `.env` (staging) — skill can run it |
| prod (default) | `fvcjinnllchzqcupmrah` | operator supplies prod Supabase creds — see step 7 |

## Steps

1. **Interview** for real data (never invent placeholders):
   - Legal org name, admin email, admin first + last name
   - Real address: line 1, city, 2-letter state, postal code
   - Plan (default STARTER), and whether to start a 14-day trial (`--trial`, resolves to SCALE)

2. **Precheck columns exist** on the chosen project (same query as `/audit-org-entitlements`). If
   absent, stop: "Entitlements not deployed to <env> yet — promote PR #937 first." Do not continue.

3. **Email-uniqueness precheck** (mirrors the app's single-org-email 409 guard):
   ```sql
   SELECT organization_id FROM users WHERE lower(email) = lower('<admin email>');
   ```
   If any row exists, stop: "That email already belongs to an org. One email = one org." Do not continue.

4. **State-tax check** (warn, do not block — some orgs are tax-exempt):
   ```sql
   SELECT state_code, tax_rate FROM state_tax_rates WHERE state_code = '<STATE>';
   ```
   If no row: warn loudly — "No StateTaxRate for <STATE>; this org will bill 0% tax until a row is
   added." Continue only after the operator acknowledges.

5. **Generate the provisioning SQL** (no DB touched):
   ```bash
   npx tsx backend/scripts/create-org.ts --name "<name>" --email <admin email> --state <ST> \
     --address-line1 "<line1>" --city "<city>" --postal <zip> --plan <PLAN> [--trial] --print-sql
   ```
   Capture the emitted `-- new org id: <uuid>` — you need it for steps 6-8.

6. **Show + apply.** Show the operator the SQL and a summary (plan → features/seats; org id; **phone/Communication = OFF**). Then:
   - **staging:** one confirmation.
   - **prod:** operator types the exact org name to confirm.
   Apply via `mcp__supabase__execute_sql` on the chosen project. The batch is idempotent, so a
   re-run after a partial failure is safe.

7. **Create the first admin** (Supabase Auth API — not MCP; sends the admin's set-password invite):
   - **staging:** offer to run it directly (worktree `.env` has staging creds):
     ```bash
     npx tsx backend/scripts/bootstrap-admin.ts --org-id <uuid> --email <admin email> --first <first> --last <last>
     ```
   - **prod:** the worktree `.env` is staging — do NOT run it. Print the exact credentialed command
     for the operator to run themselves, with prod values they hold:
     ```bash
     SUPABASE_URL=<prod-url> SUPABASE_SERVICE_ROLE_KEY=<prod-service-role> DATABASE_URL=<prod-db-url> \
       npx tsx backend/scripts/bootstrap-admin.ts --org-id <uuid> --email <admin email> --first <first> --last <last>
     ```
   The script refuses to create a second admin if the org already has a login-enabled user.

8. **Hand back the residual checklist:**
   - The admin sets their password via the invite email, then adds the rest of the team in-app.
   - Add ≥1 service location per customer before creating leads or jobs.
   - Entitlement changes take effect on **page reload, not next login**. `authenticate` re-resolves
     the user from the DB on every request and recomputes `org_features` from the org's live
     `plan` + `feature_overrides` (`middleware/authenticate.ts` -> `lib/auth-user.ts`), and
     `/api/auth/me` returns that. The frontend's `servwave_user` localStorage entry is only a
     first-paint cache and is overwritten by the next `/me`. Verified live on staging 2026-07-27.

9. **Verify:** run `/audit-org-entitlements` on the new org id + env to confirm plan, features,
   seats, and that all DEFAULT_GRANTS seeded correctly.

## Why the seams are where they are

- **Grants + settings + payments via MCP SQL**: reversible, reviewable, idempotent.
- **First admin via tsx, not MCP**: creating a Supabase Auth identity is not a SQL operation, and
  the prod credential requirement keeps the one irreversible identity-creating step gated behind the
  operator's prod creds by construction.
- **CARD is not enabled**: a new org accepts only BANK_TRANSFER/CHECK/CASH; CARD needs Stripe
  Connect onboarding (`stripe_account_id`), done separately.
- **Phone/Communication is OFF for every new org, regardless of plan** (`feature_overrides:
  {"phone": false}` — even PRO/SCALE). The comm module isn't trusted for live use yet. Turn it on
  only as a deliberate phone-onboarding step: `/change-org-plan` → set `{"phone": true}` (or clear
  the override). The org INSERT sets this once and is never re-affirmed, so re-running onboard on an
  already-phone-onboarded org won't flip it back off.
