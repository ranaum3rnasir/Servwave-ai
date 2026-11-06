# RLS Tenant-Isolation Backstop — Activation Runbook

Postgres Row-Level Security is a **defense-in-depth backstop** under the app-layer
`tenantWhere()` + CASL checks: if a controller ever forgets `tenantWhere()`, the DB
still refuses to return another org's rows.

## What shipped (inert by default)

- `tenant_isolation` policies on every org-scoped table (`migrations/*_tenant_rls`,
  extended by `*_custom_field_definitions_rls` and `*_tenant_rls_coverage_gap`).
  That "every" is now enforced rather than asserted: `src/__tests__/rls-coverage.test.ts`
  reads the catalog of the freshly-migrated schema in CI and fails if any table with an
  `organization_id` lacks the policy. It has to be, because the claim was false for a
  year - the tenant_rls migration enumerates its tables by hand, and four of them
  (`automation_rules`, `automation_runs`, `job_line_items`, `org_tax_rates`) were
  never on the list and reached prod unprotected (#1276).
  Each policy keys off two transaction-local session vars:
  - `app.current_org_id` — scope reads/writes to one org.
  - `app.bypass_rls = 'on'` — controlled cross-tenant escape hatch.
  With neither set, a policy matches **no** rows (fail-closed).
- A per-request tenant context (`lib/tenant-context.ts`) + a Prisma wrapper
  (`lib/tenant-guard.ts`) that sets those vars before every query/transaction.
- `authenticate` scopes each request to `req.user.organization_id`; the Stripe
  webhook, public token pages, the two cron sweeps, and the unauthenticated
  auth-bootstrap routes (`/api/auth/login`, `/refresh`, `/google/finalize`,
  `/invite`, `/accept-invite`, `/mfa/verify`, `/mfa/resend`, via the
  `unscopedRequest` middleware) run `runUnscoped` (bypass) — they resolve the
  user/org from credentials or a token before any org context exists.

**It does nothing until activated.** The app connects as the Supabase `postgres`
role, which is `BYPASSRLS` — it ignores RLS entirely, even `FORCE`d. And the
Prisma wrapper is only installed when `DB_TENANT_GUARD=on`. So merging is safe:
zero behavior change in prod.

## Activation — STAGING first

1. **Create a non-bypass login role** on the staging DB (Supabase SQL editor / MCP):
   ```sql
   CREATE ROLE app_rls LOGIN PASSWORD '<generated>' NOBYPASSRLS;
   GRANT USAGE ON SCHEMA public TO app_rls;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rls;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public
     GRANT USAGE, SELECT ON SEQUENCES TO app_rls;
   ```
   Keep migrations/bootstrap on the privileged role: `DIRECT_URL` stays as
   `postgres` (so `prisma migrate deploy` — which must alter/own tables — keeps
   working). Only the runtime `DATABASE_URL` moves to `app_rls`.

2. **Point `DATABASE_URL` at `app_rls`** on the staging Render service (via the
   Supabase pooler). Leave `DIRECT_URL` on `postgres`.

3. **Verify pooler mode.** The wrapper wraps every op in its own transaction and
   uses `set_config(..., is_local => true)`, so it is correct on BOTH the session
   pooler (5432) and the transaction pooler (6543/`pgbouncer=true`). No pooler
   change is required; just confirm which one `DATABASE_URL` uses.

4. **Set `DB_TENANT_GUARD=on`** on the staging service and redeploy.

5. **Smoke test** on staging (this is the real verification — the wrapper is not
   unit-testable because the suite mocks Prisma):
   - Log in; list customers/leads/jobs/invoices; open a record.
   - Create a customer + estimate + invoice; record a payment.
   - Open a public estimate/invoice link (`/:id/public`).
   - Fire a Stripe test webhook.
   - Trigger the estimate-expiration + invoice-due crons (or wait for them).
   - Confirm a second org's data is never visible in any of the above.

6. **CI** already runs the `Database (migrations + RLS)` job, which proves both
   that the policy blocks cross-org reads and that the migration applies on
   vanilla Postgres. (It merged the former `rls-check` and `migration-check`
   jobs - see `docs/ci.md`.)

## Rollback (instant, no data change)

Set `DB_TENANT_GUARD=off` (or unset) **and** point `DATABASE_URL` back at
`postgres`, then redeploy. The policies can stay in place — a BYPASSRLS role
ignores them. To remove them entirely: `DROP POLICY tenant_isolation ON <table>;`
per table (+ `DISABLE ROW LEVEL SECURITY`).

## PROD activation

Only after staging runs clean for a soak period. Same steps against the prod DB
(`fvcjinnllchzqcupmrah`), in a maintenance window. Re-confirm prod's pooler mode
first (see MEMORY: `.env.example` intends 6543/`pgbouncer=true` for prod).

## Caveats / follow-ups

- **Scripts & seeds** (`src/scripts/*`, `src/seed*.ts`, `lib/e2e-org.ts`) run
  with no request context. Run them with the `postgres` (bypass) role, or wrap
  their entry points in `runUnscoped`. They already run guard-off today.
- **New cron/background callers** must wrap their entry in `runUnscoped`, and new
  unauthenticated routes that resolve the org from the entity must use the
  `unscopedRequest` middleware — otherwise they will (correctly) see no rows.
- **New cron jobs** are started with `scheduleJob` (`lib/scheduleJob.ts`), never a bare `cron.schedule`: that runs the job
  on the background jobs' own two database lines (`lib/prismaJobs.ts`, with a 5 s statement limit and a 1 s lock limit)
  instead of the users' pool. Any other background run at boot goes inside `runOnJobsClient`. The jobs' client is under the
  same tenant guard as `prisma`, so the `runUnscoped` rule above applies to it unchanged.
- The child-table policies use an `EXISTS` join to the parent's org; this adds a
  subquery per row under enforcement. Acceptable for a backstop.
