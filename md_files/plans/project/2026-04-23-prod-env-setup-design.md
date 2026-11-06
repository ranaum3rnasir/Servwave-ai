# Production Environment Setup — Design Document

**Date:** 2026-04-23
**Status:** Design in progress (living document — updated as sections are approved)
**Owner:** Ran

> **`/health` changed after this was written (#3106).** `/health` now answers from memory (`{status, timestamp}`)
> and no longer touches the database; the database ping described below lives on `/health/deep`
> (`{status, db, timestamp}`). A monitor that must notice a database outage, or keep a free-tier database from
> pausing, must call `/health/deep`. Render's health check path stays `/health`: pointing it at `/health/deep`
> would bring back the restart loop when a job holds the database lines.

> **Stale hostnames, updated 2026-08-25:** every environment hostname in this document is dead.
> `alpha-crm-api.onrender.com`, `alpha-crm.vercel.app`, `alpha-crm-staging-api.onrender.com` and
> `alpha-crm-staging.vercel.app` all 404 or are suspended. The live map, verified 2026-08-25:
>
> | | Frontend | Backend |
> |---|---|---|
> | Production | `app.servwave.com` | `api.servwave.com` (Render origin `alpha-crm-1.onrender.com`) |
> | Staging | `servwave-demo.vercel.app` | `alpha-crm-test-env.onrender.com` |
>
> Read the hostnames below as a record of what was provisioned in April, never as somewhere to
> point a config value, a webhook or a probe. The reasoning everywhere else here stands.

**Goal:** Get ALPHA CRM onto two live hosted environments — a dormant production ready to flip on at go-live, and an always-on staging for internal QA testing — at minimum cost.

---

## User Action Checklist (running — updated per section)

Everything you need to provide or do yourself, so nothing blocks execution. Check off as you complete them.

### Accounts to create / log into
- [ ] **Render** account — sign up at render.com with GitHub login
- [ ] **Vercel** account — sign up at vercel.com with GitHub login (probably already have one)
- [ ] **UptimeRobot** account — free tier at uptimerobot.com (for prod keep-alive ping)
- [ ] **Stripe** dashboard access — confirm account exists in test mode; if not, register at stripe.com
- [ ] **Resend** account — already have this; confirm access to the current API key
- [ ] **Supabase MCP authentication** — authorize Claude's MCP access once (I'll prompt you during execution)

### Secrets / values to provide to Claude
- [ ] `STRIPE_SECRET_KEY` (test mode, starts with `sk_test_`) — one key, same for both envs
- [ ] `VITE_STRIPE_PUBLISHABLE_KEY` (test mode, starts with `pk_test_`) — one key, same for both envs (frontend uses this)
- [ ] `RESEND_API_KEY` — current value from your Resend dashboard (same for both envs initially)
- [ ] Initial prod admin email + desired password (only needed on go-live day, not now)

### Things you'll do yourself (Claude will guide)
- [ ] Enable GitHub branch protection on `main` and `staging` (no direct pushes, PR required)
- [ ] Create Stripe webhook endpoints (two — one per env) and copy the signing secrets back to me
- [ ] Configure UptimeRobot monitor on prod `/health/deep` (14-min interval)
- [ ] (At go-live) Flip prod Render service Free → Starter
- [ ] (At go-live) Add a real domain and verify it on Resend

### Things Claude will generate (no action needed from you)
- Prisma migrations will run automatically during Render builds
- Supabase Storage bucket config for prod — replicated from staging via SQL + dashboard
- `/health/deep` endpoint does a DB ping (keeps Supabase Free from pausing)
- `.gitignore` updated: `.env.*` added; `migration_lock.toml` removed from ignore list
- `seed:tax-rates` npm script added to `backend/package.json`
- Any hardcoded API URLs in frontend/backend moved to env vars

---

## Running Decisions Log

Every confirmed decision is captured here so nothing is lost as we progress through the design.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Two environments: production + staging**, fully isolated | Staging for QA + internal workers, prod for real customers later |
| D2 | **Production stays on free tier until go-live**; staging is always paid/always-on | Prod is dormant Phase 0, staging carries daily QA load |
| D3 | **Backend host: Render** | Simplest Git-based deploy, runs Express as-is, cheap paid tier ($7/mo), usable free tier |
| D4 | **Frontend host: Vercel** | Best-in-class for static React/Vite builds, Git integration, free-tier fine for Phase 0 |
| D5 | **Database: Two Supabase projects** (rename current → staging, create fresh prod) | Supabase Free allows 2 active projects per org; zero data loss, no re-seeding |
| D6 | **Staging backend:** Render **Starter** ($7/mo always-on) | QA workers hit it daily, cannot tolerate 1-min wake-up |
| D7 | **Staging database:** Supabase **Free** | QA traffic keeps it active; data is disposable, can be reseeded from Prisma migrations if corrupted |
| D8 | **Production backend:** Render **Free** + keep-alive ping | $0 while dormant; flips to Starter at go-live |
| D9 | **Production database:** Supabase **Free** | Low/no traffic; `/health/deep` pings keep it from pausing |
| D10 | **Frontend:** Vercel Hobby for both envs now, upgrade to Pro at go-live | Hobby terms gray area for commercial, acceptable for pre-customer MVP |
| D11 | **Git branching:** Two-branch model — `main` = production, `staging` = staging | Matches the "QA gate before prod" flow |
| D12 | **QA auth:** Regular Supabase login for company employees, no separate gate | QA are internal workers with real user accounts |
| D13 | **Domain:** Platform subdomains now (`*.vercel.app`, `*.onrender.com`), real domain added at go-live | Save ~$15/yr + Resend domain verification work until it matters |
| D14 | **Stripe:** Test mode on both envs | Matches current dual-run validation; live mode flipped at go-live |
| D15 | **Supabase project management:** Via Supabase MCP (Claude has access, user authenticates once) | User explicitly authorized direct MCP access for setup |
| D16 | **Git workflow encoded as skill:** `.claude/skills/ship-changes/SKILL.md` — auto-triggers on push/merge/deploy language | Prevents accidentally bypassing staging gate or mis-handling hotfix/rollback |
| D17 | **AWS considered and rejected for MVP** — revisit only when Render Pro ($85/mo) capacity hit, compliance required, multi-region needed, or full-time ops hire | AWS free tier expires in 12 months; surprise-bill risk; complexity not justified for 0-customer Phase 0; migration path from Render to AWS later is 1-2 weeks of straightforward work |

---

## Section 1 — Architecture Overview ✅ Approved

Two isolated environments, each a three-layer stack, wired together through one GitHub repo.

```
                    GitHub: ranro1/ALPHA_CRM
                      │
            ┌─────────┴──────────┐
            │                    │
        staging branch        main branch
            │                    │
      ┌─────┼─────┐          ┌───┼──────┐
      ▼     ▼     ▼          ▼   ▼      ▼
   Vercel Render Supabase  Vercel Render Supabase
   (FE)   (BE)  (DB/Auth) (FE)  (BE)  (DB/Auth)
   Hobby  Starter Free     Hobby Free   Free
   $0     $7     $0        $0    $0     $0
   staging staging staging  prod  prod   prod
```

**URLs (starting point, platform subdomains):**
- Staging FE: `alpha-crm-staging.vercel.app`
- Staging BE: `alpha-crm-test-env.onrender.com`
- Prod FE: `alpha-crm.vercel.app`
- Prod BE: `alpha-crm-api.onrender.com`

**Monthly cost now:** $7 (staging Render Starter only). Everything else $0.

**Separation guarantee:** zero shared infrastructure between envs. Different Supabase projects, Auth pools, keys. A staging mistake cannot affect production.

**Go-live delta:** flip one Render service Free→Starter ($7), add a domain, verify Resend. No re-architecting.

---

## Section 2 — Git Branching & Deployment Flow ✅ Approved

**Branches:**
- `main` → production (Vercel prod + Render prod + Supabase prod)
- `staging` → staging (Vercel staging + Render staging + Supabase staging)
- `feat/*`, `fix/*`, `hotfix/*` → feature branches with Vercel preview URLs per PR

**Standard flow** (every feature or non-urgent fix):
1. Branch off `staging`: `git checkout staging && git pull && git checkout -b feat/<name>`
2. Work + commits; open PR into `staging` (Vercel posts a preview URL automatically)
3. Merge → staging auto-deploys → QA tests on staging URLs
4. When clean: open PR from `staging` into `main` → merge → prod auto-deploys

**Hotfix flow** (only when prod is actively broken):
1. Branch off `main`: `git checkout main && git checkout -b hotfix/<name>`
2. PR directly into `main` → merge → prod deploys
3. **Immediately sync `main` back into `staging`** via a PR (branch protection blocks direct pushes):
   ```bash
   gh pr create --base staging --head main --title "sync: post-hotfix from main"
   ```
   Merge that PR to keep staging in lockstep with prod.

**Migrations:**
- Prisma migrations in `backend/prisma/migrations/` are committed to git
- Render runs `npx prisma migrate deploy` on every backend deploy against the correct env's `DATABASE_URL`
- **Never edit a deployed migration** — always create a new one

**Rollback:**
- Code: one-click "Rollback" in Render dashboard or "Promote" previous deploy in Vercel
- If those aren't enough: `git revert <sha>` on `main` and push → auto-deploys the revert
- DB: no automated migration rollback; requires user-in-the-loop recovery

**Branch protection:** enable on both `main` and `staging` in GitHub settings — no direct pushes, PR required. Prevents accidents.

**Workflow enforcement:** the `ship-changes` skill (`.claude/skills/ship-changes/SKILL.md`) auto-triggers when Claude is asked to push/merge/deploy. It encodes the flow above and refuses shortcuts that would skip staging.

---

## Section 3 — Supabase Project Plan ✅ Approved

**Current state:** one Supabase project holding all dev/test data.

**Target state:**
| Project | Purpose | Data | Cost |
|---|---|---|---|
| `alpha-crm-staging` (rename of current) | Staging — QA work | Kept as-is | Free |
| `alpha-crm-prod` (new) | Production — dormant until go-live | Empty schema + state tax rates only | Free |

**Execution steps via Supabase MCP** (run after full design approval):
1. Authenticate MCP, list projects, verify access to current project
2. Grep `frontend/src` and `backend/src` for hardcoded Supabase hostnames → move any found into env vars first
3. Rename current project → `alpha-crm-staging` (metadata only; no data impact)
4. Create new project `alpha-crm-prod` in same organization
5. Run `npx prisma migrate deploy` against new prod DB to apply schema
6. Run `npm run seed:tax-rates` against prod — tax rates only, no admin/sample data. (This npm script is added in Phase A Step 0 since it doesn't yet exist; it wraps `tsx src/seed-tax-rates.ts`.)
7. Replicate staging Storage bucket (`attachments`) config to prod:
   - Inspect staging via SQL in the Supabase SQL editor: `SELECT * FROM storage.buckets; SELECT * FROM storage.policies WHERE bucket_id = 'attachments';` (or read current RLS via the dashboard)
   - Create matching bucket in prod via Supabase dashboard → Storage → New bucket → `attachments` (same public/private setting)
   - Apply the same RLS policies in prod's SQL editor by running the generated `CREATE POLICY ...` statements
   - Supabase MCP does not currently expose storage-bucket/RLS management; doing this via SQL + dashboard is intentional
8. Capture 5 credentials per env × 2 envs = 10 total: `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

**Admin user for prod:** NOT created now. Created at go-live via existing `seed.ts`.

---

## Section 4 — Render Service Configuration ✅ Approved (revised after spec review)

**Two services, one per env.** Both use: GitHub auto-deploy, **repo root** as root dir (this is an npm workspaces monorepo), Node 20, health check at `/health`.

| Setting | Staging | Production |
|---|---|---|
| Service name | `alpha-crm-test-env` | `alpha-crm-api` |
| Plan | Starter ($7/mo) | Free ($0) |
| Branch | `staging` | `main` |
| Root Directory | *(empty — repo root)* | same |
| Build Command | `npm ci && cd backend && npx prisma generate && npx tsc && npx prisma migrate deploy` | same |
| Start Command | `cd backend && npm start` | same |
| `NODE_VERSION` env var | `20` (explicit — without this Render defaults to an older Node) | same |

**Why root dir is repo root, not `backend/`:** the monorepo has one `package-lock.json` at root driving both workspaces. Setting Render root to `backend/` would skip workspace resolution and potentially install the wrong deps. Building from repo root uses the lockfile correctly.

**Why `prisma generate` runs before `tsc`:** the backend imports types from `@prisma/client`, which only exist after `prisma generate`. On a fresh Render build container there's no cached client, so `tsc` would fail to compile. Order is: install → generate → compile → migrate.

**Render Free hours note:** Render Free gives **750 instance-hours/month per account** (not per service) — enough for one service running 24/7 (720 hrs). Our plan fits: only prod is on Free; staging is paid Starter. Any future additional Free services would cannibalize the same budget.

**Rate limiter state note:** `express-rate-limit` uses in-memory store — counters reset whenever Render restarts the service (deploy, spin-down, crash). Acceptable for Phase 0; if multiple instances or hard security guarantees needed later, move to Redis-backed store.

**Connection strings** — Supabase pooled (port **6543**, `pgbouncer=true`) as `DATABASE_URL`, direct (port **5432**) as `DIRECT_URL` for migrations. **Do NOT add `connection_limit=1`** — that's the serverless pattern; Render is a long-running process where serialized DB calls would tank throughput. The default pooler limit is fine.

**Migration strategy** (clarified after spec review):
- `npx prisma migrate deploy` in the build command applies pending migrations against the env's DB
- If a migration fails, the build fails and the previous deploy keeps serving → old code + old schema (safe)
- If a migration succeeds but the subsequent build step fails, the DB is ahead of code — rare, recoverable, but note it
- **Rule of thumb for zero-downtime:** write additive-only migrations (add columns/tables, don't rename or drop in one step). Multi-step schema changes split across deploys

**Cron reliability on Free tier** (corrected after spec review):
- In-process `node-cron` + 14-min keep-alive ping works **most** of the time, but cron is **best-effort on Free tier** — if the service happens to be restarting during the scheduled minute (e.g., due to a deploy or platform-level restart), the cron may miss that day
- Acceptable for Phase 0 prod because prod DB is empty/dormant — nothing to expire
- At go-live (Render Starter, always-on), cron fires reliably
- If best-effort becomes unacceptable: promote the cron to Render Cron Jobs (paid, but cheap for short jobs) or trigger it externally via UptimeRobot with a secret header hitting `/api/internal/run-estimate-expiration`

**The DB check lives on `/health/deep`** (new requirement from spec review; `/health` itself stays database-free since #3106):
- The original `/health` at `backend/src/app.ts:43` returned `{status:'ok'}` without touching Prisma
- Supabase Free pauses after 7 days if the DB sees zero queries — a non-DB health check means prod DB could pause even though the backend is "alive"
- Fix during execution: a trivial `SELECT 1` via Prisma (or a cached `prisma.user.count()` with short TTL), returning `{status:'ok', db:'ok'}` (first put on `/health`, now `/health/deep`)
- Added as a code change in the execution plan (Phase A Step 0)

**Keep-alive (prod Free tier):** UptimeRobot free → `GET /health/deep` every 14 min. Also acts as uptime monitoring. It must be `/health/deep`: `/health` no longer touches the database, so a monitor on `/health` neither keeps a free-tier database from pausing nor notices a database outage.

**Stripe webhooks:** two endpoints registered in Stripe test mode, one per env, each with its own `STRIPE_WEBHOOK_SECRET`.

**Env vars per service:** `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NODE_ENV=production`, `NODE_VERSION=20`, `PORT` (Render-injected), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `FRONTEND_URL`.

(No `JWT_SECRET` — the env schema declares it optional and `backend/src/config/env.ts:19-20` confirms it's unused because Supabase handles JWT verification. Removed from the list after re-review.)

(No `EMAIL_FROM` override — the default `no-reply@alphasecurityus.com` in `backend/src/config/env.ts:29` is intentional and the user confirmed it's fine to leave as-is. If Resend has verification issues with this sender, surfaces as email delivery failure and we'll handle then.)

---

## Section 5 — Vercel Setup ✅ Approved

**One Vercel project, two envs via Git branches.** `main` → production, `staging` branch → preview (stable staging URL), every PR → ephemeral preview URL.

| Setting | Value |
|---|---|
| Framework preset | Vite |
| Root Directory | `frontend` |
| Build / Output / Install | auto-detected from Vite (`npm run build`, `dist`, `npm install`) |
| Node version | 20 |
| Production branch | `main` |
| Tier | Hobby now → Pro ($20/mo) at go-live |

**Env vars scoped per Vercel environment:**
- `VITE_API_URL` — points at correct Render backend per env
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — per env
- `VITE_STRIPE_PUBLISHABLE_KEY` — `pk_test_...` both envs

**Pre-flight check:** grep `frontend/src` for hardcoded `localhost:3000` and `.onrender.com` to ensure all API calls go through `import.meta.env.VITE_API_URL`.

**CORS:** Express `FRONTEND_URL` (Section 4) whitelists the matching Vercel env.

---

## Section 6 — Environment Variables & Secrets ✅ Approved (revised after spec review)

**Storage locations:** Render dashboard (backend), Vercel dashboard (frontend), local `.env` (dev — git-ignored). Nothing sensitive in git, ever.

**Full inventory:** 11 backend vars × 2 envs + 4 frontend vars × 2 envs = ~30 values to set, most Claude-generated via MCP. User-provided values: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (×2, unique per env), `RESEND_API_KEY`, `VITE_STRIPE_PUBLISHABLE_KEY`.

**Local dev setup** (expanded after spec review):
- Local `backend/.env` and `frontend/.env` point at **staging Supabase** for read/write experimentation
- Use the pooled `DATABASE_URL` (port 6543) — same as Render staging uses — so local behaves like staging
- **NEVER run `npx prisma migrate dev` or `prisma db push` against staging** — those commands modify schema destructively and will corrupt the shared staging DB for other developers/QA. Only `prisma migrate deploy` (which applies already-committed migration files idempotently) is safe against shared envs
- For schema experiments: spin up a local Postgres via Docker (`docker run -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16`) and point a separate `.env.local.schema` at it. Iterate there, then commit the migration and let staging pick it up on the next deploy

**Frontend secret prefix rule** (new from spec review):
- Anything with `VITE_` prefix is **baked into the browser bundle** and readable by any visitor — it's public
- Rule: **NEVER prefix `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `STRIPE_SECRET_KEY`, `RESEND_API_KEY`, or any other server-only secret with `VITE_`**. A single typo there leaks the key permanently
- Safe frontend values: `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_STRIPE_PUBLISHABLE_KEY`. Anything else is server-only

**Resend limits to be aware of** (flagged by spec review):
- Free tier: **100 emails/day, 3,000/month** (resend.com/pricing)
- Easy to exhaust if an estimate-send loop misbehaves (e.g., retry storm on a failed webhook)
- Phase 0 MVP usage is nowhere near this ceiling; worth a glance at logs weekly during setup
- Upgrade to Resend Pro ($20/mo) unlocks 50k/month — do only when real customer traffic justifies it

**`.env.example` convention:** project already uses this (standard Node/JS convention — confirmed across `backend/`, `frontend/`, and repo root). Templates checked into git with placeholder values only.

**`.gitignore` explicit verification list** (from spec review):
Ensure these patterns are present before first push to protected branches:
- `.env` (catches `.env` in any subdirectory)
- `.env.*` (catches `.env.local`, `.env.production`, `.env.staging`, `.env.development`, etc. in any subdir)
- Current `.gitignore` has `.env`, `.env.local`, `.env.production` — needs `.env.*` added to catch future variants

**Secret handoff protocol:** user pastes external keys directly into Render/Vercel dashboard (preferred), or into chat for Claude to paste into platform (acceptable). Never committed to repo, even temporarily.

**Leak response:** rotate at source → update in dashboards → redeploy → purge from git history with BFG if committed.

---

## Section 7 — Execution Plan & Go-Live Playbook ✅ Approved

### Phase A — Setup (execute now, ~2-3 hrs total)

0. **Pre-flight code changes (Claude):**
   - Add a DB ping to the health endpoint (now `/health/deep`) (`prisma.$queryRaw\`SELECT 1\``) — keeps Supabase Free from auto-pausing on prod
   - Add `.env.*` pattern to `.gitignore` (currently missing; covers future variants)
   - Remove line `backend/prisma/migrations/**/migration_lock.toml` from `.gitignore` and commit the existing `backend/prisma/migrations/migration_lock.toml` — Prisma best practice is to track this so every env uses the same provider
   - Add `"seed:tax-rates": "tsx src/seed-tax-rates.ts"` to `backend/package.json` scripts so Section 3 Step 6 is a clean `npm run seed:tax-rates`
   - Grep `frontend/src` + `backend/src` for hardcoded Supabase URLs / `localhost:3000` → move to env vars
   - Commit these changes via a feature branch → PR into `staging` per `ship-changes` flow

1. **Database (Claude + Supabase MCP):** rename current → `alpha-crm-staging`; create `alpha-crm-prod`; run `prisma migrate deploy` + tax-rate seed against prod; replicate Storage bucket config via MCP; capture 10 credentials

2. **Backend hosting (User + Claude):** User signs up for Render + connects GitHub. Claude creates `alpha-crm-test-env` (Starter) and `alpha-crm-api` (Free) with env vars per Section 4, triggers deploys, verifies `/health/deep` returns `{status:'ok', db:'ok'}`

3. **Frontend hosting (User + Claude):** User confirms Vercel + grants repo access. Claude creates project, sets build config + env vars, deploys `main` and `staging` branches

4. **External services (User + Claude):** User creates two Stripe webhook endpoints in test mode (one per env URL), hands Claude the two `STRIPE_WEBHOOK_SECRET`s + `STRIPE_SECRET_KEY` + `VITE_STRIPE_PUBLISHABLE_KEY` + `RESEND_API_KEY`

5. **Keep-alive + monitoring (User):** UptimeRobot → prod `/health/deep` → 14 min interval → email alerts

6. **Branch protection (User):** GitHub settings → protect `main` and `staging` → PR-required, no direct pushes, require status checks to pass

7. **Smoke test (Both):**
   - Staging likely already has an admin from prior dev work — **verify** with a quick query before reseeding. Only run `npm run seed` against staging if no admin exists
   - Run full end-to-end on staging: log in → create lead → create estimate → send (Resend email) → walkthrough → mark deposit paid (Stripe test card) → complete job → invoice
   - Fix any breakage immediately before declaring setup done

### Phase B — Go-live playbook

**See standalone reference:** [`md_files/plans/project/go-live-playbook.md`](./go-live-playbook.md) — 11-step checklist covering domain purchase, DNS, Resend verification, Render/Vercel tier flips, Stripe live mode, first admin user, webhook re-registration, and internal announcement. ~1 hr total. Steady-state monthly cost after go-live: **$34/mo** (Render ×2 + Vercel Pro).

### Rollback during Phase A

Most Phase A actions are reversible: delete any Render/Vercel resource at no charge, `main` untouched until first approved PR. Caveats:
- **Supabase project deletion is soft-delete for 7 days, then permanent.** If you delete a project by mistake you have 7 days to recover via Supabase support or the "Restore" option in the dashboard. After that it's gone.
- **Current Supabase project rename** (staging → alpha-crm-staging) is pure metadata and trivially reversible
- **Prisma migrations on new prod DB** are destructive in the sense that re-running against a different target isn't idempotent; if we need to redo, delete the prod Supabase project and start over

Claude will stop and report the exact state if any step fails, and we decide together whether to continue or roll back.

### Explicitly NOT in scope

GitHub Actions CI, Sentry/observability, custom backup tiers, secret rotation schedule, Redis-backed rate limiting. All "add later if needed," not MVP-critical.

---

## Appendix — Sources consulted

- [Render Pricing 2026](https://render.com/pricing)
- [Render Free tier behavior](https://render.com/docs/free)
- [Vercel Hobby fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines)
- [Supabase pricing & free tier limits (official)](https://supabase.com/pricing)
- [Supabase pausing / unpausing pro & free](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Prisma on Vercel / serverless guidance](https://www.prisma.io/docs/orm/prisma-client/deployment/serverless/deploy-to-vercel)
- [Cloudflare Workers Express support](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/)
- [Oracle Cloud Free Tier reality check](https://space-node.net/blog/oracle-vps-free-tier-review-2026)
