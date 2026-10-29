# Dropdowns - the 10-option rule

**Status:** IN PROGRESS - branch `feat/dropdown-search-threshold`
**Measured against:** `origin/staging` @ `ca2ea0a02` (re-measured 2026-08-28; the first pass
used a checkout 1001 commits stale)
**Convention:** `frontend/DESIGN_SYSTEM.md` §4.2, catalog rows in §4, checklist lines in §7
**Origin:** owner found unusable pickers in inventory (vendor / category / item /
receive-into-location), then set the rule after two rounds of narrowing.

## The rule

> **10 or more options -> combobox. Fewer than 10 -> plain select.**
> Nothing else is considered. Not whether the list is hardcoded, not whether a user can add to
> it, not which module it lives in.

Job types are a fixed enum of thirteen and get search. Customer type is two and does not. A
vendor list is hardcoded in one place *and* editable in settings, and the rule does not have to
care which - only how many. (Payment methods were the owner's worked example for `>= 10`, but
they turn out to hold **nine** values and therefore stay a plain select - see "Corrections".)

**The call site declares nothing.** `SelectField` receives options as a flat
`{ value, label }[]`, reads `options.length`, and picks the branch. Three consequences, and
they are the point:

1. **Retroactive** - every existing dropdown obeys the rule the moment the primitive does.
2. **Automatic over data** - a vendor picker is a plain select at six vendors and a combobox at
   sixty. Same code, same day, no prediction of the customer's data.
3. **Automatic over time** - a fixed list of three that grows to ten becomes a combobox on the
   commit that adds the tenth option. No follow-up ticket, no audit, nothing to remember.

Point 3 is the owner's explicit requirement and it is the reason the rule lives in the
primitive rather than in a per-site prop or in a reviewer's head.

## The measurement

`frontend/src` on `origin/staging` @ `ca2ea0a02`, 2026-08-28, excluding `__tests__`, `.stories.`
and `components/ui/`.

> **Re-measured 2026-08-28.** The first pass was run against a working checkout that sat **1001
> commits behind `origin/staging`** and predated the whole `pages/v2/**` and `ui-kit/**` trees.
> Every count below replaces one that was wrong. Two premises died with it - see "Corrections".

### How the app renders a dropdown today

| Path | Files | Sites | Sees the rule? |
|---|---:|---:|---|
| `form/SelectField` (flat options array) | 56 | **100** | **Yes - once step 2 lands** |
| Raw `<Select><SelectContent>` composition | 74 | 117 blocks | No - count is invisible |
| Native `<select>` | 2 | 2 | No - outside the design system |
| Hand-rolled Popover + Input + filter | 15 | 15 | Already searchable, bespoke |

`pages/v2/settings/components/selectField.tsx` is a **second, unrelated component also called
`SelectField`** - a v2-local adapter over `ui-kit`'s select, with an identical `options` prop and
7 call sites. It does not import the design-system primitive, so the rule does not reach it. A
naive grep counts its sites as ours; it is handled in step 4.

### What the 100 `SelectField` sites do under the rule

| | Sites | Behaviour |
|---|---:|---|
| Statically countable, `>= 10` | **6** | Flip on step 2 - but only **2 are on a routed page** |
| Runtime-determined (customer data) | **51** | Flip per-org, whenever that org holds 10+ |
| Statically countable, `< 10` | **43** | Stay plain. Convert automatically if they grow |

**The 6 that flip immediately:**

| Options | Source | Site | Routed? |
|---:|---|---|---|
| 10 | 1 sentinel + `PAYMENT_METHOD_ORDER` (9) | `components/invoices/RefundInvoiceDialog.tsx:189` | **LIVE** |
| 10 | 1 sentinel + `PAYMENT_METHOD_ORDER` (9) | `components/invoices/CreditInvoiceDialog.tsx:238` | **LIVE** |
| 14 | 1 sentinel + `JOB_TYPES` (13) | `pages/reports/JobStatisticsReport.tsx:609` | DEAD |
| 14 | idem | `pages/reports/JobStatisticsReport.tsx:732` | DEAD |
| 14 | idem | `pages/reports/JobStatisticsReport.tsx:793` | DEAD |
| 10 | 1 sentinel + `JOB_TYPES` (9 distinct) | `pages/reports/JobProfitabilityReport.tsx:149` | DEAD |

The four report sites are on **dead v1 pages**. Their live v2 twins hand-compose their `<Select>`,
so they are invisible to the rule and are step-4 work, not step-2 work:
`pages/v2/reports/reports/JobStatisticsReport.tsx:429` (14) and
`pages/v2/reports/reports/JobProfitabilityReport.tsx:183` (10).

**Near-misses at 9.** One added option flips each: `form/DateRangeField.tsx:50`,
`invoices/RecordPaymentDialog.tsx:370`, `estimates/RecordEstimatePaymentDialog.tsx:201`. That is
consequence 3 working, and it is worth watching rather than pre-empting.

### Corrections that change the brief

1. **Payment methods are 9, not 10.** `lib/payment-methods.ts:21` `PAYMENT_METHOD_ORDER` holds
   nine values. The owner moved the threshold from `> 10` to `>= 10` on 2026-08-28 specifically
   so payment methods would be searchable - but at nine they sit below **either** threshold. The
   two payment sites that do flip reach ten only by prepending an "all methods" filter sentinel;
   the payment-method **picker** proper (`RecordPaymentDialog`,
   `RecordEstimatePaymentDialog`) stays a plain select. **Making payment methods searchable
   requires a threshold of 9, which is an owner decision this spec does not take.** The rule as
   written and as built is `>= 10`.
2. **`MultiAssigneeSelect` is not a combobox.** It is a Radix `Select` with grouping and chips
   and has **no search input at all**. Step 6's premise was wrong; see step 6.

### The other bypasses

**117 hand-composed blocks / 74 files.** 99 blocks in 66 files map over data - the rule cannot
see them. **11 of those files are dead v1**, leaving **55 live files** as real step-4 work. The
remaining 18 blocks in 14 files are literal lists; **every one holds 2 to 4 items**, so there is
no hidden violation among them and they stay as they are.

**Native `<select>`: two, both live** - `crm/InternalCostsCard.tsx:144` (2 static options) and
`inventory/assets/AssetActionDialog.tsx:186` (mapped over `pickableUsers`). Three comments
elsewhere claim a native select that was already converted; they are stale and should go when
those files are touched.

**No backend work.** Every list a `SelectField` renders arrives as a materialised client array.
Client-side filtering is sufficient and no API contract changes. The **remote** pickers are a
separate tier this spec does not build - see step 6.

## Mechanics that make this safe

**Radix Select cannot host a text input.** It owns focus and ships single-keystroke typeahead.
A library constraint, not a preference, and it decides the architecture: the searchable branch
is a sibling primitive, `select.tsx` is not modified, and every existing `<Select>` render stays
byte-identical.

**The composition is already proven here.** `crm/AssigneeSelect.tsx` is Popover + Input +
`useMemo` filter + grouped results, in production, 115 lines. `MultiAssigneeSelect` and
`StoreAddressSearch` are two more variants. The primitive consolidates a shape that works; it
should be small.

**The switch is additive.** `SelectField`'s public props do not change - `searchable` is added
as optional. A 4-option site renders exactly what it renders today.

---

## Steps

### Step 1 - `components/ui/combobox.tsx`

Build the searchable branch. Popover + Input + listbox, 6px + tokens per §4, modelled on
`AssigneeSelect`.

Props:

| Prop | Meaning |
|---|---|
| `value`, `onValueChange`, `options`, `placeholder`, `disabled`, `className`, `id` | Mirror `SelectField` so step 2 is a swap, not a rewrite |
| `searchFields?: (o) => string[]` | Fields matched against the query. Defaults to `[o.label]` |
| `emptyText?: string` | Named empty state. Defaults to `No results for "<query>"` |
| `onCreate?: (query) => void` | Renders `+ Create "<query>"` on no-match |

Behaviour, all of it required by §4.2:

- Query matches case-insensitively across `searchFields`. An item must be reachable by
  `241CRL91723001`, `Door Closer`, and `CRL`.
- Input rendered **outside** the scroll container so it cannot scroll away.
- The currently-selected option stays rendered even when the query excludes it.
- Keyboard: focus lands in the input on open; ArrowUp/Down move an active descendant; Enter
  selects; Esc closes and restores focus to the trigger.
- Query resets on close.
- Trigger width drives popover width (`--radix-popover-trigger-width`), as `AssigneeSelect`
  already does.
- a11y: `role="listbox"` / `role="option"`, `aria-activedescendant`, `aria-expanded`.

Tests (`components/ui/__tests__/combobox.test.tsx`): filter narrows; multi-field match; selected
option survives a non-matching query; full keyboard path; empty state renders `emptyText`;
`onCreate` fires with the query and only on no-match.

**Done when:** the primitive exists with tests green. Nothing consumes it yet - the app is
unchanged at this point, which is what makes step 1 safe to land on its own.

### Step 2 - the rule, in `SelectField`

```tsx
const SEARCH_THRESHOLD = 10;                        // §4.2. The only copy.
const useCombobox = searchable ?? options.length >= SEARCH_THRESHOLD;
```

`useCombobox` -> `Combobox`, else the existing `Select` tree unchanged. Add `searchable?: boolean`
as the override; change no other prop.

**This is the commit where the reported problem is fixed**, for the 6 static sites and for all
24 runtime sites at every org that has outgrown ten rows - none of them edited.

Tests (`components/form/__tests__/select-field.test.tsx`): **9** options renders the Radix
Select and its emitted markup is unchanged from today; **10** options renders the Combobox - the
boundary is pinned on both sides, so `>` can never be reintroduced for `>=`; `searchable` forces
each branch against the count. The unchanged-markup assertion is the load-bearing one -
it is what proves 75 sites did not move.

**Done when:** both branches pinned, `npx tsc --noEmit` clean, existing suites green.

### Step 3 - browser verification - DONE 2026-08-28

Driven against a local dev server running this branch (worktree, ports 3050/5220) with a demo-org
QA session injected into `localStorage`. Not against deployed staging, which does not carry this
code yet.

**Verified working - `Issue Credit` -> `Refund method`** (`CreditInvoiceDialog.tsx:238`, exactly
**10** options, the live boundary case that flips only because the rule is `>=` and not `>`):

| Behaviour | Result |
|---|---|
| Search input renders, pinned above the scroll area | PASS |
| Typing filters (`ze` -> Zelle; `bank` -> Bank Transfer (ACH)) | PASS |
| Currently-selected option survives a non-matching query | PASS - the pinned row stayed while `zezzz` matched nothing |
| Named empty state | PASS - `No results for "zezzz"` |
| `aria-activedescendant` tracks ArrowDown | PASS - moved to `option-1` |
| Enter selects the active option; popover closes; trigger updates | PASS |
| Esc closes | PASS |
| Query resets on close | PASS - reopened empty, all 10 rows back |

**Verified NOT changed - `New Customer` -> "How Did They Hear About Us?"** (the source list):
**9** options, rendered as a plain Radix Select with **no search input**. This is the control, and
it is the owner's own worked example: sources are user-editable in settings, and the tenth source
someone adds converts this dropdown with no code change. Consequence 3, observable.

**NOT verified - the four inventory surfaces from the owner's screenshots.** The demo org holds
**zero** price-book / inventory rows ("0 of 0 items"), so the item picker, receive-into-location,
vendor and category pickers cannot be made to show a long list there. Those four are runtime-fed,
and all 412 real inventory rows belong to Alpha Doors, a production org. **They remain unverified
in a browser** and should be checked by the owner against real data, or on a seeded org.

**A claim from step 2 that browser checking disproved:** `components/form/TimeSelect.tsx` (97
options) does flip, but it is imported only by `pages/LeadFormPage.tsx`, a **dead v1 page**. The
routed v2 lead form uses `pages/v2/_shared/timeSelect.tsx`, which hand-composes and so is
invisible to the rule until step 4; the routed job form uses `TimeCombobox`, already searchable.
The 97-option flip reaches no user today. `src/__tests__/TimeSelect.test.tsx` tests the dead
component.

### Step 4 - close the two bypasses

Neither can see the count, so the rule silently does not apply to them.

- **55 live files** hand-composing `<Select>` over mapped data -> convert to `SelectField`.
  Mechanical: the `.map()` inside `<SelectContent>` becomes the `options` array.
- **2 native `<select>`** (`crm/InternalCostsCard.tsx:144`,
  `inventory/assets/AssetActionDialog.tsx:186`) -> `SelectField`. These are outside the design
  system entirely, not merely outside this convention.
- **`pages/v2/settings/components/selectField.tsx`** - the shadow adapter. Either make it
  delegate to the design-system `SelectField` or delete it in favour of the real one. A second
  component with the same name and the same `options` prop that silently does not obey §4.2 is
  the exact drift this spec exists to prevent.
- **Dead v1 files are out of scope** - 11 of the 66 mapped-block files are unrouted. Do not
  migrate or QA them. They should be deleted, but by a separate dead-code pass.
- The 14 literal-block files (2-4 items each) stay as they are.

Regenerate the lists rather than trusting this document, and intersect with the live-module set
before touching anything. The migrate list is every `.tsx` outside `ui/`, `__tests__`,
`.stories.` and `form/SelectField` whose `<SelectContent>...</SelectContent>` body contains
`.map(`; the native list is `grep -rn "<select[ >]" --include="*.tsx"` minus tests.

**Done when:** both lists are empty outside tests and dead v1 files.

### Step 5 - the ratchet

Without it, step 4 is undone by the next person who hand-composes a select. Add to
`src/design-system/__tests__/tokens-guard.test.ts` (or a sibling): fail on a **new** native
`<select>`, and on a **new** `<SelectContent>` containing `.map()`, pinned at the counts step 4
leaves behind (zero and zero).

**Done when:** the guard is green and demonstrably fails when a violation is reintroduced.

### Step 6 - consolidate the hand-rolled comboboxes

**The original premise was wrong and this step is larger than three files.** There are **15**
hand-rolled searchable dropdowns, not 3, and they split into two tiers:

**Client-side tier - in scope.** Filters an array already in memory, which is what `Combobox`
does:
- `crm/AssigneeSelect.tsx` - grouped by department.
- `crm/AssignTeamPopover.tsx` - assignment mutation on pick.
- `customers/BulkTagPopover.tsx` - multi-select, bulk mutation.
- `leads/TagInput.tsx` - multi-select, create-tag, sort toggle.
- `form/TimeCombobox.tsx` + `pages/v2/_shared/timeCombobox.tsx` - free-text parsing over
  generated slots.

**Remote tier - explicitly NOT in scope.** Each debounces a network query rather than filtering a
client array. `Combobox` has no async contract, and giving it one is a separate piece of work
with its own loading, error and abort semantics: `timeclock/StoreAddressSearch.tsx`,
`crm/address-autocomplete.tsx`, `tasks/LinkedEntitySelect.tsx` (+ its v2 twin),
`crm/PickOrCreateCustomer.tsx` (+ `pages/v2/_shared/pickCustomer.tsx`),
`crm/CustomerPickerWithCreate.tsx`, `jobs/items/PriceBookPicker.tsx`,
`inventory/lo/TrackedItemSearch.tsx`.

**`crm/MultiAssigneeSelect.tsx` is not a combobox at all** - a Radix `Select` with grouping and
chips, no search input. Under §4.2 it is a dropdown that should obey the count rule like any
other, and that needs multi-select in the primitive first. Park it.

**Done when:** `AssigneeSelect` consumes `Combobox`, and the other client-side four either follow
or carry a note in §4.2 recording why not. The remote tier gets a line in §4.2 naming it as an
unbuilt async tier, so the next reader does not mistake its existence for a rule violation.

---

## Order of work

**1 -> 2 -> 3** is the shippable unit and the entire user-visible win. 4 -> 5 -> 6 is hygiene
that keeps the rule true, and can land on a follow-up branch. Step 5 must not precede step 4 or
it fails on day one.

## Definition of done

- [ ] `combobox.tsx` exists, with the six tests from step 1 green.
- [ ] `SelectField` applies `options.length >= 10`, with both branches pinned at 9 and 10 and
      the `< 10` branch asserted markup-identical to today.
- [ ] Six surfaces verified in a browser on staging (step 3), including the one that must not
      have changed.
- [ ] Zero `<SelectContent>` blocks containing `.map()` outside `components/ui/` and dead v1.
- [ ] Zero native `<select>` outside tests (2 today, both live).
- [ ] `pages/v2/settings/components/selectField.tsx` either delegates to the design-system
      `SelectField` or is gone.
- [ ] Ratchet green and proven to fail on reintroduction.
- [ ] The threshold appears exactly **once** in the codebase.
- [ ] `DESIGN_SYSTEM.md` §4.2 matches what shipped, including the number if it moved.
- [ ] `npx tsc --noEmit` clean; token guard and `*.reskin.test.ts` green.

## Explicitly out of scope

- **Server-side / async search.** Nothing needs it - every list arrives as a complete array.
- **`select.tsx`.** Untouched, no new props, no behaviour change.
- **Promoting 2-4 option dropdowns to radio groups.** §4.2's guidance for new work, not a
  retrofit; that is a visual-design pass with its own QA.
- **Multi-select.** `MultiAssigneeSelect` keeps its shape until step 6.
- **The 7 literal-block files and the 75 short sites.** Correct as they are.

## Open decision (owner)

**Does `+ Create "<query>"` land in this work or the next?** It is the highest-value half for
vendors / brands / categories - searching and adding become one gesture instead of a trip to
another dialog - but it needs a create mutation per entity type, which is real per-site work
rather than a primitive change. Build the `onCreate` hook in step 1 either way; decide
separately which entities get wired to it.

## Rules of engagement

- The threshold lives in **one** place. A second copy of the number is the drift this spec
  exists to prevent.
- A call site never picks its own branch except through `searchable`, and an override without a
  reason in the PR description is a review failure. Overrides accumulating means the number is
  wrong - change the number, not the sites.
- Do not "fix" a slow dropdown by trimming its options. The list length is the customer's data.
