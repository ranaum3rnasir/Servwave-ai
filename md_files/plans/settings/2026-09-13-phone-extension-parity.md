# SRVW-54 - phone extension parity across Vendor, Branch, Location, Organization, Customer quick-create

**Branch:** `fix/srvw-54-phone-extension-fields` (off `staging`) · **Linear:** SRVW-54 · **GitHub:** ranro1/ALPHA_CRM#938

## Problem

`User.phone_ext` and the full `Customer` form already pair every phone with an optional extension.
Five other phone inputs do not, so whether you can record "ext. 204" depends on which screen you
happen to be on.

## Scope

Five schema columns, all nullable, all plain `String?` to match the `User.phone_ext` reference the
ticket names:

| Model | Column |
|---|---|
| `Vendor` | `contact_phone_ext` |
| `VendorContact` | `phone_ext` |
| `Branch` | `phone_ext` |
| `Location` | `phone_ext` |
| `Organization` | `phone_ext` |

Plus the UI-only gap: the inline customer quick-create used in Lead/Job/Invoice forms never
rendered the extension input, even though `Customer.phone_ext` has existed all along.

## Findings that changed the plan

The ticket's file paths point at the legacy tree. Routing (`pages/v2/routes/settings.routes.tsx`)
says the live pages are the `v2/` copies, so the edits landed there:

- `pages/v2/settings/CompanyProfilePage.tsx`, `pages/v2/settings/LocationsPage.tsx` (live)
- `pages/settings/*` (unrouted legacy - deliberately untouched)

The quick-create component already had the Ext input, behind a `showPhoneExt` prop. Only the Lead
form passed it. So the real fix was enabling it at the two call sites that did not, which needed:

- `v2/jobs/JobFormPage.tsx` - an RHF field, hydration on customer select, and `phone_ext` in the
  create payload. The job backend's `newCustomerSchema` had no `phone_ext` either (lead's did), so
  the column would have been silently dropped; that schema gained the field.
- `v2/invoices/StandaloneInvoiceFormPage.tsx` - contact state + the `/api/customers` create body.
  That endpoint already accepted `phone_ext`.

## Changes

**Backend** - `schema.prisma` (5 columns), migration `20260913120000_phone_extension_parity`
(idempotent `ADD COLUMN IF NOT EXISTS`, plain ANSI so CI's vanilla Postgres runs it),
`inv-vendors.controller.ts` (zod x2, DTO, data mapper, create path, both contact write paths),
`inv-locations.controller.ts` (branch zod x2, mapper, create, update), `location.controller.ts`
(zod x2), `organization.controller.ts` (select + zod), `job.controller.ts` (`newCustomerSchema`).

**Frontend** - `AddVendorDialog`, `VendorDetailDialog` (edit + read views), `AddBranchDialog`,
`v2/settings/LocationsPage`, `v2/settings/CompanyProfilePage`, `v2/jobs/JobFormPage`,
`v2/invoices/StandaloneInvoiceFormPage`, plus the types in `lib/api/organization.ts`,
`lib/api/locations.ts`, `lib/api/inventory.ts` and `lib/api/_mock/inventory/inventory.ts`.

**Tests** - `backend/src/__tests__/phone-extension-parity.test.ts`, 7 cases: the extension reaches
Prisma on each entity's write path, it is emitted on the vendor DTO, and a create with no
extension is still valid.

## Verification

- `npx vitest run src/__tests__/phone-extension-parity.test.ts` - 7/7 (failing first, per TDD)
- `npx tsc --noEmit` (frontend) - clean
- Full backend suite - see the PR body

## Not done

Nothing in scope was left out. The legacy `pages/settings/*` duplicates were deliberately not
edited: they are unrouted, kept only for test imports, and editing them would imply they are live.
