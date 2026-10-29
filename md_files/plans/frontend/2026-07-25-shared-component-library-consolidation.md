# Shared Component Library Consolidation (Phases 0-7)

> **STATUS 2026-07-25 (updated)** - branch `refactor/shared-component-library`
> (worktree `../alpha_crm-worktrees/shared-components`, cut from `origin/staging`).
>
> | Phase | State |
> |---|---|
> | 0 Foundations + guardrails | **DONE** - `63cdb42dd` |
> | 1 Reshape into buckets | **DONE** - `d757bd5b0` |
> | 2 Dedupe hooks/utils, token drift guard | **DONE** - `231b1d96f` |
> | 3a Hoist shared Modal · 3b Tier-1 buttons | **DONE** - `2fb00ac87` |
> | 3c Raw-`<button>` lint guardrail | folded into 7.1, see below |
> | 7 Guardrails (7.1/7.2/7.3/7.6) | **DONE** - `fe88566a5` |
> | 6 step 1 Token compliance, `components/ui` only | **DONE** - `13985acf5` (66 originally cited -> **30 real sites**, see 6a correction) |
> | 4b/4c Selection primitives (ToggleGroup, Switch dedup) | **DONE** - `82a25b150` |
> | 4d Triage worksheet (no conversions) | **DONE** - see `2026-07-25-toggle-group-triage-worksheet.md`; 0 of 101 candidate sites converted |
> | 5b Report scaffolding hoist | **DONE** - `6cd6c0f92` |
> | 6 step 2 (`crm`/`layout`/`data` tokens) | **NOT DONE** - deliberately deferred, see 6a |
> | 5c Button tail (191-singleton tier) | **NOT DONE** - deliberately not bulk-converted, per plan |
>
> Tree state after Phases 4/5b/6-step1/7: `tsc` 0 errors · 324 test files / 2562 tests pass (7 pre-existing
> skips) · build clean · 0 stale references to `components/common`, `components/shared`, or a bypass import
> of the deleted `phone/shared.tsx` `Toggle`.
>
> **6a - correction to this plan's own Phase 6 figures.** The "66 violations in components/ui" cited below
> was inflated by the same regex bug the plan already flagged once (dark: exclusion done wrong). A corrected
> recount - full color-family list, only a literal leading `dark:` tolerated - found **30** real light-mode
> sites across 11 files, not 66; all 30 are now fixed. The same recount on `crm`/`layout`/`data` mostly held
> (54/23/1 vs the 54/18/1 cited), but those files turned out to be **semantic multi-category color-coding**
> (status/file-type badges, a WhatsApp-brand hex) rather than shadcn-default chrome - collapsing them onto
> existing tokens risks losing a real visual distinction between categories. That needs a token-design
> decision before it's mechanical, so it was deliberately left out of this pass rather than guessed at.

**Date:** 2026-07-25
**Scope:** `frontend/src` only. No backend, no schema, no API changes.

---

## 1. The end goal, stated as testable invariants

The goal is not "tidier folders". It is that **the component layer has one home, one
implementation per concept, and no hardcoded values inside it** - so that changing a
shared component changes the whole app, and nothing quietly overrides it.

That decomposes into five invariants. Each is machine-checkable, and Phase 7 turns each
into a test so it cannot regress:

| # | Invariant | Checked by | Status now |
|---|---|---|---|
| I1 | Every shared component resolves from exactly one path under `src/components/` | no `common/`/`shared/` dirs; no re-export shims | **HELD** (Phase 1) |
| I2 | No concept has two implementations (one shared, one local) | shadow-component fence (Phase 7) | partially - Phase 4 closes the known ones |
| I3 | No shared component hardcodes a design value | token guard, widened (Phase 6/7) | 66 light-mode violations in `components/ui` |
| I4 | Interactive elements go through a primitive, not raw markup | raw-`<button>` lint rule (Phase 7) | 936 raw `<button>` remain |
| I5 | The propagation path itself is single-sourced | `@/*` alias in tsconfig + vite + vitest | **HELD** (pre-existing) |

**I5 already held before this work started** - the `@/*` alias is declared identically in
`tsconfig.json`, `vite.config.ts:48-52` and `vitest.config.ts:6-10`, ~82% of imports
already used it, and there was never a duplicated Button/Card/Input/Dialog. The problem
was never wiring. It is I1-I4: organization, shadowing, hardcoding, and bypass.

---

## 2. Target structure

Feature folders (`jobs/`, `inventory/`, `estimates/`, ...) and `pages/` are the
application on top of the library and stay where they are.

```
src/components/
├── ui/        primitives ONLY          <- Phase 4 adds toggle-group
├── form/      form controls            (Phase 1)
├── data/      tables, stat widgets     (Phase 1)
├── crm/       domain composites        (Phase 1)
├── layout/    app chrome
├── charts/    chart primitives
├── filters/   filter surfaces
├── brand/
└── <feature>/ unchanged
```

`common/` and `shared/` are deleted. **No re-export shims at old paths** - a shim leaves
two valid import paths for one component, which is the exact ambiguity this work removes.
Barrels are additive (`form/`, `data/`, `crm/`, `filters/`, `charts/`); deep imports stay
the convention and `ui/` deliberately has no mega-barrel (it would pull the whole Radix
graph into every primitive import).

---

## 3. Phases 0-3 (done) - what landed

Condensed; full rationale in git history.

- **0** - Restored `frontend/eslint.config.js`. **`npm run lint` had never worked**: ESLint 9
  was installed with no flat config anywhere, so `eslint .` exited 2 on every run. Deleted
  3 files with zero importers (`common/CustomerSelect.tsx`, `ui/loader.tsx`, `ui/form.tsx`).
  Added the `filters/` barrel.
- **1** - 31 files moved by `git mv` (all preserved as renames), 223 import specifiers
  rewritten across 141 files, `common/` and `shared/` deleted, barrels added. Hardened
  `tokens-guard.test.ts`, which had been passing **vacuously** on stale paths - it compared
  strings without checking the files existed. Now it asserts existence.
- **2** - Three real single-source violations, each diffed before acting (same name is not
  the same code):
  - `useIsMobile` duplicate caused a **first-paint desktop flash** - a behaviour bug.
  - phone's `fmtMoney` **ignored the org's configured currency** (hardcoded `$`).
  - `withinRange` byte-identical in two report modules.
  - Added `tokens-fallback-drift.test.ts`, verified to **fail on a one-digit mutation**
    rather than pass vacuously.
  - `pages/reports/expenses-logic.ts` deliberately **keeps** its local `withinRange`: its
    header documents it as dependency-free so it stays mirror-able to a backend service.
    Documented rather than mechanically deduped.
- **3a** - `Modal` hoisted from `components/inventory/InventoryModal.tsx` to
  `components/ui/modal.tsx`; 32 importers repointed. Nothing about it was inventory-specific.
- **3b Tier 1** - 88 raw `<button>` across 37 files converted to `<Button>`. Deliberate
  design-system alignment: radius 6px->14px, height 34->36px, weight 500->600, verified
  in-browser against `/design-system`.

---

## 4. Phase 4 - Selection primitives (follow-up B)

**Problem:** 210 sites style a "selected" state by hand with a conditional className.
**170 of them carry no `aria-pressed` / `role="tab"` / `aria-selected` at all** - they look
selected and announce nothing to a screen reader. That is a real accessibility defect, and
it is the strongest argument for this phase; the tidiness is secondary.

### 4a. Correction to the earlier report

Two claims in the original side-findings were wrong and are retracted:

1. **"The 224 chip/tab sites have no shared component."** `components/ui/tabs.tsx` **does**
   exist (Radix, underline style, 18 files use it). What is genuinely missing is a
   **ToggleGroup** - the segmented / pill-selector case. Tabs is not a substitute.
2. **"Possible latent bug: `variant="block"`, `size="xl"` passed to Button."** **False alarm.**
   Every `size="xl"` is `<Modal size="xl">` - a valid `ModalProps` size. `variant="block"`
   is on `<AddStepButton>`, a local component with its own variant vocabulary. Nothing
   renders unstyled. No ticket needed.

### 4b. Real duplicate: hand-rolled `Toggle` vs `ui/switch.tsx`

`components/communication/phone/shared.tsx:289` exports a `Toggle` that is a hand-rolled
copy of the existing `ui/switch.tsx`. Both are `h-6 w-11` pill switches. The local one is
strictly worse:

| | `ui/switch.tsx` | local `Toggle` |
|---|---|---|
| base | Radix `SwitchPrimitives` | raw `<button role="switch">` |
| radius | `rounded-pill` (token) | `rounded-full` (raw Tailwind) |
| focus ring | yes | **none** |
| disabled state | yes | **none** |
| unchecked border | yes | none |

**Action:** delete the local `Toggle`, repoint its ~7 call sites
(`CallMaskingView.tsx:371,482`, `TextingView.tsx:667,1025,1089,1107`, and any others found
by grep) to `<Switch checked=… onCheckedChange=… />`. Note the **prop rename**:
`on`/`onChange` -> `checked`/`onCheckedChange`, and `ariaLabel` -> `aria-label`.
This is a straight I2 fix - one concept, one implementation.

### 4c. New primitive: `components/ui/toggle-group.tsx`

**Dependency:** `@radix-ui/react-toggle-group` is **not installed**, not even transitively
(verified against `node_modules/@radix-ui/`). Phase 4 adds it - the first new runtime
dependency in this plan. It is the same Radix major line as the 13 packages already
declared, so no version conflict is expected, but it does mean this phase touches
`package.json` / `package-lock.json` and should say so in its PR.

Two variants covering the two real shapes found in the tree:

```tsx
// segmented  - single-select mode switcher, sits in a bordered track
// pill       - free-standing chips, single or multi select
<ToggleGroup type="single" variant="segmented" value={mode} onValueChange={setMode}>
  <ToggleGroupItem value="email">Email</ToggleGroupItem>
  <ToggleGroupItem value="sms">SMS</ToggleGroupItem>
</ToggleGroup>
```

Radix supplies `data-[state=on]`, roving-focus keyboard nav, and correct ARIA - which is
what fixes the 170 unlabelled sites. Style **only** with tokens (`bg-primary`,
`text-text-secondary`, `rounded-pill`, `border-border`), no raw palette classes, so it
passes the Phase 6/7 guard on day one.

### 4d. Migration scope - triage first, convert second

**Do not trust a blanket number here.** My classifier split the 210 sites into
segmented / multi-toggle / listbox-option / selectable-card, and spot-checking proved the
split unreliable: sites using array-join (`[...].join(' ')`) instead of `cn()` were
misfiled as "bespoke" when they were genuine toggles. The only two figures that survived
scrutiny are:

- **210** sites carry conditional selected-state styling (robust - class-shape check)
- **170** of those have no ARIA state attribute (robust - plain attribute presence)
- **6** are `role="option"` listbox items (robust - explicit attribute)

So Phase 4 **starts with a triage pass**, not a codemod:

1. Script-dump all 210 sites with file:line and tag text into a worksheet.
2. Hand-classify each into: `segmented` · `pill-single` · `pill-multi` · `listbox-option` ·
   `selectable-card` · `leave-alone`.
3. Convert only `segmented` / `pill-single` / `pill-multi`.

**Explicitly out of scope for ToggleGroup:**
- **`role="option"` listbox items** (6+: `crm/AssignTeamPopover.tsx:154`,
  `crm/AssigneeSelect.tsx:92`, `layout/GlobalSearch.tsx:173`,
  `schedule/ScheduleSearch.tsx:150`, `timeclock/StoreAddressSearch.tsx:221`,
  `workflows/trigger/SubjectPicker.tsx:117`). These are combobox options with active-descendant
  keyboard handling. A ToggleGroup here would be **semantically wrong** and would break the
  comboboxes.
- **Selectable cards** (`settings/TemplateSelector.tsx:64`,
  `estimate-workspace/AiImagePanel.tsx:86`, `inventory/AddLocationDialog.tsx:270`, ...) -
  card-shaped radio selection. If a primitive is wanted, it is a `RadioCard`, tracked
  separately. Not this phase.

### 4e. Acceptance

- Local `Toggle` deleted; `grep -rn "from.*phone/shared'" | grep Toggle` returns nothing.
- `toggle-group.tsx` exists, styled with tokens only, exported from `ui/`.
- Every converted site announces state (`data-state` / `aria-pressed` present in the DOM).
- Converted screens visually checked in-browser, not just typechecked.

---

## 5. Phase 5 - Button tail (follow-up A)

### 5a. The measurement that reframes this phase

After Phase 3, **936 raw `<button>` remain** (excluding `pages/prototype/**`,
`pages/design-system/**`, and tests), across 227 files. Of these, **309 are colour-matching
convert candidates**. But:

```
309 sites  ->  233 distinct className signatures  ->  191 are singletons (1 occurrence)

signatures appearing >=6x cover   18 sites  ( 6%)
signatures appearing >=4x cover   43 sites  (14%)
signatures appearing >=3x cover   70 sites  (23%)
signatures appearing >=2x cover  118 sites  (38%)
```

**This is the decisive finding for Phase 5.** Tier 1 worked because 88 sites collapsed into
**3** signatures - one codemod, mechanically verifiable. The tail is the opposite: the
largest remaining cluster is **6 sites**, and 62% are one-offs. There is no codemod here.
"Convert the remaining ~225" would be **191 individual design judgements**, each carrying a
radius/height shift, each needing its own visual check.

**Recommendation: do 5b, then stop and reassess. Do not do 5c as a bulk exercise.**

### 5b. Tier 2 - hoist the duplicated report scaffolding (do this)

This is the high-value half, and it is a **deduplication** task that happens to remove
buttons, not a button task.

The `pages/reports/*` files are near-verbatim copies of the same toolbar / MultiSelect /
FieldsModal / pagination markup. The census shows it directly - identical signatures
recurring across sibling report files:

| Signature | Sites | Files |
|---|---|---|
| `h-10 … rounded-lg` toolbar button | 6 | `JobsReport`, `LeadsReport`, `SalesReport` |
| `px-3 py-1.5 rounded-md disabled:opacity-40` pager | 6 | `JobsReport`, `LeadsReport`, ... |
| `h-9 … rounded-md` toolbar button | 5 | `ArAgingReport`, `InvoicesReport`, `JobProfitabilityReport` |
| `px-2.5 py-1 rounded-md` pager | 4 | `InvoicesReport`, `PaymentsReport` |
| `h-11 … justify-between` select trigger | 3 | `JobsReport`, `LeadsReport`, `SalesReport` |
| `rounded-full px-5 py-2` primary | 3 | `JobsReport`, `LeadsReport`, `SalesReport` |

`pages/reports/_shared.tsx` **already exists** and already holds 6 such helpers - the
pattern is established, it just was not finished.

**Steps:**
1. Diff the toolbar/pagination blocks across the 25 `pages/reports/*` files; confirm they
   are genuinely identical before merging (same discipline as Phase 2 - same markup is not
   automatically same behaviour; watch for per-report column sets and disabled logic).
2. Hoist each confirmed-identical block into `_shared.tsx` as `<ReportToolbar>`,
   `<ReportPager>`, `<ReportSelectTrigger>`.
3. Convert the buttons **once, inside the hoisted component**.
4. Replace the 25 copies with the shared component.

**Payoff:** ~27 button sites collapse to ~4 definitions, and the next report page written
inherits them for free. This directly serves I1/I2.

### 5c. Tier 3 - the 191-singleton tail (recommend: do not bulk-convert)

If it is done anyway, do it **per-screen, never repo-wide**: pick one feature area, convert
its buttons, visually verify that screen, ship it, repeat. Bulk-converting 191 one-offs in
a single PR is unreviewable and the visual risk compounds silently.

The regression fence in Phase 7 means the tail **stops growing** even if it is never fully
drained - which is the pragmatic end state. New code is forced through `<Button>`; legacy
sites get converted when their screen is next touched.

### 5d. Never convert (unchanged from the original census)

- **`asChild` / ref-forwarding triggers** (9): `layout/Sidebar.tsx:115,122` nests
  `DropdownMenuTrigger asChild` inside `TooltipTrigger asChild` - double ref forwarding,
  the highest-risk conversion in the repo.
- **Invisible click-outside catchers** (`fixed inset-0 z-40`, 8 of them, e.g.
  `communication/phone/NumbersView.tsx:116`).
- **dnd-kit drag handles** (`workflows/StepNode.tsx:104`).
- **Icon buttons** (99): `size="icon"` is 40x40; these are `p-1` (~24x24), so each needs an
  explicit `h-7 w-7` override that erodes the benefit. Selective only.
- **Link-like buttons** (69).

---

## 6. Phase 6 - Token compliance inside the shared layer

This is the "no more hardcoding" half of the goal, and it is **the largest single gap left**.
CLAUDE.md and `frontend/DESIGN_SYSTEM.md` both forbid a raw hex or raw Tailwind palette
class in a component. Measured on the current tree:

```
882  light-mode raw palette classes  (bg|text|border|ring)-{gray,slate,red,blue,...}-N
 38  dark: variants                  (deferred by existing guard policy - not counted)
 89  raw #hex values in .tsx
```

Broken down by area:

| Area | Light-mode violations |
|---|---:|
| `pages/**` | 491 |
| **`components/ui/**`** | **66** |
| `components/crm/**` | 54 |
| `components/layout/**` | 18 |
| `components/data/**` | 1 |
| `components/form/`, `components/charts/`, `features/` | **0** |

**The important row is `components/ui`: 66.** These are *the* shared primitives - the
"general components" every feature imports. Hardcoded values inside them are the most
concentrated form of the problem the whole plan exists to fix. The existing
`tokens-guard.test.ts` only fences an allowlist of 4 ui files (`button`, `badge`, `card`,
`tabs`) plus `data/`, so `dropdown-menu.tsx` (28), `select.tsx` (14), `dialog.tsx` (10),
`sheet.tsx` (9), `checkbox.tsx` (7), `tooltip`/`toast`/`popover` (5 each) sit outside it.

### Execution order - inside-out, guard-as-you-go

1. **`components/ui/**` -> 0** (66 sites). Map each palette class to its token
   (`gray-200`->`border-border`, `slate-500`->`text-text-secondary`, ...). These are
   shadcn defaults that were never reskinned. Add each file to `MIGRATED_UI` in
   `tokens-guard.test.ts` **as it is cleaned**, so it can never regress.
2. **`components/crm/**` (54) + `components/layout/**` (18) + `components/data/**` (1)**,
   same method, extending the guard to whole directories once clean.
3. **`pages/**` (491)** - explicitly **out of scope for this plan**. Pages are the
   application, not the library; draining them is a separate, screen-by-screen effort.
   Recorded here so the number is known, not hidden.

**Method note:** do not sed blindly. `gray-100` may be a surface (`bg-background-light`) or
a border (`border-border`) depending on the property. Convert per-file, eyeball the screen,
then fence it.

**Payoff:** once step 1 lands, a token change in `tokens.css` actually repaints every
primitive - which is the propagation promise the whole plan is about. Today it does not,
for the 66 values that bypass it.

---

## 7. Phase 7 - Guardrails that make it permanent

Without this phase every earlier phase decays. This is what converts the invariants in
§1 from "true today" into "cannot regress".

| # | Guard | Mechanism | Enforcement |
|---|---|---|---|
| 7.1 | **Raw `<button>`** (the outstanding 3c) | `no-restricted-syntax` in `eslint.config.js` flagging `JSXOpeningElement[name.name='button']` under `src/components/**` and `src/pages/**` | **warn** |
| 7.2 | **Shadow components** | vitest fence: fail if a file outside `components/ui/` exports a component named `*Button`/`*Modal`/`*Dialog`/`*Toggle`/`*Switch` that renders raw markup instead of composing the primitive | **error**, allowlisted |
| 7.3 | **Dead folders / shims** | vitest fence: `components/common` and `components/shared` must not exist; no file may re-export from another bucket's path | **error** |
| 7.4 | **Token compliance** | widen `tokens-guard.test.ts` to whole directories as Phase 6 clears them | **error** |
| 7.5 | **Fallback drift** | `tokens-fallback-drift.test.ts` (already landed Phase 2) | **error** |
| 7.6 | **Alias single-sourcing (I5)** | vitest fence asserting the `@/*` alias is identical in `tsconfig.json`, `vite.config.ts`, `vitest.config.ts` | **error** |

**Why 7.1 is warn, not error:** lint had never run in this repo, so nothing was ever
enforced. The restored config currently reports **396 problems (236 errors, 160 warnings)**
on the branch - all pre-existing, none introduced by this work. Gating CI on lint is a
separate decision that should be made deliberately once those 236 are triaged, not
smuggled in here. Warn still nudges every new raw `<button>` at authoring time.

**Why 7.2 matters most:** it is the only guard that directly enforces I2 - "no second
implementation of a concept". It is exactly what would have caught the hand-rolled `Toggle`
duplicating `ui/switch.tsx` the day it was written. Seed its allowlist from the current
tree so it starts green, then shrink the allowlist over time.

**Lint is not added to CI in this work.** Recorded as a follow-up decision.

---

## 8. Verification (every phase)

Matching the CI frontend gate exactly (`.github/workflows/ci.yml:142-164`):

```bash
cd frontend && npx tsc --noEmit && npm test -- --run && npm run build
```

Every phase must land back on: **0 tsc errors**, all tests passing (plus any the phase
adds), clean build.

Phases 4, 5 and 6 change **pixels**. Typecheck and tests cannot see that. Each requires
running the app and visually checking the touched screens before the PR - the Tier-1
conversion was verified this way against `/design-system` (a public kitchen-sink route),
measuring radius 6->14px, height 34->36px, weight 500->600.

---

## 9. Delivery

One PR per phase into `staging` (never a direct commit to `staging`/`main`), so review
stays tractable and rollback is granular. Promotion to `main` only after the staging PR
merges, per repo policy.

Phases 4-7 are independent of each other and can ship in any order. Suggested order by
value-per-risk:

**7 (guardrails) -> 6 step 1 (ui/ tokens) -> 4 (selection primitives) -> 5b (report hoist) -> reassess 5c**

Phase 7 first is deliberate: landing the fences before the remaining migrations means the
migrations are checked by them rather than trusted.

---

## 10. Corrections to earlier findings

Recorded so the plan does not carry forward things I got wrong:

1. **`ui/tabs.tsx` exists** (18 users). The gap is ToggleGroup, not Tabs. (§4a)
2. **The "latent Button variant bug" was a false alarm** - all `size="xl"` are valid
   `<Modal>` props; `variant="block"` is on a local `AddStepButton`. No ticket. (§4a)
3. **"224 chip/tab sites wanting a ToggleGroup" was overstated.** 210 sites carry
   conditional selected-state styling, but they span four different semantics and at least
   two (listbox options, selectable cards) must **not** become a ToggleGroup. Phase 4 triages
   before converting. (§4d)
4. **The button tail is not codemod-able.** 309 candidates / 233 signatures / 191
   singletons - unlike Tier 1's 88 sites / 3 signatures. (§5a)
5. **Phase 3 was reported complete; 3c was never implemented.** It is now Phase 7.1.

## 11. Open decisions

1. **Phase 5c** - drain the 191-singleton tail per-screen over time, or accept the fence
   and leave it? Recommendation: fence it, convert opportunistically.
2. **Phase 6 step 3** - the 491 palette classes in `pages/**`. Out of scope here; needs its
   own screen-by-screen plan.
3. **Lint in CI** - currently not gated. Needs a deliberate call once the 396 pre-existing
   findings (236 errors / 160 warnings) are triaged.
