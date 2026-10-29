# ALPHA CRM — Phase 0 MVP Building Plan

## Context

We are building ALPHA CRM, an FSM CRM platform for SMB contractors (5-30 technicians). This plan covers Phase 0 MVP only — an internal dual-run validation system. No code exists yet; the project currently contains only documentation files in `md files/`.

The plan is structured so that each step is independently reviewable and testable before moving to the next. External credentials (Supabase, Stripe) are plugged in by the user when ready.

## Decisions Made

| Decision | Choice |
|----------|--------|
| Roles | Admin, Sales, Dispatcher, Technician |
| Email/SMS | Real email (SendGrid/SMTP), mock SMS (log only) |
| Deployment | Local dev first, deploy later |
| Git | Initialize from Step 1 |
| DB schema | Full schema upfront in Step 1 |
| Tax rate | Single configurable rate |
| Estimate expiration | Manual only |
| Scheduling conflicts | Warning only (no hard block) |
| Numbering | EST-YYYY-NNNN, JOB-YYYY-NNNN, INV-YYYY-NNNN |
| UI Design | Follow `UI Design Specification (JSONC).txt` |

---

## Step 1: Project Scaffolding & Database Schema

**Goal:** Monorepo structure, all dependencies installed, full Prisma schema, Git initialized. No auth yet — just the skeleton.

**What gets built:**
- Root `package.json` with npm workspaces (`frontend/`, `backend/`)
- Backend: Express + TypeScript project with Prisma, Zod, all middleware packages
- Frontend: Vite + React + TypeScript + shadcn/ui + Tailwind configured
- Full Prisma schema (all entities: User, Customer, ServiceLocation, Lead, Estimate, EstimateLineItem, Deposit, Job, JobCharge, Invoice, Payment, Attachment, Note, TimelineEvent)
- `.env.example` files for both frontend and backend (empty placeholders for Supabase/Stripe)
- `.gitignore`, Git repo initialized
- Basic Express server that starts and returns health check
- Basic React app that renders a "Hello ALPHA CRM" page

**You provide before this step:** Nothing — no credentials needed yet.

**How to test:**
- `npm install` from root succeeds
- `npm run dev` (backend) starts Express on port 3000, `/health` returns OK
- `npm run dev` (frontend) starts Vite on port 5173, shows landing page
- `npx prisma validate` passes (schema is valid, but no DB connection yet)
- Git repo is initialized with initial commit

---

## Step 2: Supabase Connection & Auth System

**Goal:** Working authentication — login, logout, session management, JWT middleware, RBAC middleware.

**What gets built:**
- Backend connects to Supabase PostgreSQL via Prisma
- Run initial Prisma migration (creates all tables)
- Supabase Auth integration (backend middleware verifies JWT)
- Auth API endpoints: `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/refresh`, `GET /api/auth/me`
- RBAC middleware (`authorize()` function)
- User management API: `GET/POST/PATCH /api/users` (Admin only)
- Frontend: Supabase client setup, Axios interceptor with JWT
- Frontend: Login page, auth state (Zustand store), protected route wrapper
- Seed script: create initial Admin user in Supabase Auth + users table
- Environment validation (Zod-based `env.config.ts`)

**You provide before this step:** Supabase project credentials (URL, anon key, service role key, database URL).

**How to test:**
- Prisma migration runs successfully against Supabase
- Seed creates admin user
- Login with admin credentials → receive JWT
- Protected endpoints reject unauthenticated requests (401)
- RBAC rejects unauthorized roles (403)
- Frontend login page works, redirects to dashboard shell on success

---

## Step 3: App Layout & Navigation Shell

**Goal:** The app chrome — sidebar, header, responsive layout, routing to empty pages. Follows the JSONC UI design spec.

**What gets built:**
- App layout: sidebar (260px) + header (64px) + main content area
- Sidebar navigation with grouped menu items (Dashboard, Leads, Estimates, Jobs, Invoices, Payments, Reports, Settings)
- Role-based menu visibility (Technician sees limited items)
- Mobile responsive: sidebar collapses on small screens
- React Router routes to placeholder pages for each section
- Design system tokens applied: colors (`#2563EB` primary, `#F43F5E` secondary), typography (Inter font), spacing, border radius, shadows per JSONC spec
- Dark mode support (optional — if you want it, or skip for MVP)

**You provide before this step:** Nothing additional.

**How to test:**
- App renders with sidebar + header on desktop
- Sidebar collapses on mobile viewport
- Clicking nav items routes to correct placeholder pages
- Active nav item is highlighted (blue background per spec)
- Colors, fonts, spacing match the JSONC design spec
- Unauthorized routes redirect to login

---

## Step 4: Customer & Lead Management

**Goal:** Full CRUD for customers and leads. First real data flowing through the system.

**What gets built:**
- **Backend:**
  - Customer API: `GET/POST/PATCH/DELETE /api/customers`, with service locations
  - Lead API: `GET/POST/PATCH /api/leads`, assign, walkthrough, mark-lost
  - Lead status transitions: New → Contacted → Estimating → Won → Lost
  - Permission enforcement (Sales sees only assigned leads)
  - Zod validators for all inputs
  - Timeline events auto-created on key actions
- **Frontend:**
  - Customers list page (table with search/filter)
  - Customer detail page (profile, locations, history timeline)
  - Customer create/edit form
  - Leads list page (table with status filters, color-coded statuses)
  - Lead detail page (info, walkthrough, timeline, linked estimates)
  - Lead create/edit form
  - Lead assignment (Dispatcher assigns to Sales)
  - Notes system (add notes to customers and leads)

**How to test:**
- Create a customer with service location
- Create a lead, assign to sales user
- Log in as Sales — only see assigned leads
- Update lead status through transitions
- Mark lead as lost (requires reason)
- Timeline shows all actions
- Search and filter work on list pages

---

## Step 5: Estimates & Deposits

**Goal:** Create estimates from leads, send via email, customer approval flow, deposit collection via Stripe.

**What gets built:**
- **Backend:**
  - Estimate API: CRUD, send, cancel, approve, decline
  - Estimate line items with auto-calculated totals
  - Auto-generated estimate numbers (EST-YYYY-NNNN)
  - Public estimate view endpoint (token-based, no auth required)
  - Email integration: send estimate link to customer (real SMTP)
  - Deposit API: request deposit, process payment
  - Stripe integration: create PaymentIntent, webhook handler
  - Business rules: multiple estimates per lead, only one approved at a time, deposit only after approval
- **Frontend:**
  - Estimates list page (filterable by status)
  - Estimate create/edit form (line items builder, notes, photos)
  - Estimate detail page (status, timeline, linked deposit/job)
  - Estimate send action (triggers email)
  - Public estimate page (customer views and approves/declines)
  - Deposit request flow
  - Stripe Elements for card payment on deposit page
  - Attachment upload (photos on estimates)

**You provide before this step:** Stripe test mode keys (publishable key, secret key, webhook secret). SMTP credentials (or SendGrid API key).

**How to test:**
- Create estimate from lead with line items → totals calculate correctly
- Send estimate → email arrives with link
- Open public link → see estimate, click approve
- Request deposit → customer sees payment page
- Pay deposit (Stripe test card) → deposit status becomes Paid
- Webhook confirms payment
- Try to create job without deposit → blocked
- Multiple estimates per lead, only one can be approved

---

## Step 6: Job Management & Scheduling

**Goal:** Create jobs from approved+deposited estimates, urgent job flow, scheduling calendar, technician assignment.

**What gets built:**
- **Backend:**
  - Job API: create (deposit-gated), schedule, assign, start, complete, cancel
  - Urgent job flow: create lead → start urgent job (requires urgency reason)
  - Job charges API (for urgent jobs)
  - Auto-generated job numbers (JOB-YYYY-NNNN)
  - Auto-populate job from estimate data
  - Scheduling conflict warnings
  - Timeline events for all job transitions
- **Frontend:**
  - Jobs list page (filterable by status)
  - Job detail page (scope, assignment, timeline, linked estimate/invoice)
  - "Create Job" button on estimate detail (only when deposit paid)
  - Weekly calendar view (react-big-calendar)
  - Unassigned jobs queue sidebar on calendar
  - Drag-and-drop or click to assign tech + time
  - Urgent job creation flow (confirmation modal → customer info → charges)
  - Job cancellation (requires reason)

**How to test:**
- Create job from approved estimate with paid deposit → job auto-populated
- Try to create job without deposit → blocked with clear message
- Schedule job: assign tech, set time window
- Calendar shows scheduled jobs with color coding
- Urgent job flow: create lead → start urgent → add charges
- Cancel job → requires reason, timeline updated
- Log in as Technician — only see assigned jobs

---

## Step 7: Technician Mobile Experience

**Goal:** Mobile-optimized views for technicians to manage their daily work.

**What gets built:**
- **Frontend (mobile-responsive):**
  - "Today's Jobs" list (time-ordered, card layout)
  - Job detail view (customer info, address with tap-to-navigate, phone with tap-to-call)
  - Status update buttons (Start Job → In Progress, Mark Complete)
  - Add notes from field
  - Photo capture (camera + gallery upload)
  - Completion confirmation
  - "+ New Urgent Job" prominent button
  - Urgent job mobile flow (confirmation → customer info → charges → invoice → payment)

**How to test:**
- Open app on mobile viewport (or phone)
- See today's jobs list
- Tap into a job → see details, address, phone
- Start job → status changes to In Progress
- Add notes and photos
- Mark complete → status changes
- Start urgent job flow on mobile

---

## Step 8: Invoicing & Payments

**Goal:** Generate invoices from completed jobs, deposit credit applied, send invoice, collect payment.

**What gets built:**
- **Backend:**
  - Invoice API: generate from job, send, public view
  - Auto-generated invoice numbers (INV-YYYY-NNNN)
  - Auto-apply deposit credit on standard flow invoices
  - Payment API: record card payment (Stripe) or cash payment
  - Invoice status auto-updates based on payments (Draft → Sent → Partial → Paid)
  - Email: send invoice link to customer
- **Frontend:**
  - Invoices list page (filterable by status, aging indicators)
  - Invoice detail page (line items, deposit credit, payments, timeline)
  - "Generate Invoice" on completed job detail
  - Send invoice action
  - Public invoice page (customer views + pays)
  - Stripe Elements for card payment
  - Cash payment recording (for urgent on-site)
  - Payment history on invoice

**How to test:**
- Complete a standard job → generate invoice → deposit credit applied automatically
- Amount due = total - deposit credit
- Send invoice email → customer clicks link → pays via Stripe
- Invoice status becomes Paid
- Urgent job: generate invoice → collect cash → record payment → Paid
- Partial payment scenario (if applicable)

---

## Step 9: Dashboard & Reports

**Goal:** Dashboard with KPI tiles and drilldowns. Reports page with filterable data.

**What gets built:**
- **Backend:**
  - Dashboard API: stats tiles (leads needing follow-up, estimates awaiting response, approved-no-deposit, jobs today, outstanding invoices, cash collected, sales by rep, cancellations)
  - Reports API: pipeline, estimate funnel, deposits, ops, finance, sales performance, closing rate, cancellation rates
  - Date range filtering on all report endpoints
- **Frontend:**
  - Dashboard page: metric cards in grid layout (per JSONC spec — `bg-white rounded-xl p-6 shadow-sm`)
  - Each tile: count/metric, label, click to drilldown
  - Role-based dashboard (Sales sees own data, Dispatcher sees global)
  - Reports page: date range filter, category sections
  - Each report: summary metrics at top, data table below
  - Charts where useful (Recharts — line/bar/donut per JSONC spec)

**How to test:**
- Dashboard shows accurate counts based on seeded/real data
- Click a tile → navigates to filtered list
- Sales user sees only their data
- Reports show correct data with date range filter
- Charts render correctly

---

## Step 10: Polish, Testing & Hardening

**Goal:** End-to-end flows work smoothly, edge cases handled, UI polished.

**What gets built:**
- Timeline/audit display on all detail pages (Customer, Lead, Estimate, Job, Invoice)
- Attachment management (upload, view, delete)
- Notes system fully integrated across all entities
- Permission enforcement audit (verify every endpoint)
- Error handling improvements (user-friendly error messages)
- Loading states, empty states, confirmation dialogs
- Mobile responsiveness review across all pages
- End-to-end test of standard flow (lead → payment)
- End-to-end test of urgent flow (lead → on-site payment)
- Bug fixes from testing

**How to test:**
- Run through complete standard workflow end-to-end
- Run through complete urgent workflow end-to-end
- Test as each role (Admin, Sales, Dispatcher, Technician)
- Test on mobile viewport
- Verify timeline accuracy across all entities
- Verify no permission leaks

---

## Summary of Review Gates

| Step | What you review | Credentials needed |
|------|----------------|-------------------|
| 1 | Project structure, dependencies, schema, dev servers run | None |
| 2 | Auth works, login/logout, RBAC enforced | Supabase credentials |
| 3 | Layout, navigation, responsive design, UI matches spec | None |
| 4 | Customer + Lead CRUD, assignment, status flow | None |
| 5 | Estimates, email sending, deposit payment | Stripe + SMTP credentials |
| 6 | Job creation (gated), scheduling calendar, urgent flow | None |
| 7 | Mobile tech experience, today's jobs, field workflow | None |
| 8 | Invoicing, deposit credit, payments | None |
| 9 | Dashboard tiles, reports, charts | None |
| 10 | Full end-to-end, polish, edge cases | None |
