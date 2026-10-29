# Production Environment Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (recommended for this plan — heavy user interaction) or `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Stale hostnames, updated 2026-08-25:** every environment hostname in this plan is dead —
> `alpha-crm-api.onrender.com`, `alpha-crm.vercel.app`, `alpha-crm-staging-api.onrender.com` and
> `alpha-crm-staging.vercel.app` all 404 or are suspended — including where they appear in the
> Stripe webhook URLs, the `VITE_API_URL` table and the `FRONTEND_URL` values. The live map,
> verified 2026-08-25:
>
> | | Frontend | Backend |
> |---|---|---|
> | Production | `app.servwave.com` | `api.servwave.com` (Render origin `alpha-crm-1.onrender.com`) |
> | Staging | `servwave-demo.vercel.app` | `alpha-crm-test-env.onrender.com` |
>
> The steps themselves are executed and stand as a record of what was run.

**Goal:** Deploy ALPHA CRM to two live hosted environments — a paid always-on staging and a dormant free-tier production — at a current cost of $7/mo, with all infrastructure reproducible from this plan.

**Architecture:** Vercel (static frontend) + Render (Node/Express backend) + Supabase (Postgres/Auth/Storage). Two GitHub branches (`staging`, `main`) auto-deploy to two fully isolated stacks. Prod stays free (dormant) until go-live; staging is always paid. Git workflow enforced by the `ship-changes` skill.

**Tech Stack:** Node 20, Express, TypeScript, Prisma, Vite, React, Supabase JS SDK, Stripe (test mode), Resend. No new dependencies introduced by this plan.

**Reference:** Full design at `md_files/plans/project/2026-04-23-prod-env-setup-design.md`. Go-live playbook at `md_files/plans/project/go-live-playbook.md`. Deployment workflow at `.claude/skills/ship-changes/SKILL.md`.

**Execution mode recommended:** Inline (in this session). Most tasks after Step 0 require user interaction with third-party dashboards, so fresh subagents per task don't help.

---

## Prerequisites — do these first (User)

- [ ] **P1:** Sign up for Render with GitHub login at https://render.com → approve access to `ranro1/ALPHA_CRM`
- [ ] **P2:** Confirm Vercel account exists at https://vercel.com (create with GitHub login if new) → approve access to `ranro1/ALPHA_CRM`
- [ ] **P3:** Sign up for UptimeRobot free tier at https://uptimerobot.com (email login is fine)
- [ ] **P4:** Confirm Stripe dashboard access — log in at https://dashboard.stripe.com, verify test mode is enabled (toggle top-right)
- [ ] **P5:** Confirm Resend dashboard access — log in at https://resend.com, note the current API key location (Settings → API Keys)
- [ ] **P6:** On first request during execution, authenticate Claude's Supabase MCP by clicking the authorization URL Claude provides and pasting the callback URL back

**Do not proceed to Phase A tasks until P1-P5 are done.** (P6 happens during Step 1.)

---

## File Structure

**New files:**
- None (this plan doesn't create new source files beyond test files)

**Modified files:**
- `backend/src/app.ts` — `/health` endpoint adds DB ping
- `backend/src/__tests__/health.test.ts` — new test file for the updated health endpoint
- `backend/package.json` — add `seed:tax-rates` script
- `.gitignore` — add `.env.*` pattern; remove `migration_lock.toml` exclusion

**New files (git-tracked after unignore):**
- `backend/prisma/migrations/migration_lock.toml` — currently exists on disk but gitignored

**Config-only changes (no repo files touched):**
- Supabase: project rename + new project + SQL executed via dashboard
- Render: two new services via dashboard
- Vercel: one new project via dashboard
- UptimeRobot: one new monitor
- GitHub: branch protection rules on `main` and `staging`
- Stripe: two new webhook endpoints (test mode)

---

## Step 0 — Pre-flight Code Changes (Claude)

All code changes go through the ship-changes flow: feature branch → PR into `staging` → merge. This step is the first exercise of the workflow.

### Task 0.1: Create the pre-flight feature branch

- [ ] **Step 1:** Ensure on `main` with clean tree
  ```bash
  git status
  git checkout main
  git pull
  ```
  Expected: clean working tree, up to date with origin

- [ ] **Step 2:** Create `staging` branch (doesn't exist yet) from `main`
  ```bash
  git checkout -b staging
  git push -u origin staging
  ```
  Expected: new branch created on remote

- [ ] **Step 3:** Create the feature branch off `staging`
  ```bash
  git checkout -b feat/prod-env-preflight
  ```
  Expected: on new branch, nothing to commit yet

### Task 0.2: Update `/health` to do a DB ping (TDD)

**Files:**
- Modify: `backend/src/app.ts:43-45`
- Test: `backend/src/__tests__/health.test.ts` (new)

- [ ] **Step 0: Confirm app export pattern (verified against existing tests)**

  Existing tests in `backend/src/__tests__/*.test.ts` all use `import app from '../app';` (default import, no factory function). Our test follows the same pattern.

- [ ] **Step 1: Write the failing test**

  Create `backend/src/__tests__/health.test.ts`:
  ```typescript
  import { describe, it, expect, vi } from 'vitest';
  import request from 'supertest';
  import app from '../app';
  import { prisma } from '../lib/prisma';

  describe('GET /health', () => {
    it('returns 200 with status and db:ok fields on success', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.db).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });

    it('returns 503 with db:error when DB query fails', async () => {
      const spy = vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('db down'));
      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.db).toBe('error');
      spy.mockRestore();
    });
  });
  ```

- [ ] **Step 2: Run the test and verify it fails**

  ```bash
  cd backend
  npm test -- health.test.ts
  ```
  Expected: FAIL — either `db` field missing, or the 503 branch isn't implemented

- [ ] **Step 3: Update `/health` in `backend/src/app.ts`**

  Replace the existing handler at `backend/src/app.ts:43-45`:
  ```typescript
  // Health check (includes DB ping to keep Supabase Free from auto-pausing)
  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ status: 'ok', db: 'error', timestamp: new Date().toISOString() });
    }
  });
  ```

  Ensure `prisma` is imported at the top of `app.ts`:
  ```typescript
  import { prisma } from './lib/prisma';
  ```

- [ ] **Step 4: Run the test and verify it passes**

  ```bash
  npm test -- health.test.ts
  ```
  Expected: both tests PASS

- [ ] **Step 5: Run the full test suite to make sure nothing broke**

  ```bash
  npm test
  ```
  Expected: all 605 existing tests + 2 new = 607 PASS

### Task 0.3: Add `seed:tax-rates` npm script

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Verify the script file exists**

  ```bash
  ls backend/src/seed-tax-rates.ts
  ```
  Expected: file listed. (Confirmed present at plan-writing time.) If missing, STOP and surface to user — the plan assumes this file exists.

- [ ] **Step 2: Add the npm script**

  In `backend/package.json`, under `scripts`, add after the existing `seed` line:
  ```json
  "seed:tax-rates": "tsx src/seed-tax-rates.ts",
  ```

- [ ] **Step 3: Dry-run verify the wiring (will fail on DB connect — that's fine)**

  ```bash
  cd backend
  npm run seed:tax-rates 2>&1 | head -10
  ```
  Expected: script starts, attempts DB connection. Any DB error is fine at this point — we only need to confirm the script is found and tsx can run it. If npm says "Missing script", stop and fix package.json.

### Task 0.4: Update `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Locate the env-files section via Grep**

  Use Grep to find `.env.production` in `.gitignore` — the env-files block is right there. Do NOT rely on hardcoded line numbers.

- [ ] **Step 2: Add `.env.*` pattern**

  Add this line immediately after the existing `.env.production` line:
  ```
  .env.*
  ```

- [ ] **Step 3: Remove the migration_lock.toml ignore**

  Use Grep to find `migration_lock.toml` in `.gitignore`. Delete the entire line (will be `backend/prisma/migrations/**/migration_lock.toml` or similar).

- [ ] **Step 4: Verify migration_lock.toml is no longer ignored and add it to git**

  Run from repo root (use absolute path if unsure of cwd):
  ```bash
  git -C C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm check-ignore backend/prisma/migrations/migration_lock.toml
  ```
  Expected: no output (file not ignored). If output is the path, remove line still hasn't saved — re-try the edit.

  ```bash
  git -C C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm add backend/prisma/migrations/migration_lock.toml
  git -C C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm status
  ```
  Expected: `migration_lock.toml` listed as "new file"

### Task 0.5: Grep for hardcoded URLs and move any to env vars

**Files:**
- Read: `frontend/src/**/*`, `backend/src/**/*`

- [ ] **Step 1: Search for hardcoded URLs in frontend**

  Use the Grep tool (not bash cd) with pattern `localhost:3000|http://localhost|\.onrender\.com|\.supabase\.co` and path `frontend/src`.

  Expected: zero matches in production code paths (test files may have `localhost:5173` which is fine). If matches found, replace with `import.meta.env.VITE_API_URL` (for API calls) or `import.meta.env.VITE_SUPABASE_URL` (for Supabase direct calls).

- [ ] **Step 2: Search for hardcoded URLs in backend**

  Grep tool on `backend/src` with the same pattern.
  Expected: zero matches in production paths. Test files using `localhost` are fine.

- [ ] **Step 3: If changes were made, run tests**

  Use absolute path to avoid cwd drift:
  ```bash
  cd C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm/backend && npm test
  ```
  Expected: PASS

### Task 0.6: Commit and PR

- [ ] **Step 1: Stage and commit all Step 0 changes**

  From repo root (use absolute path):
  ```bash
  cd C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm
  git add backend/src/app.ts backend/src/__tests__/health.test.ts backend/package.json .gitignore backend/prisma/migrations/migration_lock.toml
  git status  # sanity check — should see 5 files
  ```

  Use multiple `-m` flags for the commit message (safer than multi-line strings on Windows PowerShell):
  ```bash
  git commit -m "chore: prod env pre-flight code changes" -m "- /health pings DB to prevent Supabase Free auto-pause" -m "- Added seed:tax-rates npm script" -m "- .gitignore: added .env.*, stopped ignoring migration_lock.toml" -m "- Committed existing migration_lock.toml (Prisma best practice)"
  ```

- [ ] **Step 2: Push the branch**

  ```bash
  git push -u origin feat/prod-env-preflight
  ```

- [ ] **Step 3: Open PR into `staging`**

  ```bash
  gh pr create --base staging --title "chore: prod env pre-flight code changes" --body "See md_files/plans/project/2026-04-23-prod-env-setup-plan.md Step 0."
  ```

  Expected: PR URL returned

- [ ] **Step 4: Merge the PR**

  After user review:
  ```bash
  gh pr merge --squash --delete-branch
  ```
  Expected: PR merged, feature branch deleted

- [ ] **Step 5: Verify `staging` is current locally**

  ```bash
  git checkout staging && git pull
  ```
  Expected: shows the squashed commit from the PR

### Task 0.7: Sync `main` from `staging`

Because `staging` was just created from `main`, they're in sync at this point. But as features accumulate, we promote staging → main via PR. Since we want prod Render to also pick up the pre-flight changes before deploying, let's sync once:

- [ ] **Step 1: Open sync PR staging → main**

  ```bash
  gh pr create --base main --head staging --title "release: initial prod env pre-flight"
  ```

- [ ] **Step 2: Merge**

  ```bash
  gh pr merge --squash
  ```

**Checkpoint:** Code changes live on both `main` and `staging`. Ready to provision infrastructure.

---

## Step 1 — Database Provisioning (Claude + Supabase MCP)

### Task 1.1: Authenticate Supabase MCP

- [ ] **Step 1: Invoke MCP authentication**

  Call `mcp__supabase__authenticate`. Claude will receive an authorization URL.

- [ ] **Step 2: User authorizes in browser**

  User clicks the URL, authorizes the app, and the browser redirects to a `http://localhost:<port>/callback?...` URL. The page may not load — that's fine.

- [ ] **Step 3: User pastes the callback URL back to Claude**

  Claude calls `mcp__supabase__complete_authentication` with the full callback URL.

  Expected: MCP reports success, the full Supabase tool set becomes available.

### Task 1.2: Verify current project access

- [ ] **Step 1: List projects**

  Use the (now-available) Supabase MCP project-list tool.

  Expected: returns the current project (the dev Supabase), showing its ref, region, name.

### Task 1.3: Rename current project → `alpha-crm-staging`

- [ ] **Step 1: Rename via Supabase dashboard** *(primary path — MCP project metadata mutation may not be exposed)*

  In https://supabase.com/dashboard → select the current project → Project Settings → General → change "Project name" to `alpha-crm-staging` → Save.

  (If the Supabase MCP exposes a project-update tool after auth, Claude may use it instead. Dashboard is the reliable path.)

- [ ] **Step 2: Verify rename**

  Re-list projects. Expected: project now named `alpha-crm-staging`.

**Note:** Connection strings, URLs, and keys do NOT change on rename — it's metadata only. No app-side updates needed.

### Task 1.4: Create new project `alpha-crm-prod`

- [ ] **Step 1: Create via Supabase dashboard** *(primary path)*

  https://supabase.com/dashboard → New project:
  - Name: `alpha-crm-prod`
  - Organization: same as staging
  - Region: same as staging (check staging's region in Settings → Infrastructure if needed)
  - DB password: generate a strong 24+ char password (use https://1password.com/password-generator or similar) — **save it to a password manager**; you cannot retrieve it from Supabase later
  - Pricing plan: Free

  Wait ~2 min for provisioning.

  (If the Supabase MCP exposes project-create after auth, Claude may use it instead with the same parameters.)

- [ ] **Step 2: Capture prod credentials**

  From the response (or dashboard → Settings → API):
  - `SUPABASE_URL` = `https://<ref>.supabase.co`
  - `SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`

  And from Settings → Database:
  - Pooled `DATABASE_URL` (port 6543, `?pgbouncer=true`)
  - Direct `DIRECT_URL` (port 5432)

### Task 1.5: Apply Prisma schema to prod

- [ ] **Step 1: Write prod credentials to a temporary local env**

  Create `backend/.env.prod-setup` (git-ignored by `.env.*` rule from Task 0.4):
  ```
  DATABASE_URL=<prod-pooled-url>
  DIRECT_URL=<prod-direct-url>
  SUPABASE_URL=<prod-url>
  SUPABASE_ANON_KEY=<prod-anon>
  SUPABASE_SERVICE_ROLE_KEY=<prod-service-role>
  ```

- [ ] **Step 2: Back up existing local `.env` before the swap**

  PowerShell — safe backup (don't clobber an existing backup):
  ```powershell
  cd C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm/backend
  if (Test-Path .env.local.bak) { Write-Error "BACKUP ALREADY EXISTS — STOP and resolve before continuing" } else { Copy-Item .env .env.local.bak }
  ```
  Expected: no error. If error, inspect `.env.local.bak` content first before proceeding.

- [ ] **Step 3: Swap to prod env and run migrations**

  ```powershell
  Copy-Item .env.prod-setup .env
  try {
    npx prisma generate
    npx prisma migrate deploy
  } finally {
    Copy-Item .env.local.bak .env
    Write-Host "✓ .env restored to local/staging"
  }
  ```
  Expected: `Applying migration 20260101000000_init`, then the others. Final line: `All migrations have been successfully applied.` The `finally` block guarantees `.env` is restored even if migrations fail.

- [ ] **Step 4: Verify `.env` points at staging/local again**

  ```powershell
  Select-String -Path .env -Pattern "DATABASE_URL" | Select-Object -First 1
  ```
  Expected: shows the staging/local DATABASE_URL (NOT the prod one). If you see the prod URL, manually restore from `.env.local.bak`.

- [ ] **Step 5: Verify schema via SQL**

  In Supabase dashboard → prod project → SQL Editor:
  ```sql
  SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
  ```
  Expected: 23 tables matching the Prisma schema (`users`, `customers`, `leads`, `estimates`, `jobs`, `invoices`, etc.)

### Task 1.6: Seed tax rates into prod

- [ ] **Step 1: Swap `.env` back to prod (same pattern as Task 1.5)**

  PowerShell:
  ```powershell
  cd C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm/backend
  Copy-Item .env.prod-setup .env
  try {
    npm run seed:tax-rates
  } finally {
    Copy-Item .env.local.bak .env
    Write-Host "✓ .env restored"
  }
  ```
  Expected: script logs "Seeded 51 state tax rates" (or similar upsert count). `.env` restored afterwards.

- [ ] **Step 2: Cleanup temporary files**

  ```powershell
  Remove-Item .env.prod-setup, .env.local.bak
  ```
  Expected: both deleted. These contained prod credentials; removing promptly reduces leak risk.

- [ ] **Step 3: Verify in dashboard**

  In Supabase SQL Editor:
  ```sql
  SELECT COUNT(*) FROM state_tax_rates;
  ```
  Expected: 51

### Task 1.7: Replicate Storage bucket from staging to prod

- [ ] **Step 1: Inspect staging bucket config**

  In Supabase SQL Editor for the **staging** project:
  ```sql
  SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE name = 'attachments';
  ```
  Expected: one row with the current attachments bucket config.

- [ ] **Step 2: Inspect staging RLS policies via `pg_policies`**

  Storage policies live in Postgres system tables, not a `storage.policies` view. Use:
  ```sql
  SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS with_check_expr
  FROM pg_policy WHERE polrelid = 'storage.objects'::regclass;
  ```

  Or the friendlier path: Supabase dashboard → staging project → Storage → `attachments` bucket → Policies tab → read each policy and its definition SQL.

  Expected: one or more policies (e.g., "Authenticated users can upload", "Users can read own files"). Copy each policy's name, target role, command (SELECT/INSERT/etc.), and USING/WITH CHECK expressions.

- [ ] **Step 3: Create the bucket in prod**

  In Supabase dashboard → **prod** project → Storage → New bucket:
  - Name: `attachments`
  - Public: match staging
  - File size limit: match staging
  - Allowed MIME types: match staging

- [ ] **Step 4: Apply RLS policies in prod**

  In prod SQL Editor, run the `CREATE POLICY ...` statements derived from the staging definitions.

  Example (exact text depends on staging):
  ```sql
  CREATE POLICY "Authenticated users can upload"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'attachments');
  ```

- [ ] **Step 5: Verify via dashboard or pg_policy**

  Supabase dashboard → prod project → Storage → `attachments` → Policies tab — confirm each staging policy is reproduced.

  Or SQL:
  ```sql
  SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'storage.objects'::regclass;
  ```
  Expected: same policy names as staging.

### Task 1.8: Document all 10 credentials

- [ ] **Step 1: Claude records credentials privately**

  Claude maintains an in-session note (not committed) with all 10 values:
  - Staging: 5 keys from staging Supabase
  - Prod: 5 keys from prod Supabase

  These will be pasted into Render/Vercel in the next steps. After that, the note is discarded.

**Checkpoint:** Two Supabase projects exist and are schema-ready. Staging retains all dev data; prod has empty schema + 51 tax rates + matching Storage bucket.

---

## Step 2 — Backend Hosting (User + Claude, Render)

### Task 2.1: Create staging backend service on Render

- [ ] **Step 1: User opens Render dashboard → New → Web Service**

  https://dashboard.render.com → New → Web Service → connect `ranro1/ALPHA_CRM`

- [ ] **Step 2: Configure service settings**

  - **Name:** `alpha-crm-test-env`
  - **Region:** US East (Ohio) or closest to Supabase project
  - **Branch:** `staging`
  - **Root Directory:** *(leave empty — repo root)*
  - **Runtime:** Node
  - **Build Command:**
    ```
    npm ci && cd backend && npx prisma generate && npx tsc && npx prisma migrate deploy
    ```
  - **Start Command:**
    ```
    cd backend && npm start
    ```
  - **Plan:** Starter ($7/mo)
  - **Health Check Path:** `/health`
  - **Auto-Deploy:** Yes

- [ ] **Step 3: Add environment variables (before first deploy)**

  Under "Environment" tab, add each:
  - `NODE_VERSION=20`
  - `NODE_ENV=production`
  - `DATABASE_URL=<staging-pooled-url>`
  - `DIRECT_URL=<staging-direct-url>`
  - `SUPABASE_URL=<staging-supabase-url>`
  - `SUPABASE_ANON_KEY=<staging-anon-key>`
  - `SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-key>`
  - `FRONTEND_URL=https://alpha-crm-staging.vercel.app` — **PLACEHOLDER.** Vercel hasn't been created yet (Step 3). The actual URL may differ. Task 3.2 Step 2 updates this value once the real Vercel URL is known. First backend deploy may have CORS errors from the staging frontend — expected and resolved in Task 3.2
  - Leave `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` unset for now — added in Step 4

- [ ] **Step 4: Click "Create Web Service"**

  Expected: Render provisions the service, pulls the repo, runs build, starts the process.

- [ ] **Step 5: Watch the build log**

  Expected: see `npm ci`, `prisma generate`, `tsc`, `migrate deploy` succeed in order. First deploy takes 3-5 min.

- [ ] **Step 6: Verify health endpoint**

  Once live:
  ```bash
  curl https://alpha-crm-test-env.onrender.com/health
  ```
  Expected: `{"status":"ok","db":"ok","timestamp":"..."}`

### Task 2.2: Create production backend service on Render

- [ ] **Step 1: Repeat 2.1 with these differences:**
  - **Name:** `alpha-crm-api`
  - **Branch:** `main`
  - **Plan:** Free ($0)
  - All env vars use **prod** Supabase values (not staging)
  - `FRONTEND_URL=https://alpha-crm.vercel.app`

- [ ] **Step 2: Verify prod health**

  ```bash
  curl https://alpha-crm-api.onrender.com/health
  ```
  Expected: `{"status":"ok","db":"ok","timestamp":"..."}`

  *(May take up to 60s to respond the first time — Free tier cold start.)*

**Checkpoint:** Both backend services live. Both `/health` endpoints respond with `db:ok`.

---

## Step 3 — Frontend Hosting (User + Claude, Vercel)

### Task 3.1: Create Vercel project

- [ ] **Step 1: User logs into Vercel dashboard → New Project**

  https://vercel.com/new → Import `ranro1/ALPHA_CRM`

- [ ] **Step 2: Configure**

  - **Framework Preset:** Vite (auto-detected)
  - **Root Directory:** `frontend`
  - **Build Command:** (leave default — `npm run build`)
  - **Output Directory:** (leave default — `dist`)
  - **Install Command:** (leave default — `npm install`)
  - **Production Branch:** `main`

- [ ] **Step 3: Set Environment Variables (scoped per env)**

  Click "Environment Variables". For EACH variable below, add entries for both **Production** and **Preview**:

  | Variable | Production value | Preview value |
  |---|---|---|
  | `VITE_API_URL` | `https://alpha-crm-api.onrender.com` | `https://alpha-crm-test-env.onrender.com` |
  | `VITE_SUPABASE_URL` | prod Supabase URL | staging Supabase URL |
  | `VITE_SUPABASE_ANON_KEY` | prod anon key | staging anon key |
  | `VITE_STRIPE_PUBLISHABLE_KEY` | (set in Step 4) | (set in Step 4) |

- [ ] **Step 4: Deploy**

  Click "Deploy". Vercel builds `main` first for Production.

  Expected: build succeeds in ~60 seconds. URL like `alpha-crm-<hash>.vercel.app` or `alpha-crm.vercel.app`.

- [ ] **Step 5: Trigger staging deploy**

  ```bash
  git checkout staging && git pull
  git commit --allow-empty -m "chore: trigger initial staging deploy"
  git push origin staging
  ```
  Expected: Vercel auto-builds from `staging`, produces a preview URL.

### Task 3.2: Confirm Vercel URLs

- [ ] **Step 1: Note the actual URLs Vercel assigned**

  - Prod URL: from Vercel dashboard → Deployments → Production
  - Staging URL: from the PR preview (or Git branch deployments)

- [ ] **Step 2: Update Render env vars if URLs differ from assumed**

  If Vercel assigned `alpha-crm-<ran>.vercel.app` instead of `alpha-crm.vercel.app`:
  - Update `FRONTEND_URL` in `alpha-crm-api` Render service
  - Update `FRONTEND_URL` in `alpha-crm-test-env` Render service
  - Both services auto-redeploy after env var change

### Task 3.3: Verify frontend loads

- [ ] **Step 1: Open staging URL in browser**

  Expected: login page renders (no data loads yet — CORS or auth errors are OK at this point without credentials)

- [ ] **Step 2: Check browser devtools → Network → XHR**

  Filter for API calls. Expected: hit against `alpha-crm-test-env.onrender.com`, not localhost.

**Checkpoint:** Both frontend deployments live. Both hit the correct backend per env.

---

## Step 4 — External Services (User + Claude: Stripe + Resend)

### Task 4.1: Create Stripe test-mode webhook endpoints

- [ ] **Step 1: User opens Stripe dashboard (test mode) → Developers → Webhooks → Add endpoint**

- [ ] **Step 2: Create staging webhook**

  - **URL:** `https://alpha-crm-test-env.onrender.com/api/webhooks/stripe`
  - **Events to listen to:** click "Select events" → add:
    - `checkout.session.completed`
    - `checkout.session.expired`
    - `payment_intent.succeeded`
    - `payment_intent.payment_failed`
    - `charge.refunded`
  - Click "Add endpoint"

- [ ] **Step 3: Copy the signing secret**

  After creation, click "Signing secret" → Reveal. Copy the `whsec_...` value. Hand to Claude.

- [ ] **Step 4: Repeat for production webhook**

  - **URL:** `https://alpha-crm-api.onrender.com/api/webhooks/stripe`
  - Same event list
  - Copy its signing secret (different from staging)

### Task 4.2: Paste secrets into Render

- [ ] **Step 1: User hands Claude the 4 Stripe values**

  - `STRIPE_SECRET_KEY` (one, from Stripe → Developers → API keys, `sk_test_...`)
  - `VITE_STRIPE_PUBLISHABLE_KEY` (one, from the same page, `pk_test_...`)
  - Staging `STRIPE_WEBHOOK_SECRET` (`whsec_...`)
  - Prod `STRIPE_WEBHOOK_SECRET` (different `whsec_...`)

- [ ] **Step 2: Update staging Render service**

  Render dashboard → `alpha-crm-test-env` → Environment → add/update:
  - `STRIPE_SECRET_KEY=<same-for-both>`
  - `STRIPE_WEBHOOK_SECRET=<staging-whsec>`

  Save → service auto-redeploys.

- [ ] **Step 3: Update prod Render service**

  `alpha-crm-api` → same vars but `STRIPE_WEBHOOK_SECRET=<prod-whsec>`. Save.

- [ ] **Step 4: Update Vercel**

  Vercel dashboard → Environment Variables:
  - `VITE_STRIPE_PUBLISHABLE_KEY` for both Production and Preview (same value)

  Redeploy both frontend envs (empty commit + push, or "Redeploy" button).

### Task 4.3: Resend API key

- [ ] **Step 1: User gets current Resend API key**

  Resend dashboard → API Keys → copy (or rotate and copy new if concerned about key hygiene)

- [ ] **Step 2: Paste into both Render services**

  Add `RESEND_API_KEY=<key>` to both `alpha-crm-test-env` and `alpha-crm-api`. Save → auto-redeploy.

### Task 4.4: Verify secrets are live

- [ ] **Step 1: Check staging backend responded to env change**

  ```bash
  curl https://alpha-crm-test-env.onrender.com/health
  ```
  Expected: still `{"status":"ok","db":"ok",...}` — no impact from env changes, just confirms service is still up.

- [ ] **Step 2: Check frontend picked up Stripe publishable key**

  Vite inlines `VITE_*` values at build time, so they don't appear as `import.meta.env` in the running browser. Verify instead by either:
  - **Vercel dashboard** → Project → Settings → Environment Variables → confirm `VITE_STRIPE_PUBLISHABLE_KEY` is set for Production and Preview with `pk_test_...` value
  - **Page source** → open the staging frontend in Incognito → View Source → search `pk_test_` in the built JS bundle → should find the key inlined

  Expected: key visible in one of these.

**Checkpoint:** All third-party secrets configured. Stripe test flows and Resend email can now function end-to-end on both envs.

---

## Step 5 — Keep-alive & Monitoring (User)

### Task 5.1: Configure UptimeRobot for prod

- [ ] **Step 1: UptimeRobot dashboard → Add New Monitor**

  - **Type:** HTTPS
  - **Friendly name:** `alpha-crm-api prod`
  - **URL:** `https://alpha-crm-api.onrender.com/health`
  - **Monitoring Interval:** every 5 minutes *(or 14 if on a stricter free tier — must be under 15 to prevent Render spin-down)*
  - **Alert Contacts:** your email

- [ ] **Step 2: Verify the monitor fires**

  Wait 5 minutes. Check UptimeRobot "Logs" — expected: at least one "Up" entry for prod backend.

### Task 5.2: Optional — also monitor staging

- [ ] **Step 1:** Same as 5.1 but for `alpha-crm-test-env.onrender.com/health`
- [ ] **Step 2:** Name: `alpha-crm-test-env`

*(Staging is always-on via Starter plan, but an uptime check gives you outage notifications.)*

**Checkpoint:** Prod backend will no longer sleep. You'll get email alerts if either env goes down.

---

## Step 6 — Branch Protection (User, GitHub)

### Task 6.1: Protect `main`

- [ ] **Step 1: GitHub repo → Settings → Branches → Add rule**

- [ ] **Step 2: Configure rule for `main`:**

  - **Branch name pattern:** `main`
  - ☑ Require a pull request before merging
  - ☑ Require approvals: 0 (or 1 if a second account reviews)
  - ☑ Dismiss stale approvals when new commits are pushed
  - ☑ Do not allow bypassing the above settings
  - ☐ Allow force pushes (leave unchecked)
  - ☐ Allow deletions (leave unchecked)

- [ ] **Step 3:** Click "Create"

### Task 6.2: Protect `staging`

- [ ] **Step 1:** Repeat 6.1 with `staging` as the pattern
- [ ] **Step 2:** Same settings

### Task 6.3: Verify protection (non-destructive)

- [ ] **Step 1: Try a dry-run push to `staging`**

  ```bash
  cd C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm
  git checkout staging && git pull
  git push --dry-run origin staging
  ```

  Expected: output ends with "Everything up-to-date" or a list of commits. `--dry-run` doesn't actually push, so protection won't reject anything — but it also doesn't test protection.

- [ ] **Step 2: Verify protection is active via GitHub API (no destructive commits)**

  ```bash
  gh api repos/ranro1/ALPHA_CRM/branches/staging/protection | grep -E "required_pull_request_reviews|enforce_admins"
  gh api repos/ranro1/ALPHA_CRM/branches/main/protection | grep -E "required_pull_request_reviews|enforce_admins"
  ```
  Expected: both return JSON fields indicating protection is configured (not 404).

  If you want a real push test, use a *disposable* branch instead. (Note: per `MEMORY.md` "never delete branches" feedback, we normally avoid `branch -D`. This test-probe branch is an explicit exception — it's created solely to prove the protection works and has no commit history worth preserving. Skip this sub-step if you'd rather rely on the `gh api` check above.)
  ```bash
  git checkout -b test/protection-probe
  git commit --allow-empty -m "test probe"
  git push -u origin test/protection-probe
  # This succeeds (feature branch, not protected) — demonstrates normal push works
  git push origin test/protection-probe:staging  # attempt to push to staging ref
  # Expected: REJECTED with "protected branch" message
  # Clean up:
  git checkout staging
  git branch -D test/protection-probe
  git push origin --delete test/protection-probe
  ```

**Checkpoint:** Direct pushes to `main` and `staging` now blocked. All future changes must flow through PR.

---

## Step 7 — Smoke Test (User + Claude)

### Task 7.1: Verify staging admin exists (don't reseed if so)

- [ ] **Step 1: Query staging for admin**

  In Supabase dashboard → staging project → SQL Editor:
  ```sql
  SELECT email, role, is_active FROM users WHERE role = 'ADMIN' LIMIT 5;
  ```

- [ ] **Step 2: Branch on result:**

  - **If ≥1 admin returned:** skip reseed. Note the email you'll log in with.
  - **If 0 admins:** swap local env to staging (same pattern as Task 1.5), run `npm run seed`, capture the admin credentials.

### Task 7.2: Full end-to-end on staging

- [ ] **Step 1: Log in at staging frontend**

  Open `https://alpha-crm-staging.vercel.app` (or actual Vercel-assigned URL) → log in with admin from 7.1.

  Expected: dashboard loads with existing data.

- [ ] **Step 2: Create a lead**

  Leads → New Lead → fill required fields → save.
  Expected: lead appears in list with ID `Lxxxxx`.

- [ ] **Step 3: Create an estimate for the lead**

  From the lead → New Estimate → add line items → save as Draft.
  Expected: estimate appears with ID `Exxxxx`.

- [ ] **Step 4: Send the estimate (tests Resend)**

  Send → confirm dialog → send.
  Expected:
  - estimate status changes to SENT
  - Resend dashboard shows a delivered email

- [ ] **Step 5: Approve via public link (tests public estimate flow)**

  Open the public estimate link (from the email or estimate detail page) → click Approve.
  Expected: estimate status becomes APPROVED.

- [ ] **Step 6: Simulate deposit paid via Stripe test card**

  On the public page, click "Pay deposit" → Stripe Checkout opens → use `4242 4242 4242 4242`, any future date, any CVC → submit.
  Expected:
  - redirect to success page
  - within ~10s, Stripe webhook fires → estimate's deposit becomes PAID
  - Jobs list shows a new Job auto-created

- [ ] **Step 7: Complete the job → create invoice → record payment**

  Job detail → assign tech → start → complete. Invoice auto-generated. Record payment (cash). Expected: invoice PAID status.

- [ ] **Step 8: Check Render logs for any errors**

  Render dashboard → `alpha-crm-test-env` → Logs → scan for `error`/`500`.
  Expected: none during the flow.

### Task 7.3: Verify prod backend accepts health traffic but is otherwise empty

- [ ] **Step 1: Hit prod health**

  ```bash
  curl https://alpha-crm-api.onrender.com/health
  ```
  Expected: `{"status":"ok","db":"ok",...}`

- [ ] **Step 2: Confirm prod DB has no customers/users/leads**

  In Supabase SQL editor for prod:
  ```sql
  SELECT
    (SELECT COUNT(*) FROM users) as users,
    (SELECT COUNT(*) FROM customers) as customers,
    (SELECT COUNT(*) FROM leads) as leads,
    (SELECT COUNT(*) FROM state_tax_rates) as tax_rates;
  ```
  Expected: 0, 0, 0, 51

- [ ] **Step 3: Confirm frontend prod URL loads login page**

  Open `https://alpha-crm.vercel.app` — login page appears. Do NOT try to log in (no admin exists yet on prod).

**Checkpoint:** Staging is fully functional. Prod is dormant and ready for go-live day.

---

## Step 8 — Wrap-up

### Task 8.1: Update the memory system

- [ ] **Step 1: Update `MEMORY.md`**

  Add to the "Current Focus" section:
  ```
  - Prod env provisioned 2026-04-23: Render + Vercel + Supabase × 2 envs, $7/mo (staging Starter).
    Prod dormant until go-live; see md_files/plans/project/go-live-playbook.md.
  ```

### Task 8.2: Create the Obsidian vault note (deferred per user preference)

Per CLAUDE.md rule 10: sync vault after milestones. This is a significant infrastructure milestone.

- [ ] **Step 1: User decides**

  Either: (a) run `/end-session` which syncs the vault, or (b) manually create a vault note under `Architecture/Production-Environment.md` referencing the design/plan/playbook files.

### Task 8.3: Final cleanup

- [ ] **Step 1: Verify no local secret files remain**

  ```bash
  powershell -NoProfile -Command "Get-ChildItem -Path 'C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm' -Recurse -Force -Filter '.env.prod-*' -ErrorAction SilentlyContinue"
  ```
  Expected: no results (all temporary env swap files cleaned up in Tasks 1.5/1.6).

- [ ] **Step 2: Celebrate the checkpoint**

  ```
  ✅ Staging: live at $7/mo, ready for QA
  ✅ Production: dormant at $0/mo, ready for go-live flip
  ✅ Git workflow: enforced via branch protection + ship-changes skill
  ✅ Monitoring: UptimeRobot alerts active
  ✅ Known gaps: see Section 4 "Explicitly NOT in scope" in design doc
  ```

---

## Success Criteria

The plan is successfully completed when ALL of:

- [ ] `git log staging` shows the pre-flight commit
- [ ] Both Render services return `{"status":"ok","db":"ok"}` on `/health`
- [ ] Both Vercel deployments load the login page
- [ ] Staging smoke test (Task 7.2) runs end-to-end with zero errors in Render logs
- [ ] Prod Supabase has 0 users/customers/leads and 51 tax rates
- [ ] `gh api repos/ranro1/ALPHA_CRM/branches/main/protection` returns a protection payload (not 404)
- [ ] UptimeRobot shows "Up" for prod backend for ≥15 minutes
- [ ] Monthly bill projection: $7 (Render staging Starter). All else $0.

---

## Troubleshooting Reference

| Symptom | Likely cause | Fix |
|---|---|---|
| Render build fails at `prisma generate` | `DATABASE_URL` missing/wrong | Re-check env vars in Render dashboard |
| Render build fails at `tsc` | Prisma client missing | Verify `prisma generate` step precedes `tsc` in build command |
| `/health` returns 503 | Supabase paused or DB creds wrong | Check Supabase dashboard for "Paused" banner; verify `DATABASE_URL` uses `?pgbouncer=true` |
| Stripe webhook returns 400 in Render logs | Wrong `STRIPE_WEBHOOK_SECRET` for this env | Staging & prod have DIFFERENT webhook secrets — ensure each Render service has the right one |
| Frontend CORS error | `FRONTEND_URL` in Render doesn't match actual Vercel URL | Update `FRONTEND_URL` in Render env, wait for auto-redeploy |
| Resend emails not arriving | `EMAIL_FROM` domain unverified | Known — current default `no-reply@alphasecurityus.com` may not deliver. Either ignore for Phase 0 or set `EMAIL_FROM=onboarding@resend.dev` in Render env |
| Vercel preview deploys but `staging` branch doesn't get a stable URL | Default behavior | Expected — use the latest preview URL or configure a custom domain for `staging` if needed |
| Push to `staging` rejected | Branch protection working correctly | Use a PR via `gh pr create --base staging ...` |
