# Org-owned tax rates with per-rate dropdown visibility

Date: 2026-08-05
Module: settings / estimates / invoices / jobs
Status: approved, in implementation

## Problem

Every tax-rate picker in the app (estimate, invoice, job receipt cards) renders all 52 rows of the
global `state_tax_rates` table plus the org's custom rates. A contractor working two counties in NJ
scrolls past 50 irrelevant states every time. There is also no way for an admin to correct a
national row: the Tax Foundation numbers we seed are *averaged* combined rates, so they are never
the legally exact rate for a given address.

A settings UI for this was partially built (`OrgTaxRatesSection.tsx`) but is **mounted nowhere** -
admins cannot reach it today.

## Decisions (Ran, 2026-08-05)

1. **Storage:** each org gets its own copy of all 52 rows in `org_tax_rates`. The org owns every
   row and may rename, re-rate, hide, or delete any of them. The global `state_tax_rates` table
   becomes seed-source + fallback only.
2. **Default visibility:** on a new org, only the org's home state (`organizations.state`) is
   visible; everything else is seeded hidden.
3. **Auto-derivation ignores visibility.** Hiding a rate is a UI filter only, so hiding a state can
   never silently under-charge tax on an out-of-state job. Derivation *does* respect an org's
   edited **value** - the org's row for a state wins over the global row.
4. **Existing orgs get the same treatment as new ones.** All 52 rows are seeded, but only the org's
   home state is left visible. The other 51 stay in the org's list as hidden rows, so an admin can
   switch one on later without retyping it - nothing is deleted.
5. **A confirmation modal guards implausible rate edits.** Fires when the new value is `> 15%`
   (Louisiana, the national high, is 10.11%) or moves an existing rate by more than 3 percentage
   points. Catches the `66%`-for-`6.6%` decimal slip without nagging an org correcting 6.60% to
   6.625%.

## Current state (verified by reading, not assumed)

| Piece | Where | Status |
|---|---|---|
| `OrgTaxRate` model | `schema.prisma:1439` | exists - `name`, `rate` only |
| CRUD API | `controllers/org-tax-rate.controller.ts` | exists - list/create/update/remove, tenant-scoped, audited |
| Picker feed | `controllers/state-tax-rate.controller.ts` | merges 52 global + org customs as `CUSTOM-<id>` |
| Picker UI | `components/jobs/items/ReceiptCard.tsx:552` | renders every row; has `Custom rate (X%)` fallback + `+ Add tax rate` |
| Settings UI | `components/settings/OrgTaxRatesSection.tsx` | built, **not mounted** |
| Derivation | `estimate.controller.ts:859,874` · `invoice.controller.ts:185` · `service-plan.controller.ts:487` | 4 sites, all `stateTaxRate.findFirst({ state_code })` |
| Seed source | `backend/src/seed-tax-rates.ts` (52 rows) | lockstep with `migrations/20260804120000_state_tax_rates_2026` |
| Org creation | `lib/entitlements/ops-sql.ts:110` `buildCreateOrgSql` | takes `state` - gives us the home state |

Staging data: 6 orgs, all with 2-letter `state` values. Alpha Doors already holds 2 hand-made custom
rates (`New York - Workiz`, `Workiz - New Jersey`) - these must survive the backfill **visible**.

## Design

### 1. Schema (`OrgTaxRate`)

```prisma
state_code String? @db.VarChar(2)  // provenance of a seeded row; NULL for hand-made rates
is_visible Boolean @default(true)  // show in the estimate/invoice/job pickers
```

Plus a partial unique index on `(organization_id, state_code) WHERE state_code IS NOT NULL` - one
seeded row per state per org, unlimited hand-made rows, and an idempotent backfill.

No `is_default` - not asked for, and rule 3 says smallest change that works.

### 2. Migration (portable + idempotent, per `writing-migrations`)

1. `ADD COLUMN state_code`, `ADD COLUMN is_visible NOT NULL DEFAULT true` (existing custom rows
   therefore stay visible, which is what Alpha Doors needs).
2. Partial unique index as above.
3. Backfill `organizations CROSS JOIN state_tax_rates`, `ON CONFLICT DO NOTHING`, with
   `is_visible = (s.state_code = upper(trim(o.state)) OR lower(s.state_name) = lower(trim(o.state)))`
   - the second arm because `organizations.state` is `VarChar(50)` and may one day hold a full name.

**Behavior change for existing orgs:** they go from seeing 52 rows to seeing 1 (decision 4). That is
the point of the change, but it is a live-data change and must be called out in the PR body.

### 3. Backend

- New shared helper `lib/tax/resolveTaxRate.ts` so the org-first lookup exists once rather than
  four times.
- `GET /api/state-tax-rates` (the picker feed) returns the org's rows `WHERE is_visible`, same
  `{state_code, state_name, tax_rate}` shape. Seeded rows keep their real code; customs keep
  `CUSTOM-<id>`. **Falls back to the global 52** when the org has zero rows, so an un-backfilled org
  never gets an empty picker.
- `GET /api/org-tax-rates` (the settings feed) returns *all* rows, hidden included.
- `PATCH /api/org-tax-rates/:id` gains `is_visible` in `updateOrgTaxRateSchema`.
- The 4 derivation sites call the new helper. `is_visible` is deliberately **not** in its `where`
  (decision 3).
- `buildCreateOrgSql` gains a statement seeding the 52 rows for the new org with only the home
  state visible.

### 4. Frontend

- New **Settings -> Tax Rates** page (`settings/tax-rates`, ADVANCED group, gated
  `update Organization` like the other list pages). A dedicated page rather than a section on
  Payments & Lists, because 52 rows will not sit politely inside a card.
- Rework `OrgTaxRatesSection` into that page: search box, table of Name | Rate | Show in dropdown
  (Switch) | delete, inline edit as today, "Add tax rate" row. Design tokens only - no raw hex.
- `ConfirmRateChangeDialog` per decision 5, wrapping both the inline edit commit and
  `AddTaxRateDialog`'s save. Shows old -> new; cancelling reverts the field rather than committing.
- **The pickers need no change.** They already render whatever the endpoint returns, and already
  render an unmatched stored rate as `Custom rate (X%)`, which is exactly what a hidden-but-applied
  rate should look like.

## Implementation order

Backend is TDD - failing test first, then implement (CLAUDE.md rule 6).

1. `schema.prisma` + migration SQL.
2. `lib/tax/resolveTaxRate.ts` + tests.
3. `org-tax-rate.controller.ts` - `is_visible` on PATCH.
4. `state-tax-rate.controller.ts` - visible-only + fallback.
5. The 4 derivation call sites move onto the helper.
6. `ops-sql.ts` `buildCreateOrgSql` + test.
7. `lib/api/org-tax-rates.ts` - `is_visible` on the type and the PATCH body.
8. `ConfirmRateChangeDialog.tsx`.
9. `OrgTaxRatesSection.tsx` rework -> `TaxRatesPage.tsx`, nav entry, route.
10. `npx tsc --noEmit` + `npm test --workspace=backend`, then PR into `staging`.

## Tests

- `org-tax-rates.test.ts`: PATCH toggles `is_visible`; list returns hidden rows too.
- `state-tax-rate` list: only visible org rows; global fallback when the org has none.
- `resolveTaxRate`: org row beats global row; a **hidden** org row is still used for derivation.
- `ops-sql`: `buildCreateOrgSql` emits the seed insert with only the home state visible.
- Frontend: settings page toggle round-trip; confirm modal thresholds.

## Out of scope

- Address/ZIP-level tax lookup (Avalara-style). Still a manual per-org list.
- A "default tax rate" concept for new documents.
- Promotion to `main` - staging first, per the standing flow.

## Known edge

An org whose `state` is blank ends up with all 52 hidden. The picker still offers "No tax" and
"+ Add tax rate", and any already-applied rate renders as `Custom rate (X%)`, so nothing breaks -
but the first-run experience is thin. No staging org is in this state today.
