# Organization Model + Estimate PDF Templates — Design Spec

**Date:** 2026-04-24
**Status:** Reviewer-approved (iteration 3) — pending user sign-off
**Module:** Estimates (with cross-cutting `Organization` foundation)
**MVP gate:** Required for Alpha Doors & Security dual-run launch
**Related vault notes:** `Ideas/MVP-Estimate-Template-Alpha-Security.md`, `Modules/Estimates.md`, `Architecture/Email-System.md`

---

## 1. Summary

Introduce a per-tenant `Organization` model so the platform can render estimates with each contractor business's branding and content. Ship two selectable estimate templates (`crm-default`, `alpha-classic`), a real PDF generation pipeline (`pdfmake`), and an admin Settings UI for organization branding and editable document copy. For the dual-run, Alpha Doors & Security will select `alpha-classic` — a pixel-level match of the Workiz-generated PDFs they use today.

## 2. Motivation

- **MVP-blocker**: dual-run validation requires estimates "indistinguishable from the incumbent workflow" (ref: `Ideas/MVP-Estimate-Template-Alpha-Security.md`). Today the renderer is a generic React component with no branding hook, no PDF output, and no per-tenant configurability.
- **Future-proofing**: the platform is a multi-tenant SaaS. Hardcoding any single tenant's branding now creates a rewrite later. The right time to introduce `Organization` is before we have more than one tenant's data to migrate.
- **Architectural clarity**: the industry-standard SaaS-document pattern — **platform owns layout, organization owns content** — gives us a small library of layouts (code) and per-org configurable data (DB), with no arbitrary per-tenant layout editing to maintain.

## 3. Goals

1. Render estimates as real PDFs that can be downloaded, emailed as attachments, and previewed inline.
2. Support two templates from day one: `crm-default` (existing look) and `alpha-classic` (Alpha Doors & Security).
3. Add a tenant-scoped `Organization` model with branding (logo, color, contact info) and editable document copy (Terms, Notes, Payment Terms).
4. Provide an Admin-only Settings UI to manage the organization's branding and copy.
5. Rebrand the public estimate page to use organization branding while keeping its interactive flows (signature, approve/decline, payment method, deposit).
6. Keep Alpha's dual-run experience smooth: the estimates customers receive look exactly like the Workiz PDFs they're used to.

## 4. Non-Goals

- **Multi-tenant query scoping enforcement.** Adding `organization_id` FKs now future-proofs the schema; controller-level scoping (WHERE clauses filtering by the requester's org) is a separate, larger workstream when we onboard tenant #2.
- **User-editable template layouts.** Tenants pick from a platform-curated library; they cannot design or upload custom layouts.
- **Rich-text editor for Terms / Notes / Payment Terms.** MVP uses plain `<textarea>` with light Markdown support (bold, bullets, numbered lists). A WYSIWYG editor is deferred.
- **PDF caching.** Regenerate on every request. Revisit if the route becomes a hot path.
- **Multi-language / localization.** English only for MVP.
- **Self-service tenant signup.** Organizations are admin-created in DB; the signup flow is a separate epic.
- **Invoice PDFs.** This spec scopes estimates only. The same pattern will extend to invoices in a follow-up spec.

## 5. Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│ Frontend                                                        │
│                                                                 │
│  EstimateFormPage   "Preview PDF" button → Dialog(iframe)       │
│  EstimateDetailPage  embedded PDF iframe as document view       │
│  PublicEstimatePage  rebranded React HTML + "Download PDF"      │
│  OrgSettingsPage     /settings/organization (Admin only)        │
│                                                                 │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────┐
│ Backend — Express + Prisma                                      │
│                                                                 │
│  GET  /api/estimates/:id/pdf        → streams application/pdf   │
│  GET  /api/organization             → org for current tenant    │
│  PATCH /api/organization            → update org (Admin only)   │
│  POST /api/organization/logo        → upload logo → Supabase    │
│                                                                 │
│  lib/pdf/                                                       │
│    index.ts                         → generateEstimatePdf()     │
│    templates/                                                   │
│      registry.ts                    → templateRegistry map      │
│      alpha-classic.ts               → buildAlphaClassicPdf()    │
│      crm-default.ts                 → buildCrmDefaultPdf()      │
│    fonts.ts                         → Inter font embedding      │
│    markdown.ts                      → text → pdfmake nodes      │
│                                                                 │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────┐
│ PostgreSQL (Supabase)                                           │
│                                                                 │
│  organizations (new)                                            │
│  users / customers / leads / estimates / jobs / invoices        │
│   ... all get organization_id FK                                │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

## 6. Data Model

### 6.1 New model: `Organization`

```prisma
// Fixed UUID for Alpha Doors & Security (single-tenant MVP seed).
// Referenced directly by the DB DEFAULT on organization_id columns
// so unscoped inserts (tests, seeders, existing controllers) route here
// transparently until we onboard tenant #2.
//   ALPHA_ORG_ID = '00000000-0000-0000-0000-000000000001'

model Organization {
  id                      String   @id @db.Uuid
  // NOTE: no @default(uuid()) — Alpha gets the fixed ALPHA_ORG_ID;
  // future orgs are inserted with application-generated UUIDs.
  name                    String   @db.VarChar(200)
  legal_name              String?  @db.VarChar(200)

  // Address (used in PDF header + customer-facing)
  address_line1           String   @db.VarChar(200)
  address_line2           String?  @db.VarChar(200)
  city                    String   @db.VarChar(100)
  state                   String   @db.VarChar(50)
  postal_code             String   @db.VarChar(20)
  country                 String   @default("US") @db.VarChar(2)

  // Contact
  email                   String   @db.VarChar(200)
  phone                   String?  @db.VarChar(50)
  website                 String?  @db.VarChar(200)

  // Branding
  logo_url                String?  @db.Text
  brand_color             String   @default("#242424") @db.VarChar(7)

  // Template selection + copy
  estimate_template       String   @default("alpha-classic") @db.VarChar(50)
  estimate_terms          String   @db.Text
  estimate_notes          String   @db.Text
  estimate_payment_terms  String   @db.Text

  created_at              DateTime @default(now()) @db.Timestamptz(6)
  updated_at              DateTime @updatedAt @db.Timestamptz(6)

  // Back-relations (added alongside FK on each direct-scoped target)
  users      User[]
  customers  Customer[]
  leads      Lead[]
  estimates  Estimate[]
  jobs       Job[]
  invoices   Invoice[]

  @@map("organizations")
}
```

### 6.2 Foreign key additions

Add `organization_id String @db.Uuid @default(dbgenerated("'00000000-0000-0000-0000-000000000001'::uuid"))` + FK relation to these six tables ONLY:

- `User`
- `Customer`
- `Lead`
- `Estimate`
- `Job`
- `Invoice`

Every other table reaches the organization transitively via its parent — no direct FK added, scoping enforced on the parent when/if scoping middleware is introduced:

- `Payment` → `Invoice` → org
- `EstimateLineItem` → `Estimate` → org
- `Deposit`, `EstimateSendConfig` → `Estimate` → org
- `JobCharge` → `Job` → org
- `Attachment`, `Note`, `TimelineEvent` — polymorphic; reach org via their `entity_type` + `entity_id` parent
- `ServiceLocation` → `Customer` → org

NOT scoped, intentionally global:
- `StateTaxRate` (shared reference data)
- `StripeEvent` (platform-level Stripe integration)
- `AppSetting` (platform-level config distinct from per-org config; retained for truly global keys)

**Why the DB-level DEFAULT matters**: existing controllers, Prisma factories, and the 605 backend tests do not pass `organization_id` on `create()`. The default (fixed Alpha UUID) makes every such insert succeed without code changes during Phase 1. When tenant #2 onboards, we remove the default and add explicit org injection in controllers — but that's a separate, planned workstream (see §14 risks).

### 6.3 Migration + seed strategy

Migrations stay structural; tenant-specific data (Alpha's copy) lives in a new seed script. The structural migration + seed run sequentially on deploy (`npx prisma migrate deploy && npx tsx backend/src/seed-organization.ts`).

**Single Prisma migration** (`organization_and_tenant_fks`), executes in this order:

1. **Create** `organizations` table (with the schema from §6.1).
2. **Insert the Alpha row via raw SQL** inside the migration (data needed before the DEFAULT can reference it):
   ```sql
   INSERT INTO organizations (id, name, address_line1, city, state, postal_code,
     email, website, brand_color, estimate_template,
     estimate_terms, estimate_notes, estimate_payment_terms)
   VALUES ('00000000-0000-0000-0000-000000000001',
     'Alpha Doors & Security INC.', '1001 Willow Avenue',
     'Hoboken', 'NJ', '07030',
     'info@alphasecurityus.com', 'https://alphadoorsnewjersey.com/',
     '#E11D2E', 'alpha-classic',
     '', '', '');  -- text fields populated by the seed script in step 6
   ```
3. **Add** `organization_id UUID` columns with the `DEFAULT '00000000-...-000001'::uuid` clause, nullable initially, on the six direct-scoped tables (§6.2).
4. **Backfill** every existing row: `UPDATE <table> SET organization_id = '00000000-...-000001';` (a no-op in practice because the DEFAULT handles new inserts, but explicit covers rows inserted during deploy racing the ALTER).
5. **Alter** columns to `NOT NULL` + add FK constraints + indexes on `organization_id`.

**Separate seed script** — `backend/src/seed-organization.ts` — runs AFTER the migration:

6. `UPDATE organizations SET estimate_terms = $1, estimate_notes = $2, estimate_payment_terms = $3 WHERE id = '00000000-...-000001'` — values are the verbatim text extracted from `examples/workiz-alpha-estimates/*.pdf` (pages 2-4: Terms paragraph, Notes list items 1-9, Payment Terms bullets). The script is idempotent (WHERE id = known UUID) and safe to re-run.

**Why split structural migration from content seed**: migration SQL is canonical, environment-agnostic, and checked-in once. Content (copy, brand color) may need to change post-deploy without a new migration — the seed script can be re-run with updated text. Also: dev/test DBs can skip the seed to exercise the "empty org" code path.

**Existing seed scripts** (`seed.ts`, `seed-technician.ts`, `seed-tax-rates.ts`) require no changes — inserts fall through to the DB DEFAULT. Add `seed-organization.ts` to `package.json` scripts as `db:seed:org` + update `CLAUDE.md` "Development Commands" table.

**Rollback plan**: drop `organization_id` columns, drop `organizations` table. Safe because no data depends on the relation yet.

### 6.4 Estimate content snapshot (legal reproducibility)

`Organization.estimate_terms` / `estimate_notes` / `estimate_payment_terms` are globally mutable — an admin can edit them in Settings at any time. Without a snapshot, re-rendering an old estimate's PDF would retroactively show whatever text is current, including on the customer's approved copy. That's a legal/compliance problem: the terms in effect at the moment the customer signed are what binds both parties.

**Fix: snapshot the org's document copy onto the estimate at send time.** Add three columns to the existing `Estimate` model:

```prisma
model Estimate {
  // ... existing fields
  snapshot_terms          String?  @db.Text
  snapshot_notes          String?  @db.Text
  snapshot_payment_terms  String?  @db.Text
  // ...
}
```

Populated via the existing `POST /api/estimates/:id/send` action — at the moment status transitions DRAFT → SENT, copy `Organization.estimate_terms` → `Estimate.snapshot_terms` (and the other two) in the same transaction.

**PDF builder logic** (both templates): prefer `estimate.snapshot_*`; fall back to live `organization.estimate_*` only for DRAFT estimates (preview mode, not yet sent). Once SENT, the snapshot is immutable and the PDF always reads from it.

**Field copy (brand name, logo, color) is NOT snapshotted** — these change rarely and re-branding retroactively is acceptable (and expected) behavior. Only the legally-significant text is snapshotted.

Nullable (`?`) because DRAFT estimates don't have a snapshot yet. NULL → fall back to live org fields.

Rollback: drop three columns; no data loss since they're nullable and derived.

## 7. PDF Generation Pipeline

### 7.1 Library choice: `pdfmake`

- MIT-licensed, built on PDFKit
- Declarative JSON `docDefinition`, easy to generate programmatically from Prisma records
- `pageBreakInside: 'auto'` (default) lets tall rows split across pages, avoiding the Workiz "empty page 1" bug where long rows are shoved to the next page. Known quirk: rows that contain images can still break awkwardly — mitigated by keeping image cells a fixed small square (40pt) and letting text wrap beside, not below, them
- Node usage goes through `PdfPrinter` from `pdfmake/src/printer`, NOT the browser `pdfmake.vfs` mechanism (that works in browsers but is awkward server-side). Fonts are loaded from disk paths at printer construction; see §7.7
- No Chromium, no microservice, no per-PDF fees
- Works inside the existing Node container

Rejected alternatives: Puppeteer/Playwright in-process (container bloat, memory churn), Gotenberg microservice (ops overhead), `@react-pdf/renderer` (would require its own component tree rewrite — same two-template drift problem in a new form), hosted APIs (cost at volume). Research summary retained in conversation; this spec does not re-argue them.

### 7.2 Module layout

```
backend/src/lib/pdf/
├── index.ts                      # generateEstimatePdf(estimateId) — entry point
├── templates/
│   ├── registry.ts               # { 'alpha-classic': fn, 'crm-default': fn }
│   ├── alpha-classic.ts          # buildAlphaClassicPdf(estimate, org) → docDefinition
│   └── crm-default.ts            # buildCrmDefaultPdf(estimate, org) → docDefinition
├── fonts.ts                      # Inter font file loading + embed config
└── markdown.ts                   # Simple markdown → pdfmake node converter
                                  # (headings, bold, bullets, numbered lists only)
```

### 7.3 API routes

Two separate routes mirror the existing split between authenticated and public estimate endpoints (see `backend/src/routes/estimate.routes.ts` — `getOne` vs `getPublic`):

```
GET /api/estimates/:id/pdf
  - Middleware chain: authenticate → authorize(ADMIN, SALES, DISPATCHER)
  - Used by: form preview Dialog, detail page iframe, admin "Download PDF"
  - Response: 200 application/pdf, streamed
  - Headers: Content-Disposition: inline; filename="estimate-<number>.pdf"
    (inline → embeds in browser's PDF viewer for in-app preview)
  - Errors: 404 if not found, 500 if generation fails

GET /api/estimates/:id/public/pdf?token=<public_token>
  - Middleware chain: publicReadLimiter (existing — 20 req/15min per IP)
  - Token validation identical to the existing getPublic controller
    (backend/src/controllers/estimate.controller.ts): load by id,
    verify token matches estimate.public_token, else 404
  - Used by: customer "Download PDF" button on PublicEstimatePage, email link
  - Response: 200 application/pdf, streamed
  - Headers: Content-Disposition: attachment; filename="estimate-<number>.pdf"
    (attachment → forces download on mobile instead of broken inline embed;
     mobile browsers often can't render embedded PDFs inside iframes)
```

**Public estimate response extension** (`GET /api/estimates/:id/public`):
The existing endpoint's response payload must be extended to include a minimal `organization` subset so the public page can render branded chrome without a second round-trip. New fields returned:

```typescript
{
  // ... existing estimate fields
  organization: {
    name: string;
    logo_url: string | null;
    brand_color: string;
    email: string;
    website: string | null;
    estimate_terms: string;  // For the T&C summary section on the public page
  }
}
```

Fields explicitly NOT exposed publicly: `country`, `legal_name`, `estimate_template`, `estimate_notes`, `estimate_payment_terms` (latter two live in the PDF only).

Controller flow (shared by both PDF routes after their auth step):

1. Load estimate + line items + lead + customer + deposit + send_config (+ snapshot_* columns)
2. Load organization via `estimate.organization_id`
3. Resolve builder: `templateRegistry[org.estimate_template]`
   - If unknown template key: fall back to `crm-default` and log a warning (Winston warn)
4. Choose T&C source: use `estimate.snapshot_*` if status is SENT/PENDING/APPROVED/etc.; fall back to live `organization.estimate_*` only for DRAFT (see §6.4)
5. Build docDefinition, create stream via `PdfPrinter`, pipe to response, call `doc.end()`

### 7.4 Template registry

```typescript
// backend/src/lib/pdf/templates/registry.ts
import { buildAlphaClassicPdf } from './alpha-classic';
import { buildCrmDefaultPdf } from './crm-default';

export const templateRegistry = {
  'alpha-classic': buildAlphaClassicPdf,
  'crm-default':   buildCrmDefaultPdf,
} as const;

export type TemplateKey = keyof typeof templateRegistry;
```

Adding a future template is: add a builder file, register it in the map, add a thumbnail PNG, update the Settings UI enum.

### 7.5 Template `alpha-classic` — layout spec

Matches `examples/workiz-alpha-estimates/*.pdf` verbatim, with two Workiz quirks explicitly dropped:

- ❌ Duplicate trailing "QTY" column (always 0.00) — removed
- ❌ "QTY 0.00" row in totals block — removed

Layout (top to bottom, page 1):

1. **Header band** (~120pt tall)
   - Left: `org.logo_url` image (rendered at the resized dimensions stored on upload — see §8.2; aspect-preserved within 200pt × 80pt bounding box)
   - **Logo-missing fallback**: if `org.logo_url IS NULL`, render `org.name` as bold text (24pt, brand color) in the same position
   - Right: "ESTIMATE" wordmark (bold, 32pt, gray-600)
2. **Company info strip** (below header)
   - Left column: `org.name`, `org.address_line1, city, state postal_code`, `org.email`, `org.website`
   - Right column (right-aligned key/value):
     - "Estimate #" → `estimate.estimate_number`
     - "Date" → `estimate.created_at` formatted "Wed Apr 22, 2026"
     - "Total" → `estimate.total_amount` formatted as currency
3. **Customer block** (two columns)
   - "Prepared For:" — `customer.first_name + last_name`, customer's primary `service_location` address (the location row where `is_primary = true`), `customer.phone`, `customer.email`
   - "Service Location:" — see "Same as billing" rule below
   - **"Same as billing" rule**:
     - IF `lead.service_address_line1 IS NOT NULL` AND any of `service_address_*` differs from the customer's primary service location → render the lead's full `service_address_*` block
     - ELSE render the literal text "Same as billing" (one line) in place of the address
   - The two columns are always rendered side-by-side regardless; only the right column's body text differs
4. **Line items table**
   - Columns: Description | QTY | Price | Amount (4 columns, drop the 5th)
   - Description cell: bold first line + lighter detail text on subsequent lines
   - Optional thumbnail image in Description cell if `price_book_item.image_url` present (40pt square)
   - Light dotted column dividers, light row dividers
   - `pageBreakInside: 'auto'` so tall rows split naturally across pages
5. **Totals block** (right-aligned, 3 lines)
   - Sub total
   - Tax (rate in parens, e.g., "Tax (6.625%)")
   - Total (bold, larger)
6. **Terms section** (after totals, may break to next page)
   - "Terms:" label + content from `estimate.snapshot_terms` if present, else `org.estimate_terms` (see §6.4)
7. **Notes section**
   - "Notes:" label + content from `estimate.snapshot_notes` if present, else `org.estimate_notes` (Markdown rendered)
8. **Payment Terms section**
   - "PAYMENT TERMS:" label + content from `estimate.snapshot_payment_terms` if present, else `org.estimate_payment_terms` (Markdown rendered)
9. **Conditional signature block** (only when `estimate.signature_data IS NOT NULL`)
   - "Customer Signature:" label
   - Embedded signature image (`estimate.signature_data` is a base64 data URL → decoded and inserted as PDF image, ~150pt × 60pt)
   - "Approved on {estimate.signature_at formatted}" caption beneath
10. **Footer line** (centered, bold, 18pt): "Thank You For Your Business"

Page-break rules:
- Page break allowed inside table rows (prevents empty page 1)
- `pageBreakBefore: true` on "Terms" if less than ~80pt remain on current page (prevents orphaned "Terms:" label)
- Running page footer with page number if doc exceeds 1 page

### 7.6 Template `crm-default` — layout spec

Port of current `frontend/src/components/estimates/EstimateDocumentView.tsx` to pdfmake. Preserves:

- Centered header — IF `org.logo_url` present: render the resized logo (see §8.2); ELSE render `org.name` as bold text (24pt, brand color)
- Below header: `FileText` icon + "Estimate E00001" title + "Prepared for {customer}" subtitle
- "Scope of Work" card (if `scope_notes` present)
- Card-based line items with:
  - 56pt thumbnail image on left (or fallback Package/Wrench icon)
  - Material (orange) / Service (blue) tag beneath image
  - Name + detail + Qty @ Price on right
  - Line-discount strikethrough if applicable
- Totals block (right-aligned): Subtotal, Line Discounts (if any), estimate-level Discount (if any), Tax, Total
- **Same "Same as billing" rule as `alpha-classic`** (§7.5) for the customer/service-location block
- **Conditional signature block** identical to `alpha-classic` step 9 — rendered when `estimate.signature_data IS NOT NULL`

Terms/Notes/Payment Terms sections render from `estimate.snapshot_*` if present, else `org.estimate_*` (same source-selection logic as `alpha-classic`; see §6.4).

### 7.7 Fonts (server-side embedding)

Inter (400/500/600/700 + matching italics) is embedded via the Node `PdfPrinter` API, NOT the browser `pdfmake.vfs` path:

```typescript
// backend/src/lib/pdf/fonts.ts
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

The entry-point `generateEstimatePdf` uses `printer.createPdfKitDocument(docDefinition)` and returns the resulting stream. The controller wires it up as:

```typescript
const doc = printer.createPdfKitDocument(docDefinition);
res.setHeader('Content-Type', 'application/pdf');
res.setHeader('Content-Disposition', `inline; filename="estimate-${estimate.estimate_number}.pdf"`);
doc.pipe(res);
doc.end();
```

Font files live in `backend/src/lib/pdf/fonts/` (checked into repo, ~500 KB total). `tsc` + the existing build step copy them to `dist/` via a `tsconfig.json` `assets` include or a small `cpx` step in `package.json`.

### 7.8 Preview fixture (for Settings UI "Preview Estimate PDF")

The Org Settings UI offers a "Preview Estimate PDF" button (§8.2) that lets admins see what their branding choices look like without needing a real estimate. The fixture is a hardcoded constant in the PDF module — no DB row, no flag, no special data path:

```typescript
// backend/src/lib/pdf/preview-fixture.ts
export const PREVIEW_ESTIMATE_FIXTURE = {
  estimate_number: 'E00001',
  created_at: new Date('2026-04-22T12:00:00Z'),
  status: 'SENT',
  customer: {
    first_name: 'Jane',
    last_name: 'Doe',
    company_name: null,
    email: 'jane.doe@example.com',
    phone: '(555) 123-4567',
    primary_service_location: {
      address_line1: '123 Main Street',
      city: 'Hoboken',
      state: 'NJ',
      zip: '07030',
    },
  },
  lead: { /* same address as customer's primary → triggers "Same as billing" */ },
  line_items: [
    { description: 'Maglock 1200P (Alarm Controls)\nExact Replacement',
      item_type: 'MATERIAL', quantity: 1, unit_price: 499.00, line_total: 499.00 },
    { description: 'LABOR', item_type: 'SERVICE',
      quantity: 2, unit_price: 225.00, line_total: 450.00 },
    { description: 'Comprehensive Service Plan\nIncludes 6 month warranty extension and priority response',
      item_type: 'SERVICE', quantity: 1, unit_price: 99.00, line_total: 99.00,
      discount_type: 'PERCENTAGE', discount_value: 10, discount_amount: 9.90 },
  ],
  subtotal: 1038.10,
  tax_rate: 0.06625,
  tax_amount: 68.77,
  total_amount: 1106.87,
  signature_data: null,  // Pre-signature view
};
```

Coverage rationale: includes both MATERIAL and SERVICE item types, a long multi-line description (tests pagination), a per-line discount (tests strikethrough rendering), realistic NJ tax rate matching Alpha's region. Builders consume the fixture identically to a real estimate — no special branch.

The preview route (`GET /api/organization/preview-pdf`) loads the fixture, the current saved org, and pipes the same builder pipeline through. Output is `Content-Disposition: inline` (admin previews in a Dialog).

### 7.9 Markdown parsing (for Terms / Notes / Payment Terms fields)

Minimal parser supporting:
- Paragraphs (blank line separated)
- Bold (`**text**`)
- Bullets (`- item` or `* item`)
- Numbered lists (`1. item`)
- NOT supported in MVP: headers, links, tables, inline code

Small hand-written parser (~80 lines). No external markdown lib needed — keeps dependencies minimal.

## 8. Organization Settings UI

### 8.1 Route & access

- Path: `/settings/organization`
- Access: `ADMIN` role only (existing `authorize('ADMIN')` middleware)
- Added to Settings nav in `Sidebar.tsx`

### 8.2 Form sections

**Branding**
- Logo upload: drag-and-drop or click, max 2 MB raw upload, PNG/JPEG/SVG. **Server-side resize on upload**: image is resized to fit within a 200pt × 80pt bounding box (aspect-preserved; PDF point ≈ 1.33 px so the resized PNG is ≈ 267 × 107 px @ 1× DPR, doubled for retina). Library: `sharp` (already a common Node image lib; if not present, add as a dep). Resized image saved to Supabase Storage; URL stored in `org.logo_url`. SVGs are passed through unresized (vectors scale natively in pdfmake). Preview shown at the resized display size (200×80 box).
- Brand color: `<input type="color">` bound to `org.brand_color`
- Template: radio group with two options + static thumbnail PNG (~150×200px) beside each. Options: "Alpha Classic" (`alpha-classic`), "CRM Default" (`crm-default`).

**Company Info**
- Name (required), Legal Name (optional)
- Address line 1 (required), line 2 (optional)
- City, State, Postal Code (required), Country (US default, dropdown)
- Email (required, validated), Phone (optional), Website (optional, URL validated)

**Estimate Document Copy**
- Terms: 5-row `<textarea>`, placeholder with example
- Notes: 12-row `<textarea>`, placeholder showing markdown bullet syntax
- Payment Terms: 8-row `<textarea>`, placeholder with example bullets
- Small "Markdown supported: **bold**, bullets, numbered lists" helper below each

**Actions**
- "Save Changes" (primary) — `PATCH /api/organization`
- "Preview Estimate PDF" (secondary) — clicking this:
  1. Auto-saves the current form values via `PATCH /api/organization` (no warning, no extra confirmation — the form is already valid since validation runs on every change)
  2. Opens a Dialog with an iframe → `GET /api/organization/preview-pdf`
  3. The preview PDF reflects exactly what's now persisted in the DB (which equals what the admin just typed)

The auto-save-on-preview pattern keeps WYSIWYG simple: the admin types → clicks Preview → sees their changes. No surprise about whether the preview shows saved-state or form-state because they're now the same.

### 8.3 API

```
GET  /api/organization               # Returns the current org (single row for MVP)
PATCH /api/organization              # Updates; validates via Zod; ADMIN only
POST /api/organization/logo          # Multipart upload, returns URL; ADMIN only
GET  /api/organization/preview-pdf   # Returns PDF with a fixture estimate
                                     # + current saved org values; ADMIN only
```

**PATCH body validation (Zod)** — all fields optional but explicitly constrained:

```typescript
const patchOrgSchema = z.object({
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
```

Logo upload is a separate multipart endpoint (MIME-type allowlist + size cap enforced in middleware; see §12).

For MVP, `/api/organization` returns "the" organization (there's only one). When we onboard tenant #2, this route scopes to the requester's org via middleware.

## 9. Estimate Surface Updates

### 9.1 Estimate form page (`EstimateFormPage.tsx`)

- **Remove**: inline `EstimateDocumentView` preview at the bottom
- **Add**: "Preview PDF" button in the action bar. Clicking opens a Dialog with embedded iframe rendering `/api/estimates/:id/pdf` (after auto-save-draft). For new-estimate mode, auto-save occurs first so the ID exists.

### 9.2 Estimate detail page (`EstimateDetailPage.tsx`)

- **Replace**: inline `EstimateDocumentView` with an embedded iframe at the same vertical position
- **iframe src**: `/api/estimates/:id/pdf`
- **Height**: fixed to viewport height minus header/tabs (~800px default, responsive)
- **Add** "Download PDF" button (triggers browser download via `Content-Disposition: attachment`)
- Existing action buttons (Send, Cancel, Duplicate, etc.) remain unchanged

### 9.3 Public estimate page (`PublicEstimatePage.tsx`)

Keeps React HTML rendering. Rebranded to consume `Organization`:

- Header: `<img src={org.logo_url}>` replaces hardcoded "ALPHA CRM" text
- Button/accent colors: `org.brand_color` applied via CSS variable
- Footer: `org.name` + `org.website` + `org.email`
- Document section: existing `EstimateDocumentView` component, restyled to use `brand_color` for accents; company info block at top uses `org.*` fields
- Short T&C summary section added (just `org.estimate_terms`) with a note: "See attached PDF for full terms, notes, and payment terms."
- "Download PDF" button (prominent) in the signature/approve area

Existing interactive elements — signature canvas, approve/decline, payment method selector, deposit checkout — are unchanged.

### 9.4 Email updates (`backend/src/lib/email.ts`)

This spec touches **estimate emails only**. Invoice email branding is explicitly out of scope (follow-up spec — §4 non-goals).

All estimate emails:
- HTML body trimmed to a short message ("Hi {customer}, your estimate {number} is ready — click below to review and sign")
- The estimate PDF is **attached** to every email (generated on send via `generateEstimatePdf`)
- Email wrapper uses `org.name`, `org.logo_url` (if set), `org.brand_color` for the header band (replaces hardcoded "ALPHA CRM" #2563EB header)

PDF attachment timing — explicitly specified so the builder knows whether to render the signature block:

| Email function | PDF version attached | Trigger |
|---|---|---|
| `sendEstimateEmail` | Pre-signature (status = SENT / PENDING, `estimate.signature_data` is null → builder omits signature block) | Sales clicks "Send" |
| `sendEstimateWithDepositEmail` | Pre-signature (same as above) | Sales clicks "Send" with deposit configured |
| `approvalConfirmationHtml` — non-CARD path | **Post-signature** | Customer approves on public page with non-CARD payment method (CASH, CHECK, BANK_TRANSFER); fires immediately on approval |
| `approvalConfirmationHtml` — CARD path | **Post-signature** | Customer approves AND completes Stripe Checkout for the deposit; fires from the Stripe webhook handler (`webhook.controller.ts`) on `checkout.session.completed`, NOT from the approve action itself |

This split exists because CARD payments are async — customer approves, then completes Stripe Checkout in a redirect; the deposit isn't truly "done" until the webhook lands. Sending the post-signature PDF before payment confirmation would be premature. Non-CARD methods have no such async step, so the PDF goes out immediately on approval.

Both templates (`alpha-classic`, `crm-default`) MUST support the conditional signature block (§7.5 step 9, §7.6).

Specifically affected functions:
- `sendEstimateEmail` — add PDF attachment (pre-signature)
- `sendEstimateWithDepositEmail` — add PDF attachment (pre-signature)
- `sendEstimateApprovedNotification` / `approvalConfirmationHtml` — add PDF attachment (post-signature) for non-CARD path
- `webhook.controller.ts → handleCheckoutSessionCompleted` — call `sendEstimateApprovedNotification` with post-signature PDF for CARD path

### 9.5 Payment method change flow (post-send)

**Rule**: once an estimate is sent to the customer, the **customer cannot change the payment method themselves** — the current `POST /api/estimates/:id/public/change-payment-method` endpoint (invoked from the public page) is removed. Changes must go through office staff.

**Who can change**: `ADMIN`, `DISPATCHER`, `SALES` (via `authorize(...)` on the internal endpoint).

**How it works**:
- New authenticated endpoint: `PATCH /api/estimates/:id/payment-method` with body `{ payment_method: 'CARD' | 'CASH' | 'CHECK' | 'BANK_TRANSFER' }`
- Controller flow (single transaction):
  1. Load estimate + deposit. If estimate is not in SENT/PENDING/APPROVED, reject 409.
  2. Update `deposit.payment_method` (and recompute `surcharge_amount` via `getSurchargeRate` — already exists in `lib/stripe.ts`)
  3. Recompute `estimate.total_amount` if surcharge changed
  4. Invalidate any open Stripe Checkout session on the deposit (if CARD → non-CARD, or CARD → CARD but session expired; use `stripe.checkout.sessions.expire(session_id)`)
  5. If new method is CARD, the existing public-page deposit flow will create a fresh session on next customer visit — no action needed here
  6. Send a new estimate email with the updated PDF attached (via `sendEstimateEmail` — pre-signature if not yet signed, post-signature if signed — recompute which version based on `signature_data`)
  7. Append a `TimelineEvent` on the estimate: "Payment method changed from X to Y by {user}"

**Signature validity**: the customer's existing signature remains valid; the work scope hasn't changed, only the payment mechanism. The newly attached PDF shows the updated total — customer can call back if they want to revisit.

**Frontend**: add a "Change Payment Method" action in the estimate detail page action menu (Admin/Dispatcher/Sales only). Dialog with a method selector + "Update & Resend" button.

**Public page**: remove the payment-method selector UI that currently shows on PublicEstimatePage. Replace with a read-only line: "Payment method: {method}. To change, please contact us at {org.phone}." This is the only behavior-change the public customer will see.

## 10. Implementation Phases

Each phase is an independent PR that can merge, be tested, and ship without blocking the others. Order matters — phases depend on earlier ones' schema/pipeline.

### Phase 1 — Schema + Org seed + Estimate snapshot columns
- Structural Prisma migration: create `Organization`, add FKs with DB DEFAULT → Alpha UUID, backfill, NOT NULL (see §6.3)
- Same migration adds `snapshot_terms`, `snapshot_notes`, `snapshot_payment_terms` (nullable) to the `Estimate` model (see §6.4)
- New `backend/src/seed-organization.ts` script populating Alpha's Terms/Notes/Payment Terms text
- `Organization` Prisma model + types exposed
- No controller changes, no UI changes (the DB DEFAULT lets existing inserts continue working unchanged; snapshot columns are nullable so existing DRAFT/SENT estimates need no backfill)
- **Exit criteria**: `npx prisma migrate deploy && npx tsx backend/src/seed-organization.ts` runs cleanly in dev + test; `SELECT * FROM organizations` returns Alpha row with populated text; all 605 existing backend tests pass without modification; CI migration test job passes on a fresh Postgres container

### Phase 2 — PDF pipeline + `alpha-classic` template (authenticated only)
- `pdfmake` dependency + `lib/pdf/` module (printer, fonts, markdown parser, registry)
- `alpha-classic` builder (supports conditional signature block)
- `crm-default` builder can be a stub (throws "not yet implemented") — real impl in Phase 3
- `GET /api/estimates/:id/pdf` route (authenticated only — public route deferred to Phase 4)
- Estimate detail page: replace inline view with embedded PDF iframe; add "Download PDF"
- Estimate form page: "Preview PDF" button + Dialog
- **Exit criteria**: downloading a PDF for an Alpha estimate matches `examples/workiz-alpha-estimates/*.pdf` on three test cases — (1) single short line item (1 page), (2) single long-description line item (2 pages, proves the Workiz empty-page-1 bug is fixed), (3) 8+ line items (3+ pages, proves multi-page pagination). Visual-diff methodology: side-by-side viewer sign-off by the user, not automated pixel diff

### Phase 3 — `crm-default` template + Settings UI
- `crm-default` pdfmake builder (port of `EstimateDocumentView` visual — card-based, image thumbnails, Material/Service tags, line discount strikethrough, conditional signature block)
- Static thumbnail PNG for each template (generated once, committed to `frontend/public/template-thumbs/`)
- `/settings/organization` route + page
- `GET/PATCH /api/organization`, `POST /api/organization/logo`, `GET /api/organization/preview-pdf`
- Supabase Storage bucket `org-logos` provisioned (public-read policy; see §12)
- Sidebar nav entry "Organization Settings" (Admin-gated)
- **Exit criteria**: admin can upload logo, edit all fields, pick either template, save, and see "Preview PDF" reflect the saved changes; switching template re-renders the preview correctly; logo appears in the PDF header

### Phase 4 — Public page rebrand + email PDF attachments + payment-method change flow
- **Public PDF route + page rebrand**:
  - New `GET /api/estimates/:id/public/pdf?token=...` route (`publicReadLimiter` + token check, `Content-Disposition: attachment`)
  - Extend `GET /api/estimates/:id/public` response to include the `organization` subset (§7.3)
  - `PublicEstimatePage` consumes org data (logo, brand color, contact, terms summary)
  - "Download PDF" button on public page (uses the public route)
  - Remove the payment-method selector UI from the public page (§9.5); replace with a read-only line
- **Send/receive email updates** (`lib/email.ts`):
  - HTML wrapper uses org branding (replaces hardcoded ALPHA CRM header)
  - `sendEstimateEmail`, `sendEstimateWithDepositEmail` attach pre-signature PDF
  - `sendEstimateApprovedNotification` attaches post-signature PDF — fires immediately for non-CARD approval; fires from the Stripe webhook on `checkout.session.completed` for CARD (§9.4)
- **Snapshot on send**:
  - Modify `POST /api/estimates/:id/send` controller to copy `organization.estimate_{terms,notes,payment_terms}` into `estimate.snapshot_{...}` at the DRAFT → SENT transition (same transaction that sets `status = SENT` and `sent_at = now()`)
- **Payment-method change flow** (§9.5):
  - Remove the existing public `POST /api/estimates/:id/public/change-payment-method` endpoint
  - Add authenticated `PATCH /api/estimates/:id/payment-method` endpoint (ADMIN / DISPATCHER / SALES)
  - Frontend: "Change Payment Method" dialog on the estimate detail page
  - Triggers re-send of estimate email with updated PDF
- **Exit criteria**:
  - Sending an estimate to a test customer produces an email with the rebranded HTML wrapper and the PDF attached
  - Clicking the public link shows the rebranded page; customer clicks "Download PDF" (mobile Safari too) and the file downloads rather than fails-to-embed
  - A non-CARD approval triggers a confirmation email with the post-signature PDF immediately
  - A CARD approval waits for Stripe webhook; the confirmation email fires only after the webhook lands
  - Dispatcher changes payment method on a SENT estimate → customer receives a new email with the updated PDF; timeline event logged
  - Attempting to change the payment method from the public page has no control visible (selector removed)

## 11. Testing Strategy

- **Unit (backend)**:
  - PDF builder snapshot tests: build both templates with fixture estimates, hash the PDF binary's textual content layer — snapshot stability signals regressions
  - Markdown parser: table-driven tests covering bullets, bold, numbered lists, edge cases (trailing newlines, mixed list types)
  - `generateEstimatePdf` integration test against a Prisma test estimate + seeded org
- **Unit (frontend)**:
  - Organization settings form: field validation (required fields, URL format, hex color)
  - Logo upload: file-size and MIME-type rejection
- **E2E (Playwright)**:
  - Admin logs in, navigates to `/settings/organization`, updates brand color, saves, opens preview → PDF reflects change
  - Sales user creates estimate, clicks "Preview PDF" → PDF opens in Dialog with correct estimate #
  - Customer opens public estimate link → sees rebranded page + downloads PDF successfully
- **Regression**: existing 605 backend tests must continue passing after schema migration, with zero test-code changes. The DB DEFAULT on `organization_id` routes all unscoped inserts to the seeded Alpha org transparently (see §6.2 rationale)
- **CI migration test** (new GitHub Actions job on every PR that touches `backend/prisma/**` or `backend/src/seed*.ts`):
  1. Spin up a fresh empty Postgres container (via `services:` in the workflow YAML)
  2. Run `npx prisma migrate deploy` — fails the job if any migration errors
  3. Run `npx tsx backend/src/seed-organization.ts` — fails if seed errors
  4. Run a smoke SQL assertion: `SELECT count(*) FROM organizations WHERE id = '00000000-0000-0000-0000-000000000001'` returns 1
  5. Run `npx prisma migrate status` — fails if drift detected between schema.prisma and migration history
  - Purpose: catches ordering bugs (e.g., referencing the Alpha UUID before it's inserted) that work on a pre-existing dev DB but fail on a clean deploy
- **Email attachment size budget**: the post-signature PDF is expected to be 80-300 KB for a typical single-line-item estimate; multi-page estimates with product images can approach 1-2 MB. Resend's per-email payload cap is 40 MB total; we're well under. If a single PDF exceeds 5 MB (suggests runaway image embedding), the send handler logs a Sentry warning and substitutes a "view online" link in place of the attachment. Add a regression test asserting the preview fixture's PDF is under 500 KB.

## 12. Security & Privacy

- **Two distinct PDF routes**, each with its own middleware chain (see §7.3):
  - `GET /api/estimates/:id/pdf` — `authenticate` → `authorize(ADMIN, SALES, DISPATCHER)`
  - `GET /api/estimates/:id/public/pdf?token=...` — `publicReadLimiter` + inline token verification identical to `getPublic`. No shared "dual-auth middleware" is introduced
- **Logo upload** (`POST /api/organization/logo`):
  - MIME-type allowlist: `image/png`, `image/jpeg`, `image/svg+xml`
  - Max 2 MB (enforced in `multer` limits)
  - Filename sanitized, stored as `org-logos/{org_id}/{uuid}.{ext}` in Supabase Storage bucket `org-logos`
  - Bucket policy: **public-read** (so the PDF builder can fetch by URL without a signed-URL round trip); write requires `ADMIN` auth at the API layer
  - SVG-specific risk: SVGs can embed scripts. The backend loads the file as an `<image>` in pdfmake (which rasterizes it via PDFKit — no JS execution). But if we ever render the SVG in the browser via `<img>`, we should serve SVGs with `Content-Security-Policy: default-src 'none'` or convert them to PNG on upload. Deferred decision; current public-read path uses raster consumers
- Settings UI write routes require `ADMIN` role (existing `authorize('ADMIN')` middleware)
- Markdown parser: input is rendered to pdfmake AST nodes, not HTML — no XSS surface. Raw HTML tags are stripped defensively before parsing

## 13. Performance

- PDF generation is synchronous and CPU-bound. At 200-500ms per PDF, single-container Node handles ~5-10 concurrent requests comfortably.
- No caching for MVP; if a single estimate PDF starts being requested >100×/day, we can cache generated PDFs in Supabase Storage keyed by `estimate.updated_at`.
- Font files loaded into memory once per process (not per request).

## 14. Open Questions & Risks

Open items (user input needed before Phase 3):

1. **Brand color**: the `#E11D2E` seed value is a best-effort guess. Confirm against Alpha's brand guide or the logo file before Phase 3 ships.
2. **Logo asset**: need the Alpha logo as vector (SVG preferred) or high-res PNG (≥1200px wide) to avoid pixelation in PDF. Blocks Phase 3 visual sign-off.

Resolved (answered in spec above — listed here for traceability):

3. **Signature block in PDF**: ✅ Both templates render a conditional signature block on the last page when `estimate.signature_data` is present. Pre-signature PDFs (send email) omit it; post-signature PDFs (approval confirmation) include it. See §9.4.
4. **Migration vs seed**: ✅ Structural migration creates schema + inserts Alpha row stub; separate `seed-organization.ts` script populates text copy. See §6.3.
5. **`AppSetting` vs `Organization` overlap**: ✅ `AppSetting` retains platform-scoped keys (e.g., global cron, feature flags). `Organization` owns per-tenant branding/copy. No current AppSetting keys conflict — audit confirmed during Phase 1.
6. **Logo storage specifics**: ✅ See §12 — bucket `org-logos`, public-read, path `{org_id}/{uuid}.{ext}`.

Ongoing risks (tracked, not blocking):

7. **Tax rate presentation**: Workiz renders "Tax $62.87 (6.625%)"; our `estimate.tax_rate` is a decimal (e.g., 0.06625). Builder formats as `(${(rate * 100).toFixed(3)}%)` — trailing zeros may look off (e.g., 0.08 → "8.000%"). Phase 2 implementer to decide between `.toFixed(3)` vs `.toString()` stripping.
8. **Long-term scoping enforcement**: once tenant #2 arrives, every `findMany` / `findUnique` needs `where: { organization_id: req.user.organization_id }`. Large workstream — tracked separately, out of scope here.
9. **pdfmake image + tall-row interaction**: known quirk (see §7.1). If the `alpha-classic` template's product-image column triggers awkward breaks on long line items during Phase 2, fallback is to omit images from that template (keep them `crm-default`-only).

## 15. Related Work

- Vault: `Ideas/MVP-Estimate-Template-Alpha-Security.md` (motivation)
- Vault: `Modules/Estimates.md` (current module state — to be updated post-implementation)
- Vault: `Architecture/Email-System.md` (email wrapper changes)
- Plans to follow this spec: `md_files/plans/estimates/` (implementation plan, to be authored after spec approval)
- Invoice PDFs: follow-up spec, same pattern applied to invoices (`md_files/specs/invoices/` TBD)
