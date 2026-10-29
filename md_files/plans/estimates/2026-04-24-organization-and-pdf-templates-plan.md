# Organization + Estimate PDF Templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a per-tenant `Organization` model, real PDF generation via `pdfmake`, two selectable templates (`alpha-classic`, `crm-default`), an admin Settings UI, and the email/public-page wiring — so Alpha Doors & Security can launch the dual-run with estimates indistinguishable from their incumbent Workiz template.

**Architecture:**
- Platform owns LAYOUT (pdfmake builders in code), Organization owns CONTENT (branding + T&C copy in DB)
- `pdfmake` + `PdfPrinter` server-side — no Chromium, no microservice
- Two PDF routes: authenticated (inline preview) + public token-gated (attachment download)
- Content-snapshot on send for legal reproducibility (§6.4 of the spec)

**Tech Stack:** Prisma 5, Express, pdfmake, sharp (logo resize), Supabase Storage, React + shadcn/ui + Tailwind, TanStack Query, React Hook Form + Zod, Playwright (E2E)

**Spec reference:** `md_files/specs/estimates/2026-04-24-organization-and-pdf-templates-design.md` — read it in full before starting Phase 1.

---

## Test Conventions (READ THIS FIRST — BEFORE COPY-PASTING ANY TEST SNIPPET)

This codebase uses **Vitest** + a small set of test helpers. Every test snippet later in this plan must be adapted to these conventions:

```typescript
// At the top of every test file:
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';                                      // default export, NOT createApp()
import { TEST_USERS, mockAuthAs, authHeader } from './helpers'; // canonical helpers
import { prisma } from '../lib/prisma';

describe('FEATURE', () => {
  beforeEach(() => mockAuthAs('admin'));   // sets up auth context for the test request

  it('does the thing', async () => {
    const res = await request(app)
      .get('/api/something')
      .set(authHeader('admin'));            // attaches Bearer token for that user role
    expect(res.status).toBe(200);
  });
});
```

Available auth roles in `TEST_USERS`: `'admin'`, `'dispatcher'`, `'sales'`, `'technician'`.

**Forbidden in tests** (these don't exist in this codebase):
- ❌ `import { createApp } from '../app'` → use `import app from '../app'`
- ❌ `signTestToken({ role: 'ADMIN' })` → use `mockAuthAs('admin') + .set(authHeader('admin'))`
- ❌ Jest globals — Vitest globals are not enabled; explicitly import them

**Supabase client** (Task 3.4 and any other backend Storage/Auth usage):
- ✅ `import { supabaseAdmin } from '../lib/supabase'`
- ❌ `import { supabase } from '../lib/supabase'` — does not exist

When this plan shows a test snippet, treat it as an outline of WHAT to assert, then adapt the imports/auth pattern above before pasting.

---

## File Structure Overview

### Backend — New files

```
backend/
├── prisma/
│   └── migrations/
│       └── 20260424000000_organization_and_tenant_fks/
│           └── migration.sql                    # created by `prisma migrate dev` + hand-edited
├── src/
│   ├── seed-organization.ts                     # populates Alpha's Terms/Notes/Payment Terms
│   ├── controllers/
│   │   └── organization.controller.ts           # GET/PATCH /api/organization, logo upload, preview-pdf
│   ├── routes/
│   │   └── organization.routes.ts               # /api/organization/*
│   └── lib/
│       └── pdf/
│           ├── index.ts                         # generateEstimatePdf(estimateId, options)
│           ├── fonts.ts                         # PdfPrinter + Inter font map
│           ├── fonts/
│           │   ├── Inter-Regular.ttf            # ~110 KB each
│           │   ├── Inter-Bold.ttf
│           │   ├── Inter-Italic.ttf
│           │   └── Inter-BoldItalic.ttf
│           ├── markdown.ts                      # Markdown → pdfmake AST
│           ├── preview-fixture.ts               # PREVIEW_ESTIMATE_FIXTURE constant
│           └── templates/
│               ├── registry.ts                  # { 'alpha-classic': fn, 'crm-default': fn }
│               ├── alpha-classic.ts             # buildAlphaClassicPdf(estimate, org) → docDefinition
│               ├── crm-default.ts               # buildCrmDefaultPdf(estimate, org) → docDefinition
│               └── __tests__/
│                   ├── markdown.test.ts
│                   ├── alpha-classic.test.ts
│                   └── crm-default.test.ts
│   └── __tests__/
│       ├── organization.test.ts                 # GET/PATCH + logo upload + preview-pdf
│       └── estimate-pdf.test.ts                 # PDF route integration tests
```

### Backend — Modified files

- `backend/prisma/schema.prisma` — add `Organization`, add `organization_id` FKs to 6 tables, add `snapshot_*` columns to `Estimate`
- `backend/src/controllers/estimate.controller.ts` — add `getPdf`, `getPublicPdf`, `updatePaymentMethod`; modify `send` to populate snapshot columns; modify `getPublic` to include org subset
- `backend/src/routes/estimate.routes.ts` — add new routes: `/:id/pdf`, `/:id/public/pdf`, `/:id/payment-method`; remove public `/:id/public/change-payment-method`
- `backend/src/lib/email.ts` — attach PDF to all estimate emails; swap hardcoded ALPHA CRM header for org branding
- `backend/src/controllers/webhook.controller.ts` — after Stripe `checkout.session.completed` for a deposit, send post-signature confirmation email with PDF
- `backend/src/app.ts` — mount new organization routes
- `backend/package.json` — add `pdfmake`, `@types/pdfmake`, `sharp` deps; add `db:seed:org` script
- `backend/tsconfig.json` — add asset include for font files (or use `cpx` script)
- `backend/src/__tests__/*.test.ts` — NO test code changes required (DB DEFAULT handles org_id injection)

### Frontend — New files

```
frontend/src/
├── pages/
│   └── OrganizationSettingsPage.tsx             # /settings/organization
├── components/
│   ├── settings/
│   │   ├── LogoUpload.tsx                       # drag-drop + preview
│   │   ├── ColorPicker.tsx                      # <input type="color"> wrapper
│   │   └── TemplateSelector.tsx                 # radio group + thumbnails
│   ├── estimates/
│   │   ├── PdfPreviewDialog.tsx                 # Dialog with iframe
│   │   └── ChangePaymentMethodDialog.tsx        # new for §9.5
├── lib/
│   └── api/
│       └── organization.ts                      # TanStack Query hooks
└── public/
    └── template-thumbs/
        ├── alpha-classic.png                    # ~150×200px
        └── crm-default.png
```

### Frontend — Modified files

- `frontend/src/pages/EstimateFormPage.tsx` — replace inline `EstimateDocumentView` preview with "Preview PDF" button + Dialog
- `frontend/src/pages/EstimateDetailPage.tsx` — replace inline view with embedded PDF iframe; add "Download PDF" button
- `frontend/src/pages/PublicEstimatePage.tsx` — rebrand (logo, color, footer); remove payment-method selector; add "Download PDF" button
- `frontend/src/components/layout/Sidebar.tsx` + `nav-config.ts` — add "Organization Settings" nav entry (Admin-gated)
- `frontend/src/App.tsx` (router) — add `/settings/organization` route

### DevOps — New files

- `.github/workflows/migration-check.yml` — CI job for migration + seed smoke test

### Vault — New + modified (post-implementation)

- `Decisions/Estimate-Content-Snapshot-On-Send.md` — new Decision note
- `Modules/Estimates.md` — update "Current State"
- `Ideas/MVP-Estimate-Template-Alpha-Security.md` — set `status: implemented`
- `log.md` — append session summary

---

## Prerequisites

Before starting Phase 1:

- [ ] Read the spec in full: `md_files/specs/estimates/2026-04-24-organization-and-pdf-templates-design.md`
- [ ] Confirm `pdfmake` and `sharp` are not already in `backend/package.json` (they aren't as of 2026-04-24)
- [ ] Obtain Alpha Doors & Security logo file (SVG preferred, else PNG ≥1200px wide) — place at `examples/workiz-alpha-estimates/alpha-doors-logo.<svg|png>` so it's ready to upload after Phase 3 Settings UI is live
- [ ] Obtain Inter font files (400, 700, 400-italic, 700-italic) — download TTFs from [rsms.me/inter/download/](https://rsms.me/inter/download/) and stage them at `backend/src/lib/pdf/fonts/` before Phase 2
- [ ] Create a git worktree for this feature per CLAUDE.md rule 9 (optional but recommended):
  ```bash
  git worktree add "C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm-worktrees\org-pdf-templates" -b feat/org-pdf-templates
  ```

---

## Phase 1 — Schema + Org Seed + Estimate Snapshot Columns

**Goal:** Data layer foundation. No controller/UI changes. Existing 605 tests must pass unmodified.

**Spec sections:** §6.1, §6.2, §6.3, §6.4

---

### Task 1.1: Add Organization model and FKs to schema.prisma

**Files:**
- Modify: `backend/prisma/schema.prisma`

- [ ] **Step 1:** Open `backend/prisma/schema.prisma`. Locate the bottom of the file (after the last `enum`). Insert the `Organization` model from spec §6.1:

```prisma
/// Fixed UUID for Alpha Doors & Security (single-tenant MVP seed).
/// Referenced directly by the DB DEFAULT on organization_id columns
/// so unscoped inserts (tests, seeders, existing controllers) route here
/// transparently until we onboard tenant #2.
///   ALPHA_ORG_ID = '00000000-0000-0000-0000-000000000001'

model Organization {
  id                      String   @id @db.Uuid
  name                    String   @db.VarChar(200)
  legal_name              String?  @db.VarChar(200)
  address_line1           String   @db.VarChar(200)
  address_line2           String?  @db.VarChar(200)
  city                    String   @db.VarChar(100)
  state                   String   @db.VarChar(50)
  postal_code             String   @db.VarChar(20)
  country                 String   @default("US") @db.VarChar(2)
  email                   String   @db.VarChar(200)
  phone                   String?  @db.VarChar(50)
  website                 String?  @db.VarChar(200)
  logo_url                String?  @db.Text
  brand_color             String   @default("#242424") @db.VarChar(7)
  estimate_template       String   @default("alpha-classic") @db.VarChar(50)
  estimate_terms          String   @db.Text
  estimate_notes          String   @db.Text
  estimate_payment_terms  String   @db.Text
  created_at              DateTime @default(now()) @db.Timestamptz(6)
  updated_at              DateTime @updatedAt @db.Timestamptz(6)

  users      User[]
  customers  Customer[]
  leads      Lead[]
  estimates  Estimate[]
  jobs       Job[]
  invoices   Invoice[]

  @@map("organizations")
}
```

- [ ] **Step 2:** Add `organization_id` field + back-relation to **User, Customer, Lead, Estimate, Job, Invoice**. Example for `User`:

```prisma
model User {
  // ... existing fields
  organization_id String       @db.Uuid @default(dbgenerated("'00000000-0000-0000-0000-000000000001'::uuid"))
  organization    Organization @relation(fields: [organization_id], references: [id])

  @@index([organization_id])
}
```

Repeat for `Customer`, `Lead`, `Estimate`, `Job`, `Invoice`. Each gets: the field + relation + `@@index`.

- [ ] **Step 3:** Add snapshot columns to the `Estimate` model (spec §6.4):

```prisma
model Estimate {
  // ... existing fields
  snapshot_terms          String?  @db.Text
  snapshot_notes          String?  @db.Text
  snapshot_payment_terms  String?  @db.Text
  // ... (organization_id field added in step 2)
}
```

- [ ] **Step 4:** Validate the schema:

```bash
cd backend && npx prisma validate
```

Expected output: `The schema at prisma/schema.prisma is valid`

- [ ] **Step 5:** Commit:

```bash
git add backend/prisma/schema.prisma
git commit -m "feat(db): add Organization model and tenant FK columns"
```

---

### Task 1.2: Generate and hand-edit migration

**Files:**
- Create: `backend/prisma/migrations/20260424000000_organization_and_tenant_fks/migration.sql`

The migration needs the Alpha row inserted BEFORE the DEFAULT clause is applied to FK columns (otherwise the DEFAULT references a non-existent row). Prisma's generator does the wrong order by default; we hand-edit.

- [ ] **Step 1:** Generate the draft migration:

```bash
cd backend && npx prisma migrate dev --name organization_and_tenant_fks --create-only
```

The `--create-only` flag produces the SQL without applying it.

- [ ] **Step 2:** Open the generated file: `backend/prisma/migrations/20260424*_organization_and_tenant_fks/migration.sql`. Reorder/augment so the file reads exactly this (no `etc.` — every statement spelled out so engineers can paste verbatim):

```sql
-- 1. Create organizations table
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "legal_name" VARCHAR(200),
    "address_line1" VARCHAR(200) NOT NULL,
    "address_line2" VARCHAR(200),
    "city" VARCHAR(100) NOT NULL,
    "state" VARCHAR(50) NOT NULL,
    "postal_code" VARCHAR(20) NOT NULL,
    "country" VARCHAR(2) NOT NULL DEFAULT 'US',
    "email" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(50),
    "website" VARCHAR(200),
    "logo_url" TEXT,
    "brand_color" VARCHAR(7) NOT NULL DEFAULT '#242424',
    "estimate_template" VARCHAR(50) NOT NULL DEFAULT 'alpha-classic',
    "estimate_terms" TEXT NOT NULL,
    "estimate_notes" TEXT NOT NULL,
    "estimate_payment_terms" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- 2. Insert Alpha seed row (stub — text fields populated by seed-organization.ts)
INSERT INTO "organizations" (
    "id", "name", "address_line1", "city", "state", "postal_code",
    "email", "website", "brand_color", "estimate_template",
    "estimate_terms", "estimate_notes", "estimate_payment_terms",
    "created_at", "updated_at"
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Alpha Doors & Security INC.',
    '1001 Willow Avenue',
    'Hoboken', 'NJ', '07030',
    'info@alphasecurityus.com',
    'https://alphadoorsnewjersey.com/',
    '#E11D2E',
    'alpha-classic',
    '', '', '',
    NOW(), NOW()
);

-- 3. Add organization_id columns (with DEFAULT pointing at Alpha UUID) to all six tables
ALTER TABLE "users"     ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE "customers" ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE "leads"     ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE "estimates" ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE "jobs"      ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
ALTER TABLE "invoices"  ADD COLUMN "organization_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;

-- 4. Add FK constraints (all six tables)
ALTER TABLE "users"     ADD CONSTRAINT "users_organization_id_fkey"     FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leads"     ADD CONSTRAINT "leads_organization_id_fkey"     FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jobs"      ADD CONSTRAINT "jobs_organization_id_fkey"      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices"  ADD CONSTRAINT "invoices_organization_id_fkey"  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Create indexes (all six tables)
CREATE INDEX "users_organization_id_idx"     ON "users"("organization_id");
CREATE INDEX "customers_organization_id_idx" ON "customers"("organization_id");
CREATE INDEX "leads_organization_id_idx"     ON "leads"("organization_id");
CREATE INDEX "estimates_organization_id_idx" ON "estimates"("organization_id");
CREATE INDEX "jobs_organization_id_idx"      ON "jobs"("organization_id");
CREATE INDEX "invoices_organization_id_idx"  ON "invoices"("organization_id");

-- 6. Add snapshot columns to estimates (nullable, no default)
ALTER TABLE "estimates"
  ADD COLUMN "snapshot_terms"         TEXT,
  ADD COLUMN "snapshot_notes"         TEXT,
  ADD COLUMN "snapshot_payment_terms" TEXT;
```

- [ ] **Step 2b:** Regenerate the Prisma client to pick up the new schema:

```bash
cd backend && npx prisma generate
```

(Auto-runs as part of `prisma migrate dev` but call it explicitly here so the engineer remembers it for any future schema-only edits.)

- [ ] **Step 3:** Apply the migration to dev DB:

```bash
cd backend && npx prisma migrate dev
```

Expected: migration succeeds, Prisma client regenerated.

- [ ] **Step 4:** Verify the seed row exists:

```bash
cd backend && npx prisma studio
# In Studio: open "organizations" table, confirm 1 row with id 00000000-...-000001
```

Or via psql:

```bash
psql "$DATABASE_URL" -c "SELECT id, name FROM organizations;"
```

Expected: one row, "Alpha Doors & Security INC."

- [ ] **Step 5:** Commit:

```bash
git add backend/prisma/migrations/
git commit -m "feat(db): migration for Organization + tenant FKs + snapshot columns"
```

---

### Task 1.3: Seed script — populate Alpha's T&C content

**Files:**
- Create: `backend/src/seed-organization.ts`
- Modify: `backend/package.json` (add `db:seed:org` script)

- [ ] **Step 1:** Create `backend/src/seed-organization.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const ALPHA_ORG_ID = '00000000-0000-0000-0000-000000000001';

const TERMS = `Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.`;

const NOTES = `1. Any change in products quantity or labor that is not qualified in this estimate will be additionally charged.

2. The warranty provided by Alpha Doors & Security applies only to parts, materials, and hardware supplied and installed by our company. Any alterations, modifications, or repairs performed by third parties or individuals not authorized by Alpha Locksmith & Security will result in the immediate voidance of the warranty. This includes, but is not limited to:
- The addition of materials or components to the originally installed hardware.

**Coverage:**
The warranty provided by Alpha Doors & Security applies only to parts, materials, and hardware supplied and installed by our company. This warranty is valid for 90 days from the date of installation completion. Accessories (e.g., cables, connectors, moldings) are covered for 30 days.

**Exclusions:**
The warranty will be voided under the following circumstances:
- Unauthorized Modifications or Repairs
- Tampering or Adjustments
- Damage from Misuse or Interference
- Acts of Vandalism

**Ownership:**
All materials and products remain the property of Alpha Doors & Security until payment is received in full.

**Service Hours:**
Warranty services are available Monday through Friday, 9:00 AM to 5:00 PM, excluding holidays. After hours rate apply before and after 9:00am to 5pm.

**Access Control in Door Replacement Project Disclaimer:**
The Company shall not be held responsible for the operation, compatibility, or condition of any existing access control systems, including but not limited to keypads, card readers, electric strikes, magnetic locks, intercoms, or other electronic security devices, whether integrated with the door being installed or located nearby.

**Post-Warranty Service:**
After the warranty period expires, any troubleshooting or repair services will be charged at an hourly rate per technician, with additional charges for materials and labor. Please inquire about our Extended Warranty options for continued coverage.

5. Customer will be responsible for building access arrangements to our technicians. Any access problems or any others work delays will by additional charged by an hourly rate.

6. Prices are subject to change after 60 days.

7. The purchaser shall be responsible for any patching, painting, ceiling tile replacement that may be required as a result of the proposed scope of work.

8. Change Orders: All Change orders should be written and submitted to ALPHA DOORS & SECURITY at least 48 Hours in advance.

9. All equipment will be owned by ALPHA DOORS & SECURITY until the last payment will be Settle. After the Last payment the equipment will by hand over to the client.`;

const PAYMENT_TERMS = `**Late Payment:** Any invoice amounts remaining unpaid beyond thirty (30) days of invoice date are subject to a late penalty charge of 5% interest per month, or the maximum rate allowed by law, whichever is less.

- 70% due upon acceptance
- 30% upon completion
- No refund on 70% deposit
- For credit card charges additional fee of 3.5% will apply
- Prices are subject to change after 60 days`;

async function main() {
  await prisma.organization.update({
    where: { id: ALPHA_ORG_ID },
    data: {
      estimate_terms: TERMS,
      estimate_notes: NOTES,
      estimate_payment_terms: PAYMENT_TERMS,
    },
  });
  console.log('Organization seeded:', ALPHA_ORG_ID);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 2:** Add `db:seed:org` script to `backend/package.json`:

```json
{
  "scripts": {
    "db:seed:org": "tsx src/seed-organization.ts"
  }
}
```

- [ ] **Step 3:** Run the seed:

```bash
cd backend && npm run db:seed:org
```

Expected output: `Organization seeded: 00000000-0000-0000-0000-000000000001`

- [ ] **Step 4:** Verify the data persisted:

```bash
psql "$DATABASE_URL" -c "SELECT LENGTH(estimate_terms), LENGTH(estimate_notes), LENGTH(estimate_payment_terms) FROM organizations;"
```

Expected: all three lengths > 100.

- [ ] **Step 5:** Run the full test suite to confirm existing tests still pass:

```bash
cd backend && npm test
```

Expected: all 605 tests pass. If any fail with `organization_id` errors, the DB DEFAULT isn't working — investigate schema.prisma.

- [ ] **Step 6:** Commit:

```bash
git add backend/src/seed-organization.ts backend/package.json
git commit -m "feat(db): add seed-organization script for Alpha T&C content"
```

---

### Task 1.4: CI migration test workflow

**Files:**
- Create: `.github/workflows/migration-check.yml`

- [ ] **Step 1:** Create `.github/workflows/migration-check.yml`:

```yaml
name: Migration Check

on:
  pull_request:
    paths:
      - 'backend/prisma/**'
      - 'backend/src/seed*.ts'

jobs:
  migration-check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test_migration
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install deps
        working-directory: backend
        run: npm ci
      - name: Run migrations
        working-directory: backend
        env:
          DATABASE_URL: "postgresql://postgres:test@localhost:5432/test_migration"
        run: npx prisma migrate deploy
      - name: Seed organization
        working-directory: backend
        env:
          DATABASE_URL: "postgresql://postgres:test@localhost:5432/test_migration"
        run: npx tsx src/seed-organization.ts
      - name: Verify Alpha org exists
        env:
          PGPASSWORD: test
        run: |
          COUNT=$(psql -h localhost -U postgres -d test_migration -tA -c "SELECT count(*) FROM organizations WHERE id = '00000000-0000-0000-0000-000000000001';")
          if [ "$COUNT" != "1" ]; then
            echo "Expected 1 Alpha org row, got $COUNT"
            exit 1
          fi
      - name: Verify no migration drift
        working-directory: backend
        env:
          DATABASE_URL: "postgresql://postgres:test@localhost:5432/test_migration"
        run: npx prisma migrate status
```

- [ ] **Step 2:** Commit:

```bash
git add .github/workflows/migration-check.yml
git commit -m "ci: add migration check workflow for Organization migration"
```

- [ ] **Step 3:** Push the branch and verify the workflow runs successfully on GitHub:

```bash
git push -u origin feat/org-pdf-templates
```

Watch the Actions tab on GitHub. The `Migration Check` job should pass.

---

**Phase 1 Exit Criteria (verify before moving on):**
- [ ] `npx prisma migrate deploy && npm run db:seed:org` runs clean on a fresh DB
- [ ] `npm test` — all 605 tests pass unchanged
- [ ] GitHub Actions `Migration Check` workflow passes
- [ ] `Organization` table has 1 row, Alpha UUID, populated text fields

---

## Phase 2 — PDF Pipeline + alpha-classic Template (Authenticated Route Only)

**Goal:** Ship a working PDF for Alpha's estimates. Admin can preview/download via authenticated route. Public route deferred to Phase 4.

**Spec sections:** §7.1, §7.2, §7.3, §7.4, §7.5, §7.7, §7.8, §7.9 (markdown)

---

### Task 2.1: Install dependencies and scaffold PDF module

**Files:**
- Modify: `backend/package.json`
- Create: `backend/src/lib/pdf/` (empty directory + stub files)

- [ ] **Step 1:** Install dependencies:

```bash
cd backend && npm install pdfmake sharp
npm install --save-dev @types/pdfmake
```

- [ ] **Step 2:** Stage Inter font files at `backend/src/lib/pdf/fonts/`:
- `Inter-Regular.ttf`
- `Inter-Bold.ttf`
- `Inter-Italic.ttf`
- `Inter-BoldItalic.ttf`

(Per the Prerequisites section — downloaded from rsms.me/inter.)

- [ ] **Step 3:** Add a `postbuild` script to copy fonts to `dist/`. Edit `backend/package.json`:

```json
{
  "scripts": {
    "build": "tsc && npm run copy-pdf-assets",
    "copy-pdf-assets": "cpx \"src/lib/pdf/fonts/**/*\" dist/lib/pdf/fonts"
  },
  "devDependencies": {
    "cpx": "^1.5.0"
  }
}
```

```bash
cd backend && npm install --save-dev cpx
```

- [ ] **Step 4:** Verify build passes:

```bash
cd backend && npm run build
ls dist/lib/pdf/fonts/   # should list 4 .ttf files
```

- [ ] **Step 5:** Commit:

```bash
git add backend/package.json backend/package-lock.json backend/src/lib/pdf/fonts/
git commit -m "feat(pdf): add pdfmake + sharp deps and Inter font files"
```

---

### Task 2.2: Font loader + PdfPrinter singleton

**Files:**
- Create: `backend/src/lib/pdf/fonts.ts`

- [ ] **Step 1:** Create `backend/src/lib/pdf/fonts.ts`:

```typescript
import path from 'path';
import PdfPrinter from 'pdfmake/src/printer';

const fontsDir = path.join(__dirname, 'fonts');

export const fonts = {
  Inter: {
    normal:      path.join(fontsDir, 'Inter-Regular.ttf'),
    bold:        path.join(fontsDir, 'Inter-Bold.ttf'),
    italics:     path.join(fontsDir, 'Inter-Italic.ttf'),
    bolditalics: path.join(fontsDir, 'Inter-BoldItalic.ttf'),
  },
};

export const printer = new PdfPrinter(fonts);
```

- [ ] **Step 2:** Write a smoke test. Create `backend/src/lib/pdf/__tests__/fonts.test.ts`:

```typescript
import { printer } from '../fonts';

describe('PdfPrinter initialization', () => {
  it('loads without errors', () => {
    expect(printer).toBeDefined();
  });

  it('can create a minimal document', (done) => {
    const doc = printer.createPdfKitDocument({
      content: [{ text: 'Hello', font: 'Inter' }],
      defaultStyle: { font: 'Inter' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      expect(pdfBuffer.length).toBeGreaterThan(100);
      expect(pdfBuffer.slice(0, 4).toString()).toBe('%PDF');
      done();
    });
    doc.end();
  });
});
```

- [ ] **Step 3:** Run it:

```bash
cd backend && npm test -- fonts.test.ts
```

Expected: both tests pass.

- [ ] **Step 4:** Commit:

```bash
git add backend/src/lib/pdf/fonts.ts backend/src/lib/pdf/__tests__/fonts.test.ts
git commit -m "feat(pdf): add PdfPrinter singleton + font loader"
```

---

### Task 2.3: Markdown parser (TDD)

**Files:**
- Create: `backend/src/lib/pdf/markdown.ts`
- Create: `backend/src/lib/pdf/__tests__/markdown.test.ts`

Supports: paragraphs (blank-line separated), bold (`**text**`), bullets (`- ` or `* `), numbered lists (`1. `). Returns pdfmake AST nodes.

- [ ] **Step 1:** Write the failing tests. Create `backend/src/lib/pdf/__tests__/markdown.test.ts`:

```typescript
import { markdownToPdfMake } from '../markdown';

describe('markdownToPdfMake', () => {
  it('returns a single paragraph for plain text', () => {
    const out = markdownToPdfMake('Hello world.');
    expect(out).toEqual([{ text: 'Hello world.', style: 'paragraph' }]);
  });

  it('splits paragraphs on blank lines', () => {
    const out = markdownToPdfMake('First.\n\nSecond.');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ text: 'First.', style: 'paragraph' });
    expect(out[1]).toEqual({ text: 'Second.', style: 'paragraph' });
  });

  it('parses bold inline', () => {
    const out = markdownToPdfMake('This is **important**.');
    expect(out[0]).toEqual({
      text: [
        { text: 'This is ' },
        { text: 'important', bold: true },
        { text: '.' },
      ],
      style: 'paragraph',
    });
  });

  it('renders bulleted lists', () => {
    const out = markdownToPdfMake('- One\n- Two\n- Three');
    expect(out[0]).toHaveProperty('ul');
    expect(out[0].ul).toEqual(['One', 'Two', 'Three']);
  });

  it('renders numbered lists', () => {
    const out = markdownToPdfMake('1. First\n2. Second');
    expect(out[0]).toHaveProperty('ol');
    expect(out[0].ol).toEqual(['First', 'Second']);
  });

  it('strips raw HTML tags defensively', () => {
    const out = markdownToPdfMake('Hello <script>alert(1)</script>.');
    expect(JSON.stringify(out)).not.toContain('<script>');
  });

  it('handles mixed paragraphs and lists', () => {
    const out = markdownToPdfMake('Intro paragraph.\n\n- Bullet A\n- Bullet B\n\nClosing.');
    expect(out).toHaveLength(3);
    expect(out[0].style).toBe('paragraph');
    expect(out[1]).toHaveProperty('ul');
    expect(out[2].style).toBe('paragraph');
  });
});
```

- [ ] **Step 2:** Run tests to confirm they fail:

```bash
cd backend && npm test -- markdown.test.ts
```

Expected: all tests FAIL with `Cannot find module '../markdown'`.

- [ ] **Step 3:** Implement `backend/src/lib/pdf/markdown.ts`:

```typescript
type InlineNode = { text: string; bold?: boolean };
type ParagraphNode = { text: string | InlineNode[]; style: 'paragraph' };
type ListNode = { ul: string[] } | { ol: string[] };
type Node = ParagraphNode | ListNode;

const HTML_TAG_RE = /<[^>]*>/g;
const BOLD_RE = /\*\*(.+?)\*\*/g;

function parseInline(line: string): ParagraphNode['text'] {
  const stripped = line.replace(HTML_TAG_RE, '');
  if (!BOLD_RE.test(stripped)) return stripped;
  BOLD_RE.lastIndex = 0;
  const parts: InlineNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = BOLD_RE.exec(stripped)) !== null) {
    if (m.index > last) parts.push({ text: stripped.slice(last, m.index) });
    parts.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < stripped.length) parts.push({ text: stripped.slice(last) });
  return parts;
}

export function markdownToPdfMake(input: string): Node[] {
  const safe = input.replace(HTML_TAG_RE, '');
  const blocks = safe.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const out: Node[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.every(l => /^[-*] /.test(l))) {
      out.push({ ul: lines.map(l => l.replace(/^[-*] /, '').trim()) });
    } else if (lines.every(l => /^\d+\. /.test(l))) {
      out.push({ ol: lines.map(l => l.replace(/^\d+\. /, '').trim()) });
    } else {
      out.push({ text: parseInline(block), style: 'paragraph' });
    }
  }
  return out;
}
```

- [ ] **Step 4:** Run tests:

```bash
cd backend && npm test -- markdown.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 5:** Commit:

```bash
git add backend/src/lib/pdf/markdown.ts backend/src/lib/pdf/__tests__/markdown.test.ts
git commit -m "feat(pdf): add markdown parser for Terms/Notes/Payment Terms"
```

---

### Task 2.4: Preview fixture constant

**Files:**
- Create: `backend/src/lib/pdf/preview-fixture.ts`

- [ ] **Step 1:** Create `backend/src/lib/pdf/preview-fixture.ts` using the exact fixture from spec §7.8:

```typescript
export const PREVIEW_ESTIMATE_FIXTURE = {
  id: 'preview-fixture',
  estimate_number: 'E00001',
  created_at: new Date('2026-04-22T12:00:00Z'),
  status: 'SENT' as const,
  subtotal: 1038.10,
  tax_rate: 0.06625,
  tax_amount: 68.77,
  total_amount: 1106.87,
  discount_type: null,
  discount_value: null,
  discount_name: null,
  discount_amount: 0,
  signature_data: null,
  signature_at: null,
  snapshot_terms: null,
  snapshot_notes: null,
  snapshot_payment_terms: null,
  lead: {
    service_address_line1: null,  // triggers "Same as billing"
    service_address_line2: null,
    service_city: null,
    service_state: null,
    service_zip: null,
    customer: {
      first_name: 'Jane',
      last_name: 'Doe',
      company_name: null,
      email: 'jane.doe@example.com',
      phone: '(555) 123-4567',
      service_locations: [{
        is_primary: true,
        address_line1: '123 Main Street',
        address_line2: null,
        city: 'Hoboken',
        state: 'NJ',
        zip: '07030',
      }],
    },
  },
  line_items: [
    { id: 'p1', sequence: 1,
      description: 'Maglock 1200P (Alarm Controls)\nExact Replacement',
      item_type: 'MATERIAL' as const, quantity: 1, unit_price: 499.00,
      is_taxable: true, line_total: 499.00,
      discount_type: null, discount_value: null, discount_amount: 0,
      price_book_item: null },
    { id: 'p2', sequence: 2,
      description: 'LABOR',
      item_type: 'SERVICE' as const, quantity: 2, unit_price: 225.00,
      is_taxable: true, line_total: 450.00,
      discount_type: null, discount_value: null, discount_amount: 0,
      price_book_item: null },
    { id: 'p3', sequence: 3,
      description: 'Comprehensive Service Plan\nIncludes 6 month warranty extension and priority response',
      item_type: 'SERVICE' as const, quantity: 1, unit_price: 99.00,
      is_taxable: true, line_total: 89.10,
      discount_type: 'PERCENTAGE' as const, discount_value: 10, discount_amount: 9.90,
      price_book_item: null },
  ],
};
```

- [ ] **Step 2:** Commit:

```bash
git add backend/src/lib/pdf/preview-fixture.ts
git commit -m "feat(pdf): add preview estimate fixture for Settings preview"
```

---

### Task 2.5: `alpha-classic` template builder (TDD with smoke tests)

**Files:**
- Create: `backend/src/lib/pdf/templates/alpha-classic.ts`
- Create: `backend/src/lib/pdf/templates/registry.ts`
- Create: `backend/src/lib/pdf/templates/__tests__/alpha-classic.test.ts`

Full visual fidelity vs pixel testing is impractical; use smoke tests that assert structural properties (correct text appears, pagination doesn't crash, signature block conditional works).

- [ ] **Step 1:** Create `backend/src/lib/pdf/templates/registry.ts`:

```typescript
import { buildAlphaClassicPdf } from './alpha-classic';

export const templateRegistry = {
  'alpha-classic': buildAlphaClassicPdf,
  // 'crm-default' added in Phase 3
} as const;

export type TemplateKey = keyof typeof templateRegistry;
```

- [ ] **Step 2:** Write failing tests. Create `backend/src/lib/pdf/templates/__tests__/alpha-classic.test.ts`:

```typescript
import { buildAlphaClassicPdf } from '../alpha-classic';
import { PREVIEW_ESTIMATE_FIXTURE } from '../../preview-fixture';
import { printer } from '../../fonts';

const FIXTURE_ORG = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Alpha Doors & Security INC.',
  legal_name: null,
  address_line1: '1001 Willow Avenue',
  address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030', country: 'US',
  email: 'info@alphasecurityus.com',
  phone: null,
  website: 'https://alphadoorsnewjersey.com/',
  logo_url: null,
  brand_color: '#E11D2E',
  estimate_template: 'alpha-classic',
  estimate_terms: 'Sample terms.',
  estimate_notes: '- Note A\n- Note B',
  estimate_payment_terms: '- 70% on acceptance',
};

describe('buildAlphaClassicPdf', () => {
  it('produces a valid docDefinition', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(doc).toHaveProperty('content');
    expect(doc).toHaveProperty('defaultStyle');
    expect(doc.defaultStyle.font).toBe('Inter');
  });

  it('renders the org name as fallback when logo_url is null', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Alpha Doors & Security INC.');
  });

  it('renders "Same as billing" when lead has no service address', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Same as billing');
  });

  it('renders the customer name and primary address', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Jane Doe');
    expect(json).toContain('123 Main Street');
  });

  it('includes line items with qty, price, amount', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Maglock 1200P');
    expect(json).toContain('$499.00');
    expect(json).toContain('LABOR');
  });

  it('includes subtotal, tax with rate, total', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Sub total');
    expect(json).toContain('$1,038.10');
    expect(json).toContain('6.625%');
    expect(json).toContain('$1,106.87');
  });

  it('omits signature block when signature_data is null', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).not.toContain('Customer Signature');
  });

  it('includes signature block when signature_data is present', () => {
    const signed = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      signature_at: new Date('2026-04-23T10:00:00Z'),
    };
    const doc = buildAlphaClassicPdf(signed as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Customer Signature');
  });

  it('prefers snapshot fields over live org fields when present', () => {
    const snapped = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      status: 'APPROVED' as const,
      snapshot_terms: 'SNAPSHOT TERMS',
      snapshot_notes: 'SNAPSHOT NOTES',
      snapshot_payment_terms: 'SNAPSHOT PAYMENT TERMS',
    };
    const doc = buildAlphaClassicPdf(snapped as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('SNAPSHOT TERMS');
    expect(json).not.toContain('Sample terms.');
  });

  it('renders through PdfPrinter without error', (done) => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const pdfDoc = printer.createPdfKitDocument(doc);
    const chunks: Buffer[] = [];
    pdfDoc.on('data', (c) => chunks.push(c));
    pdfDoc.on('end', () => {
      const buf = Buffer.concat(chunks);
      expect(buf.slice(0, 4).toString()).toBe('%PDF');
      expect(buf.length).toBeGreaterThan(1000);
      done();
    });
    pdfDoc.end();
  });
});
```

- [ ] **Step 3:** Run to confirm fail:

```bash
cd backend && npm test -- alpha-classic.test.ts
```

Expected: FAIL with module-not-found errors.

- [ ] **Step 4:** Implement `backend/src/lib/pdf/templates/alpha-classic.ts`. This is the largest single file in the plan — reference spec §7.5 step-by-step while writing:

```typescript
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { markdownToPdfMake } from '../markdown';

// Interfaces describe the shapes we consume — lenient for fixture + real data
interface EstimateForPdf {
  estimate_number: string;
  created_at: Date;
  status: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total_amount: number;
  signature_data: string | null;
  signature_at: Date | null;
  snapshot_terms: string | null;
  snapshot_notes: string | null;
  snapshot_payment_terms: string | null;
  lead: {
    service_address_line1: string | null;
    service_address_line2: string | null;
    service_city: string | null;
    service_state: string | null;
    service_zip: string | null;
    customer: {
      first_name: string;
      last_name: string;
      company_name: string | null;
      email: string;
      phone: string;
      service_locations: Array<{
        is_primary: boolean;
        address_line1: string;
        address_line2: string | null;
        city: string; state: string; zip: string;
      }>;
    };
  };
  line_items: Array<{
    description: string;
    item_type: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    discount_amount: number;
  }>;
}

interface OrgForPdf {
  name: string;
  address_line1: string;
  address_line2: string | null;
  city: string; state: string; postal_code: string;
  email: string;
  phone: string | null;
  website: string | null;
  logo_url: string | null;
  brand_color: string;
  estimate_terms: string;
  estimate_notes: string;
  estimate_payment_terms: string;
}

// NOTE: exported because crm-default.ts imports these (Task 3.1). Do not duplicate them there.
export function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtTaxRate(r: number): string {
  return `(${(r * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%)`;
}

export function pickContent(snap: string | null, live: string, status: string): string {
  if (status === 'DRAFT') return live;
  return snap ?? live;
}

export function isSameAsBilling(estimate: EstimateForPdf): boolean {
  const l = estimate.lead;
  if (!l.service_address_line1) return true;
  const primary = l.customer.service_locations.find(s => s.is_primary);
  if (!primary) return false;
  return (
    l.service_address_line1 === primary.address_line1 &&
    l.service_city === primary.city &&
    l.service_state === primary.state &&
    l.service_zip === primary.zip
  );
}

export function buildAlphaClassicPdf(
  estimate: EstimateForPdf,
  org: OrgForPdf,
): TDocumentDefinitions {
  const c = estimate.lead.customer;
  const primary = c.service_locations.find(s => s.is_primary);
  const terms = pickContent(estimate.snapshot_terms, org.estimate_terms, estimate.status);
  const notes = pickContent(estimate.snapshot_notes, org.estimate_notes, estimate.status);
  const paymentTerms = pickContent(estimate.snapshot_payment_terms, org.estimate_payment_terms, estimate.status);

  // 1. Header band: logo OR company-name fallback + "ESTIMATE" wordmark
  const logoBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number] }
    : { text: org.name, fontSize: 24, bold: true, color: org.brand_color };

  // 2. Customer / Service Location columns
  const sameAsBilling = isSameAsBilling(estimate);
  const preparedFor = [
    { text: 'Prepared For:', bold: true, margin: [0, 0, 0, 4] as any },
    `${c.first_name} ${c.last_name}`,
    primary ? [primary.address_line1, primary.city + ', ' + primary.state + ' ' + primary.zip].join('\n') : '',
    c.phone,
    c.email,
  ];
  const serviceLocation = [
    { text: 'Service Location:', bold: true, margin: [0, 0, 0, 4] as any },
    sameAsBilling
      ? 'Same as billing'
      : [
          `${c.first_name} ${c.last_name}`,
          `${estimate.lead.service_address_line1}\n${estimate.lead.service_city}, ${estimate.lead.service_state} ${estimate.lead.service_zip}`,
          c.phone,
          c.email,
        ].join('\n'),
  ];

  // 3. Line items table body
  const tableBody: any[] = [
    [
      { text: 'Description', bold: true, fillColor: '#f5f5f5' },
      { text: 'QTY',         bold: true, fillColor: '#f5f5f5', alignment: 'center' },
      { text: 'Price',       bold: true, fillColor: '#f5f5f5', alignment: 'right' },
      { text: 'Amount',      bold: true, fillColor: '#f5f5f5', alignment: 'right' },
    ],
  ];
  for (const li of estimate.line_items) {
    const parts = li.description.split('\n');
    tableBody.push([
      {
        stack: [
          { text: parts[0], bold: true },
          ...(parts.slice(1).length > 0
            ? [{ text: parts.slice(1).join('\n'), fontSize: 9, color: '#666' }]
            : []),
        ],
      },
      { text: String(li.quantity), alignment: 'center' },
      { text: fmtCurrency(li.unit_price), alignment: 'right' },
      { text: fmtCurrency(li.line_total), alignment: 'right' },
    ]);
  }

  // 4. Totals block (right-aligned)
  const totalsTable = {
    table: {
      widths: [80, 80] as any,
      body: [
        [{ text: 'Sub total', alignment: 'right' }, { text: fmtCurrency(estimate.subtotal), alignment: 'right' }],
        [{ text: `Tax ${fmtTaxRate(estimate.tax_rate)}`, alignment: 'right' }, { text: fmtCurrency(estimate.tax_amount), alignment: 'right' }],
        [{ text: 'Total', alignment: 'right', bold: true, fontSize: 12 }, { text: fmtCurrency(estimate.total_amount), alignment: 'right', bold: true, fontSize: 12 }],
      ],
    },
    layout: 'noBorders',
    alignment: 'right' as const,
    margin: [0, 10, 0, 20] as any,
  };

  // 5. Signature block (conditional)
  const signatureBlock = estimate.signature_data
    ? [
        { text: 'Customer Signature:', bold: true, margin: [0, 20, 0, 8] as any, pageBreak: 'before' as any },
        { image: estimate.signature_data, width: 150, height: 60 },
        { text: `Approved on ${estimate.signature_at ? fmtDate(estimate.signature_at) : ''}`, fontSize: 9, color: '#666' },
      ]
    : [];

  return {
    content: [
      // Header band
      {
        columns: [
          { width: 200, ...logoBlock },
          { text: 'ESTIMATE', fontSize: 32, bold: true, color: '#666', alignment: 'right' },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      // Company info strip
      {
        columns: [
          {
            stack: [
              org.name,
              `${org.address_line1}, ${org.city}, ${org.state}, ${org.postal_code}`,
              org.email,
              org.website || '',
            ],
          },
          {
            table: {
              widths: ['auto', 'auto'] as any,
              body: [
                [{ text: 'Estimate #', bold: true }, { text: estimate.estimate_number, alignment: 'right' }],
                [{ text: 'Date',       bold: true }, { text: fmtDate(estimate.created_at), alignment: 'right' }],
                [{ text: 'Total',      bold: true }, { text: fmtCurrency(estimate.total_amount), alignment: 'right' }],
              ],
            },
            layout: 'noBorders',
            alignment: 'right' as any,
          },
        ],
        margin: [0, 0, 0, 30] as any,
      },
      // Customer block
      {
        columns: [
          { stack: preparedFor },
          { stack: serviceLocation },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      // Line items table
      {
        table: {
          headerRows: 1,
          widths: ['*', 40, 70, 70] as any,
          body: tableBody,
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          hLineColor: () => '#e5e5e5',
        },
      },
      // Totals
      totalsTable,
      // Terms
      { text: 'Terms:', bold: true, margin: [0, 10, 0, 4] as any },
      { text: terms, style: 'paragraph' },
      // Notes
      { text: 'Notes:', bold: true, margin: [0, 16, 0, 4] as any },
      ...markdownToPdfMake(notes),
      // Payment Terms
      { text: 'PAYMENT TERMS:', bold: true, margin: [0, 16, 0, 4] as any },
      ...markdownToPdfMake(paymentTerms),
      // Signature
      ...signatureBlock,
      // Footer
      { text: 'Thank You For Your Business', fontSize: 18, bold: true, alignment: 'center', margin: [0, 30, 0, 0] as any },
    ],
    defaultStyle: { font: 'Inter', fontSize: 10 },
    styles: {
      paragraph: { fontSize: 10, lineHeight: 1.3 },
    },
    pageMargins: [40, 40, 40, 40],
    pageSize: 'LETTER',
  };
}
```

- [ ] **Step 5:** Run tests:

```bash
cd backend && npm test -- alpha-classic.test.ts
```

Expected: all 10 tests PASS.

- [ ] **Step 6:** Commit:

```bash
git add backend/src/lib/pdf/templates/
git commit -m "feat(pdf): add alpha-classic template builder + registry"
```

---

### Task 2.6: `generateEstimatePdf` entry point

**Files:**
- Create: `backend/src/lib/pdf/index.ts`

- [ ] **Step 1:** Create `backend/src/lib/pdf/index.ts`:

```typescript
import { logger } from '../logger';
import { prisma } from '../prisma';
import { printer } from './fonts';
import { templateRegistry, TemplateKey } from './templates/registry';
import { PREVIEW_ESTIMATE_FIXTURE } from './preview-fixture';
import type { Writable } from 'stream';

export interface GeneratePdfOptions {
  estimateId: string | 'preview';
  /** When 'preview', use PREVIEW_ESTIMATE_FIXTURE instead of DB load. */
}

export async function generateEstimatePdf(opts: GeneratePdfOptions) {
  const estimate = opts.estimateId === 'preview'
    ? PREVIEW_ESTIMATE_FIXTURE
    : await prisma.estimate.findUnique({
        where: { id: opts.estimateId },
        include: {
          line_items: { orderBy: { sequence: 'asc' } },
          lead: {
            include: {
              customer: {
                include: {
                  service_locations: { where: { is_primary: true }, take: 1 },
                },
              },
            },
          },
        },
      });
  if (!estimate) throw new Error(`Estimate not found: ${opts.estimateId}`);

  // Load the org. For preview, always load Alpha (only one org in MVP).
  const orgId = opts.estimateId === 'preview'
    ? '00000000-0000-0000-0000-000000000001'
    : (estimate as any).organization_id;
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new Error(`Organization not found: ${orgId}`);

  // Resolve template, fall back to crm-default with warning
  const key = (org.estimate_template as TemplateKey);
  let builder = templateRegistry[key];
  if (!builder) {
    logger.warn(`Unknown template "${key}" for org ${org.id}; falling back to alpha-classic`);
    builder = templateRegistry['alpha-classic'];
  }

  const docDefinition = builder(estimate as any, org as any);
  return printer.createPdfKitDocument(docDefinition);
}
```

- [ ] **Step 2:** Smoke test it inline. Add to `backend/src/lib/pdf/__tests__/fonts.test.ts` (or create a new test file `index.test.ts`):

```typescript
import { generateEstimatePdf } from '../index';

describe('generateEstimatePdf', () => {
  it('renders the preview fixture into a valid PDF', (done) => {
    generateEstimatePdf({ estimateId: 'preview' }).then(doc => {
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => {
        const buf = Buffer.concat(chunks);
        expect(buf.slice(0, 4).toString()).toBe('%PDF');
        done();
      });
      doc.end();
    }).catch(done);
  });
});
```

- [ ] **Step 3:** Run tests:

```bash
cd backend && npm test -- backend/src/lib/pdf
```

Expected: all PDF module tests PASS.

- [ ] **Step 4:** Commit:

```bash
git add backend/src/lib/pdf/index.ts backend/src/lib/pdf/__tests__/
git commit -m "feat(pdf): add generateEstimatePdf entry point"
```

---

### Task 2.7: `GET /api/estimates/:id/pdf` route (authenticated only)

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` — add `getPdf` method
- Modify: `backend/src/routes/estimate.routes.ts` — wire the route
- Create: `backend/src/__tests__/estimate-pdf.test.ts`

- [ ] **Step 1:** Write the failing integration test. Create `backend/src/__tests__/estimate-pdf.test.ts`. **This file is the canonical example of the Test Conventions above — all other test snippets in this plan should follow this pattern.**

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';

describe('GET /api/estimates/:id/pdf', () => {
  let estimateId: string;

  beforeAll(async () => {
    // Use an existing SENT estimate created by the surrounding test setup, or
    // create one here via prisma.estimate.create() — follow the pattern in
    // estimates.test.ts for fixture creation.
    const est = await prisma.estimate.findFirst({ where: { status: 'SENT' } });
    estimateId = est!.id;
  });

  beforeEach(() => mockAuthAs('admin'));

  it('returns 200 with application/pdf for authenticated admin', async () => {
    const res = await request(app)
      .get(`/api/estimates/${estimateId}/pdf`)
      .set(authHeader('admin'))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/inline/);
    expect((res.body as Buffer).slice(0, 4).toString()).toBe('%PDF');
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app).get(`/api/estimates/${estimateId}/pdf`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown estimate id', async () => {
    const res = await request(app)
      .get('/api/estimates/00000000-0000-0000-0000-000000000000/pdf')
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2:** Run to confirm fail:

```bash
cd backend && npm test -- estimate-pdf.test.ts
```

Expected: FAIL — route doesn't exist yet.

- [ ] **Step 3:** Add `getPdf` to `backend/src/controllers/estimate.controller.ts`:

```typescript
import { generateEstimatePdf } from '../lib/pdf';

export const getPdf = async (req: Request, res: Response) => {
  const id = param(req, 'id');
  const exists = await prisma.estimate.findUnique({ where: { id }, select: { id: true, estimate_number: true } });
  if (!exists) return res.status(404).json({ error: 'Estimate not found' });
  try {
    const doc = await generateEstimatePdf({ estimateId: id });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="estimate-${exists.estimate_number}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    logger.error(`PDF generation failed for estimate ${id}:`, err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
};
```

- [ ] **Step 4:** Wire the route in `backend/src/routes/estimate.routes.ts`:

```typescript
router.get('/:id/pdf',
  authenticate,
  authorize('ADMIN', 'SALES', 'DISPATCHER'),
  estimateController.getPdf);
```

- [ ] **Step 5:** Run tests:

```bash
cd backend && npm test -- estimate-pdf.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 6:** Commit:

```bash
git add backend/src/controllers/estimate.controller.ts backend/src/routes/estimate.routes.ts backend/src/__tests__/estimate-pdf.test.ts
git commit -m "feat(api): add GET /api/estimates/:id/pdf for authenticated users"
```

---

### Task 2.8: Frontend — replace inline estimate view with PDF iframe

**Files:**
- Create: `frontend/src/components/estimates/PdfPreviewDialog.tsx`
- Modify: `frontend/src/pages/EstimateDetailPage.tsx`
- Modify: `frontend/src/pages/EstimateFormPage.tsx`

- [ ] **Step 1:** Create `frontend/src/components/estimates/PdfPreviewDialog.tsx`:

```typescript
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';

interface PdfPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pdfUrl: string;              // e.g., /api/estimates/:id/pdf
  downloadFilename: string;    // e.g., estimate-E00001.pdf
  title?: string;
}

export function PdfPreviewDialog({ open, onOpenChange, pdfUrl, downloadFilename, title = 'Estimate Preview' }: PdfPreviewDialogProps) {
  const handleDownload = async () => {
    const res = await fetch(pdfUrl, { credentials: 'include' });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFilename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b flex-row items-center justify-between">
          <DialogTitle>{title}</DialogTitle>
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="mr-2 h-4 w-4" />Download
          </Button>
        </DialogHeader>
        <iframe
          src={pdfUrl}
          className="flex-1 w-full border-0"
          title={title}
        />
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2:** Modify `frontend/src/pages/EstimateDetailPage.tsx` — replace the inline `<EstimateDocumentView />` usage with the iframe + Download button:

Locate the block that renders `<EstimateDocumentView />`. Replace with:

```tsx
<div className="border rounded-xl overflow-hidden" style={{ height: 'calc(100vh - 280px)' }}>
  <iframe
    src={`/api/estimates/${estimate.id}/pdf`}
    className="w-full h-full border-0"
    title="Estimate PDF"
  />
</div>
<div className="mt-4 flex justify-end">
  <Button onClick={handleDownload} variant="outline">
    <Download className="mr-2 h-4 w-4" />Download PDF
  </Button>
</div>
```

Add `handleDownload` (triggers a blob download from the same URL).

- [ ] **Step 3:** Modify `frontend/src/pages/EstimateFormPage.tsx` — replace inline `<EstimateDocumentView />` with a "Preview PDF" button that opens `PdfPreviewDialog`. Add state: `const [previewOpen, setPreviewOpen] = useState(false);`

```tsx
<Button variant="outline" onClick={async () => {
  await saveDraft();                // ensure latest draft is persisted
  setPreviewOpen(true);
}}>
  Preview PDF
</Button>

<PdfPreviewDialog
  open={previewOpen}
  onOpenChange={setPreviewOpen}
  pdfUrl={`/api/estimates/${estimate?.id}/pdf`}
  downloadFilename={`estimate-${estimate?.estimate_number}.pdf`}
/>
```

- [ ] **Step 4:** Start both dev servers and smoke-test manually:

```bash
# Terminal 1
cd backend && npm run dev
# Terminal 2
cd frontend && npm run dev
```

Open an existing estimate's detail page. Expected: embedded PDF renders; "Download PDF" downloads a file. Open an estimate's form → click "Preview PDF" → dialog opens with PDF.

- [ ] **Step 5:** Commit:

```bash
git add frontend/src/components/estimates/PdfPreviewDialog.tsx frontend/src/pages/EstimateDetailPage.tsx frontend/src/pages/EstimateFormPage.tsx
git commit -m "feat(frontend): embed PDF preview on detail page + form preview dialog"
```

---

**Phase 2 Exit Criteria:**
- [ ] `GET /api/estimates/:id/pdf` with admin auth returns a valid PDF
- [ ] Detail page displays the PDF inline; Download button works
- [ ] Form page "Preview PDF" button opens dialog with the PDF
- [ ] Visual comparison: Alpha estimate PDF vs `examples/workiz-alpha-estimates/*.pdf` on 3 test cases (1-page short, 2-page long-description, 3+ page multi-line-item). User sign-off required here — share screenshots for approval before merging Phase 2

---

## Phase 3 — `crm-default` Template + Organization Settings UI

**Goal:** Port the existing `EstimateDocumentView` look to pdfmake. Build the Settings UI so admins can edit branding/copy and switch templates.

**Spec sections:** §7.6, §7.8 (preview-pdf), §8, §9 (not §9.4/§9.5 — those are Phase 4)

---

### Task 3.1: `crm-default` template builder

**Files:**
- Create: `backend/src/lib/pdf/templates/crm-default.ts`
- Create: `backend/src/lib/pdf/templates/__tests__/crm-default.test.ts`
- Modify: `backend/src/lib/pdf/templates/registry.ts` — add `'crm-default'` entry

- [ ] **Step 1:** Copy `alpha-classic.test.ts` → `crm-default.test.ts`, then swap the import + replace the following assertions (most mirror alpha-classic; only the markers change):

```typescript
import { describe, it, expect } from 'vitest';
import { buildCrmDefaultPdf } from '../crm-default';
import { PREVIEW_ESTIMATE_FIXTURE } from '../../preview-fixture';
import { printer } from '../../fonts';

// FIXTURE_ORG constant: COPY unchanged from alpha-classic.test.ts

describe('buildCrmDefaultPdf', () => {
  it('produces a valid docDefinition with Inter default font', () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(doc).toHaveProperty('content');
    expect(doc.defaultStyle.font).toBe('Inter');
  });

  it('falls back to org.name as header when logo_url is null', () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Alpha Doors & Security INC.');
  });

  it('renders a MATERIAL tag for material items and SERVICE tag for service items', () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Material');
    expect(json).toContain('Service');
  });

  it('shows a line-discount strikethrough on the third fixture item', () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    // Gross price 99.00 appears as a struck-through value when discount_amount > 0
    expect(json).toContain('"decoration":"lineThrough"');
    expect(json).toContain('$89.10');  // effective price after discount
  });

  it('includes "Scope of Work" card when scope_notes is present', () => {
    const fx = { ...PREVIEW_ESTIMATE_FIXTURE, scope_notes: 'Install new maglock.' };
    const doc = buildCrmDefaultPdf(fx as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Scope of Work');
  });

  it('omits signature block when signature_data is null', () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).not.toContain('Customer Signature');
  });

  it('includes signature block when signature_data is present', () => {
    const signed = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      signature_at: new Date('2026-04-23T10:00:00Z'),
    };
    const doc = buildCrmDefaultPdf(signed as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Customer Signature');
  });

  it('prefers snapshot fields over live org fields when estimate is SENT+', () => {
    const snapped = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      status: 'APPROVED' as const,
      snapshot_terms: 'SNAPSHOT TERMS',
    };
    const doc = buildCrmDefaultPdf(snapped as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('SNAPSHOT TERMS');
    expect(json).not.toContain('Sample terms.');
  });

  it('renders through PdfPrinter without error', (done) => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const pdfDoc = printer.createPdfKitDocument(doc);
    const chunks: Buffer[] = [];
    pdfDoc.on('data', (c) => chunks.push(c));
    pdfDoc.on('end', () => {
      const buf = Buffer.concat(chunks);
      expect(buf.slice(0, 4).toString()).toBe('%PDF');
      done();
    });
    pdfDoc.end();
  });
});
```

- [ ] **Step 2:** Run to confirm fail.

- [ ] **Step 3:** Implement `crm-default.ts`. Reference `frontend/src/components/estimates/EstimateDocumentView.tsx` for the visual design, and use `alpha-classic.ts` as the structural template. **Shared helpers** — import (don't re-declare) `fmtCurrency`, `fmtDate`, `fmtTaxRate`, `pickContent`, `isSameAsBilling` from `alpha-classic.ts` (export them from there if not already exported, since both builders need them).

Skeleton:

```typescript
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { markdownToPdfMake } from '../markdown';
import { fmtCurrency, fmtDate, fmtTaxRate, pickContent, isSameAsBilling } from './alpha-classic';

// Same EstimateForPdf / OrgForPdf interfaces as alpha-classic — export from alpha-classic and import here.

export function buildCrmDefaultPdf(
  estimate: EstimateForPdf,
  org: OrgForPdf,
): TDocumentDefinitions {
  const c = estimate.lead.customer;
  const primary = c.service_locations.find(s => s.is_primary);
  const terms = pickContent(estimate.snapshot_terms, org.estimate_terms, estimate.status);
  const notes = pickContent(estimate.snapshot_notes, org.estimate_notes, estimate.status);
  const paymentTerms = pickContent(estimate.snapshot_payment_terms, org.estimate_payment_terms, estimate.status);

  // Centered header: logo OR org.name (brand color, bold)
  const headerBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number], alignment: 'center' as const }
    : { text: org.name, fontSize: 24, bold: true, color: org.brand_color, alignment: 'center' as const };

  // Title + subtitle ("Estimate E00001" / "Prepared for Jane Doe")
  const titleBlock = {
    stack: [
      { text: `Estimate ${estimate.estimate_number}`, fontSize: 22, bold: true, alignment: 'center' as const, margin: [0, 12, 0, 4] },
      { text: `Prepared for ${c.first_name} ${c.last_name}${c.company_name ? ' — ' + c.company_name : ''}`, fontSize: 10, color: '#6b7280', alignment: 'center' as const },
    ],
    margin: [0, 0, 0, 24] as any,
  };

  // Scope of Work card (if present)
  const scopeBlock = (estimate as any).scope_notes
    ? [
        { text: 'Scope of Work', fontSize: 10, bold: true, color: '#6b7280', margin: [0, 0, 0, 4] as any },
        { text: (estimate as any).scope_notes, margin: [0, 0, 0, 16] as any },
      ]
    : [];

  // Line items table — card style with image column + tag column
  const tableBody: any[] = [];
  for (const li of estimate.line_items) {
    const parts = li.description.split('\n');
    const gross = Number(li.quantity) * Number(li.unit_price);
    const hasLineDiscount = Number(li.discount_amount) > 0;
    const imageCell = (li as any).price_book_item?.image_url
      ? { image: (li as any).price_book_item.image_url, fit: [56, 56] }
      : { text: li.item_type === 'MATERIAL' ? '[PKG]' : '[SVC]', fontSize: 9, color: '#9ca3af', alignment: 'center' as const };
    const tagColor = li.item_type === 'MATERIAL' ? '#fb923c' : '#3b82f6';
    const tagText = li.item_type === 'MATERIAL' ? 'Material' : 'Service';

    tableBody.push([
      {
        stack: [
          imageCell,
          { text: tagText, fontSize: 8, color: 'white', background: tagColor, alignment: 'center' as const, margin: [0, 4, 0, 0] },
        ],
      },
      {
        stack: [
          { text: parts[0], bold: true },
          ...(parts.slice(1).length ? [{ text: parts.slice(1).join('\n'), fontSize: 9, color: '#6b7280' }] : []),
          { text: `Qty ${li.quantity} @ ${fmtCurrency(Number(li.unit_price))}`, fontSize: 9, color: '#6b7280', margin: [0, 4, 0, 0] as any },
        ],
      },
      hasLineDiscount
        ? {
            stack: [
              { text: fmtCurrency(gross), decoration: 'lineThrough' as const, fontSize: 9, color: '#9ca3af', alignment: 'right' as const },
              { text: fmtCurrency(Number(li.line_total)), bold: true, alignment: 'right' as const },
            ],
          }
        : { text: fmtCurrency(Number(li.line_total)), bold: true, alignment: 'right' as const },
    ]);
  }

  const totalsStack = [
    { columns: [{ text: 'Subtotal', alignment: 'right' as const, width: '*' }, { text: fmtCurrency(estimate.subtotal), width: 80, alignment: 'right' as const }] },
    // (Line Discounts, Estimate Discount rows — include conditionally if applicable)
    { columns: [{ text: `Tax ${fmtTaxRate(estimate.tax_rate)}`, alignment: 'right' as const, width: '*' }, { text: fmtCurrency(estimate.tax_amount), width: 80, alignment: 'right' as const }] },
    { columns: [{ text: 'Total', alignment: 'right' as const, width: '*', bold: true, fontSize: 12 }, { text: fmtCurrency(estimate.total_amount), width: 80, alignment: 'right' as const, bold: true, fontSize: 12 }] },
  ];

  const signatureBlock = estimate.signature_data
    ? [
        { text: 'Customer Signature:', bold: true, margin: [0, 20, 0, 8] as any, pageBreak: 'before' as any },
        { image: estimate.signature_data, width: 150, height: 60 },
        { text: `Approved on ${estimate.signature_at ? fmtDate(estimate.signature_at) : ''}`, fontSize: 9, color: '#6b7280' },
      ]
    : [];

  return {
    content: [
      headerBlock,
      titleBlock,
      ...scopeBlock,
      { table: { widths: [64, '*', 80] as any, body: tableBody }, layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#e5e7eb' } },
      { stack: totalsStack, margin: [0, 10, 0, 20] as any },
      { text: 'Terms:', bold: true, margin: [0, 10, 0, 4] as any },
      { text: terms, style: 'paragraph' },
      { text: 'Notes:', bold: true, margin: [0, 16, 0, 4] as any },
      ...markdownToPdfMake(notes),
      { text: 'PAYMENT TERMS:', bold: true, margin: [0, 16, 0, 4] as any },
      ...markdownToPdfMake(paymentTerms),
      ...signatureBlock,
      { text: 'Thank You For Your Business', fontSize: 18, bold: true, alignment: 'center', margin: [0, 30, 0, 0] as any },
    ],
    defaultStyle: { font: 'Inter', fontSize: 10 },
    styles: { paragraph: { fontSize: 10, lineHeight: 1.3 } },
    pageMargins: [40, 40, 40, 40],
    pageSize: 'LETTER',
  };
}
```

Keep the builder function signature identical to `buildAlphaClassicPdf`.

- [ ] **Step 4:** Register it in `registry.ts`:

```typescript
import { buildCrmDefaultPdf } from './crm-default';

export const templateRegistry = {
  'alpha-classic': buildAlphaClassicPdf,
  'crm-default':   buildCrmDefaultPdf,
} as const;
```

- [ ] **Step 5:** Run tests:

```bash
cd backend && npm test -- crm-default.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6:** Commit:

```bash
git add backend/src/lib/pdf/templates/crm-default.ts backend/src/lib/pdf/templates/__tests__/crm-default.test.ts backend/src/lib/pdf/templates/registry.ts
git commit -m "feat(pdf): add crm-default template builder"
```

---

### Task 3.2: Template thumbnail PNGs

**Files:**
- Create: `frontend/public/template-thumbs/alpha-classic.png`
- Create: `frontend/public/template-thumbs/crm-default.png`

- [ ] **Step 1:** Generate a PDF of each template (via Task 2.5 / 3.1 tests or a manual script), render the first page to PNG at ~150×200px. Use `sharp` or open-source PDF-to-PNG tools. Save both.

- [ ] **Step 2:** Commit:

```bash
git add frontend/public/template-thumbs/
git commit -m "chore(frontend): add estimate template thumbnails"
```

---

### Task 3.3: Organization controller (GET / PATCH)

**Files:**
- Create: `backend/src/controllers/organization.controller.ts`
- Create: `backend/src/routes/organization.routes.ts`
- Modify: `backend/src/app.ts` — mount `/api/organization` routes
- Create: `backend/src/__tests__/organization.test.ts`

- [ ] **Step 1:** Write failing tests (`organization.test.ts`):

```typescript
describe('GET /api/organization', () => {
  it('returns the current org for any authenticated user', async () => { /* ... */ });
  it('returns 401 unauthenticated', async () => { /* ... */ });
});

describe('PATCH /api/organization', () => {
  it('updates branding/copy for ADMIN', async () => { /* ... */ });
  it('returns 403 for SALES/DISPATCHER/TECHNICIAN', async () => { /* ... */ });
  it('validates brand_color as #RRGGBB', async () => { /* ... */ });
  it('validates estimate_template as one of the known keys', async () => { /* ... */ });
});
```

- [ ] **Step 2:** Run to confirm fail.

- [ ] **Step 3:** Implement controller with Zod schema per spec §8.3:

```typescript
import { z } from 'zod';

export const patchOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  legal_name: z.string().max(200).optional(),
  address_line1: z.string().min(1).max(200).optional(),
  address_line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100).optional(),
  state: z.string().min(1).max(50).optional(),
  postal_code: z.string().min(1).max(20).optional(),
  country: z.string().length(2).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(200).optional().or(z.literal('')),
  brand_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  estimate_template: z.enum(['alpha-classic', 'crm-default']).optional(),
  estimate_terms: z.string().max(10000).optional(),
  estimate_notes: z.string().max(10000).optional(),
  estimate_payment_terms: z.string().max(10000).optional(),
});

export const getOrganization = async (req, res) => {
  const org = await prisma.organization.findFirst();
  if (!org) return res.status(404).json({ error: 'Organization not configured' });
  res.json(org);
};

export const updateOrganization = async (req, res) => {
  const data = patchOrgSchema.parse(req.body);
  const org = await prisma.organization.findFirst();
  if (!org) return res.status(404).json({ error: 'Organization not configured' });
  const updated = await prisma.organization.update({ where: { id: org.id }, data });
  res.json(updated);
};
```

- [ ] **Step 4:** Wire routes in `backend/src/routes/organization.routes.ts`:

```typescript
router.get('/',    authenticate, orgController.getOrganization);
router.patch('/',  authenticate, authorize('ADMIN'), validate(patchOrgSchema), orgController.updateOrganization);
```

- [ ] **Step 5:** Mount in `backend/src/app.ts`:

```typescript
app.use('/api/organization', organizationRoutes);
```

- [ ] **Step 6:** Run tests. Expected: all PASS.

- [ ] **Step 7:** Commit:

```bash
git add backend/src/controllers/organization.controller.ts backend/src/routes/organization.routes.ts backend/src/app.ts backend/src/__tests__/organization.test.ts
git commit -m "feat(api): add GET/PATCH /api/organization"
```

---

### Task 3.4: Logo upload endpoint with `sharp` resize + Supabase Storage

**Files:**
- Modify: `backend/src/controllers/organization.controller.ts` — add `uploadLogo`
- Modify: `backend/src/routes/organization.routes.ts` — add `POST /logo` route

- [ ] **Step 1:** Write failing test:

```typescript
describe('POST /api/organization/logo', () => {
  it('accepts PNG + resizes to 200×80pt for ADMIN', async () => { /* ... */ });
  it('rejects files > 2 MB with 413', async () => { /* ... */ });
  it('rejects non-image MIME types with 400', async () => { /* ... */ });
  it('returns 403 for non-admin', async () => { /* ... */ });
});
```

- [ ] **Step 2:** Implement. Use `multer` (check if already in deps — if not, `npm install multer @types/multer`) with MIME allowlist + size cap; `sharp` for resize; Supabase Storage upload. **Note the client import is `supabaseAdmin`, not `supabase`.**

```typescript
import sharp from 'sharp';
import { supabaseAdmin } from '../lib/supabase';
import crypto from 'crypto';

const LOGO_MAX_W = 267;  // 200pt * 1.33 (px per pt)
const LOGO_MAX_H = 107;  // 80pt * 1.33

export const uploadLogo = async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const mime = req.file.mimetype;
  if (!['image/png', 'image/jpeg', 'image/svg+xml'].includes(mime)) {
    return res.status(400).json({ error: 'Unsupported image type' });
  }
  let buffer = req.file.buffer;
  if (mime !== 'image/svg+xml') {
    buffer = await sharp(req.file.buffer)
      .resize(LOGO_MAX_W, LOGO_MAX_H, { fit: 'inside', withoutEnlargement: false })
      .toBuffer();
  }
  const org = await prisma.organization.findFirst();
  if (!org) return res.status(404).json({ error: 'Organization not configured' });
  const ext = mime === 'image/svg+xml' ? 'svg' : (mime === 'image/png' ? 'png' : 'jpg');
  const path = `${org.id}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from('org-logos')
    .upload(path, buffer, { contentType: mime, upsert: true });
  if (upErr) {
    logger.error('Logo upload failed:', upErr);
    return res.status(500).json({ error: 'Storage upload failed' });
  }
  const { data: pub } = supabaseAdmin.storage.from('org-logos').getPublicUrl(path);
  const updated = await prisma.organization.update({
    where: { id: org.id },
    data: { logo_url: pub.publicUrl },
  });
  res.json({ logo_url: updated.logo_url });
};
```

- [ ] **Step 3:** Wire route with multer middleware:

```typescript
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
router.post('/logo', authenticate, authorize('ADMIN'), upload.single('file'), orgController.uploadLogo);
```

- [ ] **Step 4:** Provision the Supabase Storage bucket. Run this SQL once in the Supabase SQL editor (dev + staging + prod — not a Prisma migration because the `storage.buckets` table is Supabase-internal):

```sql
-- Create the bucket (public-read so pdfmake can fetch logo URLs server-side)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'org-logos', 'org-logos', true,
  2097152,  -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/svg+xml']
)
ON CONFLICT (id) DO NOTHING;

-- Public read policy
CREATE POLICY "public_read_org_logos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'org-logos');

-- Writes go through the service-role key (backend `supabaseAdmin` client) only;
-- no RLS write policy is needed because the service role bypasses RLS.
```

Document this in `CLAUDE.md` under a new "Supabase Buckets" subsection so future engineers know which buckets exist.

- [ ] **Step 5:** Run tests. Expected: all PASS.

- [ ] **Step 6:** Commit:

```bash
git add backend/src/controllers/organization.controller.ts backend/src/routes/organization.routes.ts
git commit -m "feat(api): add POST /api/organization/logo with sharp resize"
```

---

### Task 3.5: Preview-pdf route

**Files:**
- Modify: `backend/src/controllers/organization.controller.ts` — add `previewPdf`
- Modify: `backend/src/routes/organization.routes.ts` — add `GET /preview-pdf`

- [ ] **Step 1:** Implement:

```typescript
export const previewPdf = async (req: Request, res: Response) => {
  try {
    const doc = await generateEstimatePdf({ estimateId: 'preview' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="estimate-preview.pdf"');
    doc.pipe(res);
    doc.end();
  } catch (err) {
    logger.error('Preview PDF generation failed:', err);
    res.status(500).json({ error: 'Preview generation failed' });
  }
};
```

- [ ] **Step 2:** Route:

```typescript
router.get('/preview-pdf', authenticate, authorize('ADMIN'), orgController.previewPdf);
```

- [ ] **Step 3:** Smoke test manually: `curl -H "Authorization: Bearer <admin_token>" http://localhost:3000/api/organization/preview-pdf > preview.pdf && open preview.pdf`

- [ ] **Step 4:** Commit:

```bash
git add backend/src/controllers/organization.controller.ts backend/src/routes/organization.routes.ts
git commit -m "feat(api): add GET /api/organization/preview-pdf"
```

---

### Task 3.6: Settings page — `/settings/organization`

**Files:**
- Create: `frontend/src/pages/OrganizationSettingsPage.tsx`
- Create: `frontend/src/components/settings/LogoUpload.tsx`
- Create: `frontend/src/components/settings/TemplateSelector.tsx`
- Create: `frontend/src/lib/api/organization.ts` — TanStack Query hooks
- Modify: `frontend/src/App.tsx` — register route
- Modify: `frontend/src/components/layout/nav-config.ts` — add nav entry

- [ ] **Step 1:** Create `lib/api/organization.ts` with `useOrganization`, `useUpdateOrganization`, `useUploadLogo` query hooks.

- [ ] **Step 2:** Build `OrganizationSettingsPage.tsx` with three sections (Branding, Company Info, Estimate Document Copy) per spec §8.2. Use `react-hook-form` + Zod matching the backend schema. Include auto-save-then-preview logic on the Preview PDF button:

```tsx
const onPreview = async () => {
  await form.handleSubmit(onSubmit)();   // save current form values first
  setPreviewOpen(true);
};
```

- [ ] **Step 3:** Wire `LogoUpload` with drag-and-drop (use `react-dropzone` or native) → POST to `/api/organization/logo` via TanStack Query mutation.

- [ ] **Step 4:** `TemplateSelector` — radio group + thumbnails from `/template-thumbs/`.

- [ ] **Step 5:** Add Admin-gated sidebar entry in `nav-config.ts`:

```typescript
{ label: 'Organization', icon: Building, path: '/settings/organization', roles: ['ADMIN'] }
```

- [ ] **Step 6:** Register route in `App.tsx`:

```tsx
<Route path="/settings/organization" element={<ProtectedRoute role="ADMIN"><OrganizationSettingsPage /></ProtectedRoute>} />
```

- [ ] **Step 7:** Start both dev servers. Log in as ADMIN. Navigate to `/settings/organization`. Verify: form loads org data, logo upload works, color picker works, template radio toggles, Preview PDF opens Dialog showing the PDF with current settings.

- [ ] **Step 8:** Commit:

```bash
git add frontend/src/pages/OrganizationSettingsPage.tsx frontend/src/components/settings/ frontend/src/lib/api/organization.ts frontend/src/App.tsx frontend/src/components/layout/nav-config.ts
git commit -m "feat(frontend): add Organization Settings page"
```

---

### Task 3.7: E2E test for settings workflow

**Files:**
- Create: `frontend/e2e/organization-settings.spec.ts`

- [ ] **Step 1:** Write a Playwright spec that:
  1. Logs in as admin
  2. Navigates to `/settings/organization`
  3. Types a new estimate_terms value
  4. Clicks Preview PDF
  5. Asserts the Dialog opens and the iframe src matches `/api/organization/preview-pdf`
  6. Closes Dialog, clicks Save
  7. Reloads the page, verifies the new value persists

- [ ] **Step 2:** Run:

```bash
cd frontend && npx playwright test organization-settings.spec.ts
```

Expected: pass.

- [ ] **Step 3:** Commit:

```bash
git add frontend/e2e/organization-settings.spec.ts
git commit -m "test(e2e): add organization settings E2E spec"
```

---

**Phase 3 Exit Criteria:**
- [ ] Both templates render correctly (visual comparison screenshots)
- [ ] Admin can upload logo, change color, edit copy, switch template, save, preview — all work
- [ ] Non-admin roles see 403 on PATCH and no nav entry
- [ ] E2E spec passes locally

---

## Phase 4 — Public Page Rebrand + Email PDF Attachments + Payment-Method Change

**Goal:** Customers receive properly branded emails with PDF attachments; public page is rebranded; payment method can only be changed by staff.

**Spec sections:** §7.3 public route, §9.3, §9.4, §9.5

---

### Task 4.1: Extend `getPublic` response with org subset

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` — `getPublic` method
- Modify: `backend/src/__tests__/estimates.test.ts` — add assertion

- [ ] **Step 1:** Add a failing test assertion to `estimates.test.ts` for `getPublic`:

```typescript
it('GET /api/estimates/:id/public includes organization subset', async () => {
  const res = await request(app).get(`/api/estimates/${id}/public?token=${token}`);
  expect(res.body.organization).toMatchObject({
    name: expect.any(String),
    logo_url: expect.anything(),
    brand_color: expect.stringMatching(/^#/),
    email: expect.stringContaining('@'),
    estimate_terms: expect.any(String),
  });
  expect(res.body.organization).not.toHaveProperty('estimate_notes');
  expect(res.body.organization).not.toHaveProperty('estimate_payment_terms');
  expect(res.body.organization).not.toHaveProperty('country');
});
```

- [ ] **Step 2:** Run, confirm fail.

- [ ] **Step 3:** Modify `getPublic` to include the allowed org subset:

```typescript
const org = await prisma.organization.findUnique({ where: { id: estimate.organization_id } });
const organization = org ? {
  name: org.name,
  logo_url: org.logo_url,
  brand_color: org.brand_color,
  email: org.email,
  website: org.website,
  estimate_terms: org.estimate_terms,
} : null;
res.json({ ...estimate, organization });
```

- [ ] **Step 4:** Run, confirm pass.

- [ ] **Step 5:** Commit:

```bash
git add backend/src/controllers/estimate.controller.ts backend/src/__tests__/estimates.test.ts
git commit -m "feat(api): include organization subset in public estimate response"
```

---

### Task 4.2: Public PDF route

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` — add `getPublicPdf`
- Modify: `backend/src/routes/estimate.routes.ts` — add route
- Modify: `backend/src/__tests__/estimate-pdf.test.ts` — add tests

- [ ] **Step 1:** Failing tests:

```typescript
describe('GET /api/estimates/:id/public/pdf', () => {
  it('returns PDF with attachment disposition for valid token', async () => {
    const res = await request(app).get(`/api/estimates/${id}/public/pdf?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });
  it('404 for missing or invalid token', async () => { /* ... */ });
  it('rate-limited via publicReadLimiter', async () => { /* ... */ });
});
```

- [ ] **Step 2:** Implement:

```typescript
export const getPublicPdf = async (req: Request, res: Response) => {
  const id = param(req, 'id');
  const token = req.query.token as string | undefined;
  if (!token) return res.status(404).json({ error: 'Estimate not found' });
  const est = await prisma.estimate.findUnique({
    where: { id },
    select: { id: true, estimate_number: true, public_token: true },
  });
  if (!est || est.public_token !== token) return res.status(404).json({ error: 'Estimate not found' });
  try {
    const doc = await generateEstimatePdf({ estimateId: id });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="estimate-${est.estimate_number}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    logger.error(`Public PDF generation failed for estimate ${id}:`, err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
};
```

- [ ] **Step 3:** Route:

```typescript
router.get('/:id/public/pdf', publicReadLimiter, estimateController.getPublicPdf);
```

- [ ] **Step 4:** Run tests, commit:

```bash
git add backend/src/controllers/estimate.controller.ts backend/src/routes/estimate.routes.ts backend/src/__tests__/estimate-pdf.test.ts
git commit -m "feat(api): add GET /api/estimates/:id/public/pdf for unauthenticated token download"
```

---

### Task 4.3: Snapshot-on-send in `send` controller

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` — `sendEstimate` method

- [ ] **Step 1:** Failing test:

```typescript
it('POST /:id/send copies org terms to estimate snapshot columns', async () => {
  await request(app).post(`/api/estimates/${id}/send`).set('Authorization', `Bearer ${adminToken}`);
  const est = await prisma.estimate.findUnique({ where: { id } });
  expect(est!.snapshot_terms).toBeTruthy();
  expect(est!.snapshot_notes).toBeTruthy();
  expect(est!.snapshot_payment_terms).toBeTruthy();
});

it('does NOT overwrite existing snapshot on re-send', async () => {
  await prisma.estimate.update({ where: { id }, data: { snapshot_terms: 'FROZEN' } });
  await request(app).post(`/api/estimates/${id}/send`).set('Authorization', `Bearer ${adminToken}`);
  const est = await prisma.estimate.findUnique({ where: { id } });
  expect(est!.snapshot_terms).toBe('FROZEN');
});
```

- [ ] **Step 2:** Modify the existing `sendEstimate` controller. In the transaction that sets `status = SENT` and `sent_at`, include:

```typescript
const updates: any = {
  status: 'SENT',
  sent_at: now,
};
if (!estimate.snapshot_terms) {
  const org = await tx.organization.findUnique({ where: { id: estimate.organization_id } });
  updates.snapshot_terms = org!.estimate_terms;
  updates.snapshot_notes = org!.estimate_notes;
  updates.snapshot_payment_terms = org!.estimate_payment_terms;
}
await tx.estimate.update({ where: { id }, data: updates });
```

The "only if null" guard enforces immutability across re-sends (payment-method change, etc.).

- [ ] **Step 3:** Run, commit:

```bash
git add backend/src/controllers/estimate.controller.ts backend/src/__tests__/
git commit -m "feat(estimates): snapshot T&C on DRAFT -> SENT transition"
```

---

### Task 4.4: Email — attach pre-signature PDF + org branding wrapper

**Files:**
- Modify: `backend/src/lib/email.ts`

- [ ] **Step 1:** Modify `wrapHtml` to accept org params:

```typescript
function wrapHtml(body: string, org: { name: string; logo_url: string | null; brand_color: string }): string {
  const headerContent = org.logo_url
    ? `<img src="${org.logo_url}" alt="${org.name}" style="max-height:40px;">`
    : `<span style="color:#ffffff;font-size:20px;font-weight:700;">${org.name}</span>`;
  return `<!DOCTYPE html>...<tr><td style="background:${org.brand_color};padding:24px 32px;">${headerContent}</td></tr>...`;
}
```

- [ ] **Step 2:** Add PDF attachment helper. **Critical**: attach the `'end'`/`'error'` listeners BEFORE calling `doc.end()` to avoid a race where the stream completes before the Promise listeners are registered:

```typescript
async function renderEstimatePdfBuffer(estimateId: string): Promise<Buffer> {
  const doc = await generateEstimatePdf({ estimateId });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: Error) => reject(err));
    doc.end();  // called AFTER all listeners are wired
  });
}
```

- [ ] **Step 3:** Modify **three** email functions — add `org` param + `estimateId` for PDF attachment. Their new canonical signatures:

```typescript
// backend/src/lib/email.ts

export async function sendEstimateEmail(params: {
  estimateId: string;
  org: OrganizationBrandingSubset;   // { name, logo_url, brand_color, email, website }
  to: string;
  customerName: string;
  estimateNumber: string;
  total: string;
  publicUrl: string;
}): Promise<void>;

export async function sendEstimateWithDepositEmail(params: {
  estimateId: string;
  org: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  estimateNumber: string;
  total: string;
  depositAmount: string;
  depositPercentage: number;
  publicUrl: string;
}): Promise<void>;

export async function sendEstimateApprovedNotification(params: {
  estimateId: string;
  org: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  estimateNumber: string;
  total: string;
}): Promise<void>;
```

The body of each one ends with:

```typescript
const pdfBuffer = await renderEstimatePdfBuffer(params.estimateId);
await resend.emails.send({
  from: env.MAIL_FROM,
  to: params.to,
  subject: '...',
  html: estimateEmailHtml({ ...params, org: params.org }),
  attachments: [{ filename: `estimate-${params.estimateNumber}.pdf`, content: pdfBuffer }],
});
```

- [ ] **Step 4:** Update all callers in `estimate.controller.ts` to pass `estimateId` + load org (via `prisma.organization.findUnique({ where: { id: estimate.organization_id } })`) and pass the subset.

- [ ] **Step 5:** Regression — run all estimate tests. Expected: pass.

- [ ] **Step 6:** Commit:

```bash
git add backend/src/lib/email.ts backend/src/controllers/estimate.controller.ts
git commit -m "feat(email): attach PDF + use org branding wrapper in estimate emails"
```

---

### Task 4.5: Approval confirmation email — post-signature PDF for non-CARD path

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` — `approvePublic` method

- [ ] **Step 1:** Failing test:

```typescript
it('POST /:id/public/approve for non-CARD method sends confirmation email with post-signature PDF', async () => {
  // Mock resend.send; approve with CHECK method; assert send called with attachment
});
```

- [ ] **Step 2:** After `signature_data` is saved and status → APPROVED, load the org and the deposit, then — if `deposit?.payment_method !== 'CARD'` — call `sendEstimateApprovedNotification` with the post-signature PDF (signature_data is now present in DB → builder renders the signature block automatically):

```typescript
// In approvePublic, after the transaction that saves signature + sets status APPROVED:
const updated = await prisma.estimate.findUnique({
  where: { id },
  include: { deposit: true, organization: true, lead: { include: { customer: true } } },
});
if (updated?.deposit?.payment_method !== 'CARD') {
  await sendEstimateApprovedNotification({
    estimateId: updated!.id,
    org: updated!.organization,                 // explicit — sendEstimate... functions require org after Task 4.4
    to: updated!.lead.customer.email,
    customerName: `${updated!.lead.customer.first_name} ${updated!.lead.customer.last_name}`,
    estimateNumber: updated!.estimate_number,
    total: fmtCurrency(Number(updated!.total_amount)),
  });
}
```

- [ ] **Step 3:** For CARD approvals, DON'T send the confirmation email here — defer to the webhook (Task 4.6).

- [ ] **Step 4:** Run tests, commit:

```bash
git add backend/src/controllers/estimate.controller.ts
git commit -m "feat(email): send post-signature confirmation email immediately for non-CARD approvals"
```

---

### Task 4.6: Stripe webhook — post-signature PDF on CARD payment

**Files:**
- Modify: `backend/src/controllers/webhook.controller.ts`

- [ ] **Step 1:** Failing test: simulate `checkout.session.completed` for a deposit on an APPROVED estimate → assert resend called with post-signature PDF.

- [ ] **Step 2:** In `handleCheckoutSessionCompleted`, after marking the deposit PAID, if the estimate is APPROVED, call `sendEstimateApprovedNotification` with the post-signature PDF.

- [ ] **Step 3:** Run tests, commit:

```bash
git add backend/src/controllers/webhook.controller.ts
git commit -m "feat(webhook): send post-signature confirmation after Stripe deposit payment"
```

---

### Task 4.7: Authenticated payment-method change endpoint

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` — add `updatePaymentMethod`
- Modify: `backend/src/routes/estimate.routes.ts` — add route, remove public change endpoint

- [ ] **Step 1:** Failing tests:

```typescript
describe('PATCH /api/estimates/:id/payment-method', () => {
  it('ADMIN/DISPATCHER/SALES can change method on SENT estimate', async () => { /* ... */ });
  it('recomputes total_amount when CARD surcharge applies', async () => { /* ... */ });
  it('expires open Stripe session if present', async () => { /* ... */ });
  it('logs a TimelineEvent', async () => { /* ... */ });
  it('triggers re-send of estimate email with updated PDF', async () => { /* ... */ });
  it('rejects 403 for TECHNICIAN', async () => { /* ... */ });
  it('rejects 409 for DRAFT/CANCELLED', async () => { /* ... */ });
});
```

- [ ] **Step 2:** Implement per spec §9.5 steps 1-7.

- [ ] **Step 3:** **The existing route to remove is `POST /:id/change-payment-method`** (handler: `changePaymentMethod`, found at `backend/src/routes/estimate.routes.ts:14`, wired with `publicActionLimiter` — the customer-facing one, no `/public/` segment). Delete that route line AND delete the `changePaymentMethod` handler export from `estimate.controller.ts`. Replace with the new authenticated endpoint below.

Add the new authenticated route (rename so both old + new can't coexist — e.g., call the new handler `updatePaymentMethod` to disambiguate from the removed `changePaymentMethod`):

```typescript
// backend/src/routes/estimate.routes.ts
router.patch('/:id/payment-method',
  authenticate,
  authorize('ADMIN', 'DISPATCHER', 'SALES'),
  validate(updatePaymentMethodSchema),
  estimateController.updatePaymentMethod);
```

- [ ] **Step 4:** Run tests, commit:

```bash
git add backend/src/controllers/estimate.controller.ts backend/src/routes/estimate.routes.ts
git commit -m "feat(estimates): replace public payment-method change with authenticated endpoint"
```

---

### Task 4.8: Public page rebrand + remove payment-method selector

**Files:**
- Modify: `frontend/src/pages/PublicEstimatePage.tsx`

- [ ] **Step 1:** Pull `organization` from the public estimate response (now included per Task 4.1). Use its fields:
  - Replace hardcoded ALPHA CRM header with `<img src={organization.logo_url || null}>` (fallback: `{organization.name}` as bold text)
  - Set CSS variable `--brand-color` from `organization.brand_color` on the page root
  - Footer shows `organization.name`, `organization.website`, `organization.email`
  - Replace `<EstimateDocumentView>` Terms section with a short `organization.estimate_terms` summary + "See attached PDF for full terms"
- [ ] **Step 2:** Remove the payment-method selector UI. Replace with read-only line: `Payment method: {deposit.payment_method}. To change, please contact us at {organization.phone}.`
- [ ] **Step 3:** Add a prominent "Download PDF" button linking to `/api/estimates/:id/public/pdf?token=...`.
- [ ] **Step 4:** Manually test: open a public estimate link on desktop (embedded PDF preview works if desired) and mobile Safari (download works). Confirm sign/approve flow still functions.

- [ ] **Step 5:** Commit:

```bash
git add frontend/src/pages/PublicEstimatePage.tsx
git commit -m "feat(frontend): rebrand public estimate page and remove payment-method selector"
```

---

### Task 4.9: Change-payment-method dialog on estimate detail page

**Files:**
- Create: `frontend/src/components/estimates/ChangePaymentMethodDialog.tsx`
- Modify: `frontend/src/pages/EstimateDetailPage.tsx` — add action menu item

- [ ] **Step 1:** Build the dialog: a radio group of the 4 `PaymentMethod` values + "Update & Resend" primary button calling the new endpoint.

- [ ] **Step 2:** Add to the estimate detail page actions (visible to ADMIN / DISPATCHER / SALES).

- [ ] **Step 3:** Manual test: change method on a SENT estimate → verify email is re-sent, timeline event appears.

- [ ] **Step 4:** Commit:

```bash
git add frontend/src/components/estimates/ChangePaymentMethodDialog.tsx frontend/src/pages/EstimateDetailPage.tsx
git commit -m "feat(frontend): add payment-method change dialog on estimate detail page"
```

---

**Phase 4 Exit Criteria:**
- [ ] Sending an estimate produces an email with rebranded wrapper + attached pre-signature PDF
- [ ] Non-CARD approval fires the confirmation email immediately with post-signature PDF
- [ ] CARD approval fires the confirmation email only after Stripe webhook lands
- [ ] Public page uses org branding; mobile Safari "Download PDF" downloads the file
- [ ] Dispatcher can change payment method; customer receives a new email; TimelineEvent logged
- [ ] Public page no longer has a payment-method selector (read-only display only)

---

## Post-Implementation Tasks

### Task 5.1: Update documentation

- [ ] Update `CLAUDE.md`:
  - Development Commands table: add `npm run db:seed:org`
  - Database Schema section: add `Organization` to the Models list
- [ ] Update `memory/codebase.md`:
  - New backend files under `lib/pdf/`, new `organization.controller.ts`, new `seed-organization.ts`
  - New frontend `OrganizationSettingsPage`, `PdfPreviewDialog`, `ChangePaymentMethodDialog`
- [ ] Update `memory/pipeline-status.md`:
  - Close the "estimate template" item if it's flagged as an issue
- [ ] Commit docs updates:

```bash
git add CLAUDE.md memory/
git commit -m "docs: update CLAUDE.md + codebase.md for Organization + PDF templates"
```

### Task 5.2: Update Obsidian vault

- [ ] `Ideas/MVP-Estimate-Template-Alpha-Security.md` — update frontmatter: `status: implemented`; add completion date in body
- [ ] `Modules/Estimates.md` — update Current State: mention PDF generation + two templates + Org model
- [ ] Create `Decisions/Estimate-Content-Snapshot-On-Send.md` — document why we snapshot Terms/Notes/Payment Terms at send time (legal reproducibility)
- [ ] Create `Decisions/PDF-Generation-With-pdfmake.md` — document why pdfmake over Chromium/Gotenberg/react-pdf
- [ ] Create `Learnings/Multi-Tenant-Schema-With-DB-Defaults.md` — the DB-DEFAULT trick that made Phase 1 painless
- [ ] Append to `log.md` — session summary

### Task 5.3: Merge and tag

- [ ] Run full test suite one more time: `cd backend && npm test` + `cd frontend && npx playwright test`
- [ ] If in a worktree, open PR to `main`; otherwise merge the feature branch per `.claude/skills/ship-changes/SKILL.md`
- [ ] After merge, run visual sign-off against `examples/workiz-alpha-estimates/*.pdf` one last time
- [ ] Close the KI / MVP-required idea in the vault

---

## Recommended Execution Path

- **Phases 1 + 2** → first PR (data layer + authenticated PDF). Fast to ship, gives Alpha internal dogfooding fast.
- **Phase 3** → second PR (Settings UI + crm-default). Unlocks per-tenant branding.
- **Phase 4** → third PR (public + emails + payment flow). Closes the MVP template gate.

Three merge-able PRs. Target: 3-5 working days end-to-end.
