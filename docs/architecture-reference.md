# ALPHA CRM — Architecture Reference (on-demand detail)

> Detail moved out of `CLAUDE.md` to keep the auto-loaded context lean. Read this file when you need the specifics; `CLAUDE.md` keeps the short pointers.

## Database Schema (Prisma)

**Models:** User, Department, Customer, ServiceLocation, Lead, Estimate, EstimateLineItem, Deposit, EstimateSendConfig, StripeEvent, Job, JobCharge, Invoice, Payment, Attachment, Note, TimelineEvent, StateTaxRate, AppSetting

**Enums:** Role (ADMIN, SALES, DISPATCHER, TECHNICIAN), LeadStatus, EstimateStatus (DRAFT, SENT, PENDING, APPROVED, DECLINED, EXPIRED, CANCELLED), DepositStatus (REQUESTED, PAID, VOIDED, REFUNDED), JobStatus, InvoiceStatus, PaymentMethod (CARD, CASH, CHECK, BANK_TRANSFER), AttachmentEntity, NoteEntity

**Key relationships:**
- Customer → many ServiceLocations, Leads, Jobs
- Lead → many Estimates
- Estimate → many LineItems, one Deposit, one Job
- Job → many JobCharges, one Invoice
- Invoice → many Payments
- Attachment/Note/TimelineEvent → polymorphic (entity_type + entity_id)

> Note: the entity-model redesign (see `MEMORY.md`) reshapes parts of this — Deposit became `kind=DEPOSIT` Invoice, `Estimate.customer_id`/`Deposit`/`JobCharge` dropped on `servwave`. Confirm against the live schema before relying on the above.

## Auth Architecture

- **Flow:** Frontend → `POST /api/auth/login` → Backend calls `supabase.auth.signInWithPassword()` → returns JWT + user profile (incl. `organization_id`)
- **JWT Verification:** Backend uses `supabaseAdmin.auth.getUser(token)` with service role key
- **User Profile:** Stored in Prisma `users` table (role, is_active, name, **organization_id**); Supabase Auth manages passwords
- **Middleware Chain:** `authenticate` (JWT verify → `req.user` incl. `organization_id`) → `authorize(...roles)` (RBAC) → `validate(zodSchema)`
- **User Management:** Admin-only via `/api/users` CRUD; `POST /api/users` creates in both Supabase Auth + Prisma (login user)
- **Staff (no login):** `POST /api/users/staff` creates a Prisma `User` row with `has_login=false` + empty `password_hash`, does NOT call Supabase Auth. Staff appear in `GET /api/users/assignable` (active users sorted by department, scoped per `?purpose=`), used by `<AssigneeSelect />`. `POST /api/users/:id/invite` is a 501 stub for the future upgrade-to-login path.
- **No self-registration** — users and staff are admin-created only
- **JWT lifetimes:** Supabase-managed. Dashboard → Authentication → Sessions. access = 3600s (1h), refresh = 30d. Documented in `.env.example`.

## Multi-Tenancy (§3.1)

- **Pattern:** Every authenticated controller spreads `tenantWhere(req)` from `backend/src/lib/tenant.ts` into every Prisma `where` and `data`. Returns `{ organization_id: req.user!.organization_id }`.
- **Identity:** Customer-facing numbers (`lead_number`, `estimate_number`, `job_number`, `invoice_number`) are per-org via composite uniques `(organization_id, *_number)`. UUIDs (`id`) are backend-only. Public links use `public_token`.
- **Numbering:** `allocateNumber(tx, entity, orgId)` in `backend/src/lib/numbering.ts` — single `UPDATE organizations ... RETURNING` with row-level lock, no race condition. Per-org `*_prefix`, `number_padding`, `*_next_number`, `*_first_issued_at` on Organization.
- **Settings API:** `PATCH /api/organization` accepts numbering settings. Lock-after-first-issue + collision check + Zod prefix regex `^[A-Za-z0-9-]{1,10}$`. `*_first_issued_at` is stripped from inbound payload (only allocator writes it).
- **Schema:** TimelineEvent + AppSetting both have `organization_id`. AppSetting PK is composite `(organization_id, key)`. All 6 tenant-scoped models had DB default removed from `organization_id` — missing org_id now fails NOT NULL.
- **Public routes** (`/api/{resource}/:id/public`) load org from the entity row (no `req.user`).
- **Webhook validation deferred** to §5.7 (B&G uses `payment_provider=NONE`; Alpha gap is theoretical).
- **Rate Limits:** 100 req/15min (API), 5 attempts/15min (auth, skips successful)
- **Frontend:** Zustand auth store, Axios interceptor auto-attaches JWT, auto-refresh on 401

## Security (§3.3 + §3.4)

- **CORS allowlist (§3.3):** `CORS_ALLOWED_ORIGINS` env var (optional, comma-separated) drives Express CORS. Falls back to `FRONTEND_URL` when unset. Parser in `backend/src/lib/cors-origins.ts`.
- **Helmet (§3.3):** `frameguard: { action: 'deny' }`, CSP default, `X-Powered-By` stripped. Configured in `backend/src/app.ts`.
- **Production boot guard (§3.3):** `assertNoTestRoutesInProduction(app)` in `backend/src/lib/test-routes-guard.ts` refuses to start if `/api/test/*` routes are registered while `NODE_ENV=production`.
- **TLS-required DB (§3.4):** `env.ts` `superRefine` rejects boot in production if `DATABASE_URL` or `DIRECT_URL` is missing `?sslmode=require`. Defense-in-depth alongside Supabase's server-side Enforce SSL toggle.
- **DB connection layout (§3.4):** `DATABASE_URL` = port 6543 (PgBouncer pooler, `pgbouncer=true&connection_limit=1`, raised to 10) for runtime; `DIRECT_URL` = port 5432 (direct, session mode) for `prisma migrate deploy`. Both require `sslmode=require` in production.
- **Hosting region (perf, 2026-05-28):** Prod backend runs on Render in **Virginia (us-east)**, co-located with Supabase `us-east-1`. Relocated from Oregon (us-west), which added ~70ms per round-trip and caused ~1-2s page loads (#34; estimates list 2,000ms→116ms after the move). **Keep compute co-located with the DB — never reintroduce a cross-region split.** Vault `Learnings/Cross-Region-Latency-Render-Supabase.md`.
- **Webhook secret regression test (§3.4):** `backend/src/__tests__/no-hardcoded-stripe-secrets.test.ts` fails if any `whsec_*` literal appears outside `__tests__/` or `lib/stripe.ts`.
- **gitleaks (§3.4):** `.gitleaks.toml` at repo root extends the default ruleset with an allowlist for fixtures and third-party-embedded keys. Full-history scan reports 0 unallowlisted findings.
- **Supabase Storage RLS:** Policies must use `TO public` with `auth.role() = 'service_role'` JWT-claim check, NOT `TO service_role` Postgres role binding. Storage runs Postgres queries as `authenticator`, not `service_role`, so role-bound policies never match. Vault `Learnings/Supabase-Storage-Service-Role-RLS.md`.
- **Key rotation cadence:** prod Supabase JWT secret + service_role + anon + Resend keys rotated 2026-05-20 (§3.4 Phase 2). Stripe in sandbox; live-mode rotation tracked in GitHub issue #41.

## Live line (one server only)

`GET /api/live` (#3472, `backend/src/services/live/liveLines.ts`) keeps one long-lived event stream per open staff
screen; Spider pushes its pop-up, red-frame and summary changes down it (`services/spider/liveMessages.ts`), and the
screen keeps a 5-minute safety check while it is open (30 s when it is not). Sign-in is checked once when a line opens;
an open line holds no database connection. Caps: 5 lines per person, `LIVE_LINES_MAX` (default 2,000) per server.

**Before a second backend server, these messages must go through Redis** (or another shared channel): the lines live in
one process's memory, so today a message reaches only the screens connected to the server that sends it.

## Obsidian Knowledge Base

**Vault path:** `../Vault/ALPHA_CRM_VAULT` (a sibling of the repo root — its own git repo, outside the app repo). Resolve from `git rev-parse --show-toplevel` + `/../Vault/ALPHA_CRM_VAULT`.
**Access:** MCP tools (`mcp__obsidian__*`) — search_notes, read_note, write_note, patch_note, list_directory, get_frontmatter, get_vault_stats

### When to Consult the Vault (Smart Routing)
- **Architecture, decisions, history, planning, ideas** → Search vault FIRST, then code
- **Small bug fixes, code-level changes** → Just read the code
- **"Why did we do X?"** → `Decisions/` · **"What should I work on?"** → `index.md` → `Status/Current-Focus.md`
- **"How does X work?"** → the module note (e.g. `Modules/Estimates.md`) · **"What ideas exist?"** → `Ideas/` · **"What went wrong?"** → `Learnings/` · **"End-to-end flow"** → `Workflows/`

### How to Search the Vault
1. **Start with `index.md`** — orient, find the right page
2. **`search_notes`** for keywords when you don't know the page
3. **`read_note`** when you know the path
4. **`get_frontmatter`** to filter by type/module/status

### Vault Structure
```
index.md              — Project MOC (always read first)
log.md                — Append-only session log
Modules/              — 13 hub pages (Auth, Customers, Leads, etc.)
Architecture/         — 8 system notes (Tech-Stack, DB Schema, API, etc.)
Workflows/            — 6 flow notes + 2 canvas diagrams
Product/              — 3 business context notes
Decisions/            — 12 "why X over Y" notes
Ideas/                — 10 future improvement notes
Learnings/            — 8 hard-won lesson notes
Status/               — 6 project status notes (Build Progress, Current Focus, etc.)
Bases/                — 5 queryable database views
Plans-Index.md        — Maps md_files/ plans to modules
```

### Vault Conventions
- **Frontmatter:** Every note has `type`, `created`, usually `module`, `status`, `tags`
- **Wikilinks:** Module names always linked: `[[Estimates]]`, `[[Stripe-Integration]]`
- **index.md** is the MOC — lists every page with a one-line summary
- **log.md** is append-only — chronological record

### Two-System Split
- `md_files/` = active technical plans and specs (implementation details, step-by-step)
- Obsidian vault = the full picture (architecture, decisions, ideas, status, history, learnings, workflows, product)
- Plans in `md_files/` are REFERENCED from vault module notes, not duplicated

## Development Commands

```bash
npm install                    # Install all workspaces
npm run dev:backend            # Start Express on port 3000
npm run dev:frontend           # Start Vite on port 5173
npm test --workspace=backend   # Run all backend tests
npx playwright test --config=e2e/playwright.config.ts  # E2E (from frontend/, both servers running)
npx tsc --noEmit               # Type-check frontend (from frontend/)
npx prisma validate            # Validate schema (from backend/)
npx prisma migrate dev         # Run migrations (from backend/)
npx prisma studio              # DB browser (from backend/)
```
