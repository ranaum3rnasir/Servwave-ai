# `pages/v2/_shared`

Presentation primitives that **every** v2 module needs and the UI kit does not ship.

The fifteen v2 module branches were built in parallel under a rule that forbade editing a shared
file, so the first module to need a tab strip or a status chip built one inside its own folder and
the next fourteen imported it from there. That made `pages/v2/leads` an accidental library: a change
to the leads page could break Schedule. This folder is the fix. Leads is a module again.

## What belongs here

- A primitive the kit lacks, needed by more than one module, and **module-agnostic** - it names no
  entity, reads no module registry, and hardcodes no domain.
- Everything a module varies must arrive as a prop. `filterPopover` takes `statusDomain` (or a
  `renderOption`) for exactly this reason; it does not decide per caller which domain to paint.

## What does not belong here

- Module-specific pieces. A jobs-only lifecycle palette, a customers-only standalone-filter chip, an
  estimates-only deposit facet - those stay in their module even when the surrounding file looks like
  a near-copy of one in here. Two honest files beat one file with a branch per caller.
- Anything the kit already ships. Check `@/ui-kit/components/ui` first.
- App-wide logic. Status labels and intents stay in `@/design-system/status-registry`; filter models
  stay in `@/lib/filters`. This folder decides how something is painted, never what it means.

## What is here

| File | Why it is shared |
|------|------------------|
| `tabs.tsx` | `TabStrip` / `TabPanel`. The kit ships no Tabs primitive; 20 files across 11 modules use these. |
| `statusChip.tsx` | Paints a `status-registry` entry onto a kit Badge. Used by leads, customers, inventory, invoices and service-plans. |
| `contactCell.tsx` | Table cell that dials or mails on click. Used by leads and customers. |
| `pickCustomer.tsx` | `PickCustomerFields` - the customer pick-or-create block. Used by leads and invoices. |
| `pickLocation.tsx` | `PickLocation` - the service-location block. Used by leads and invoices. |
| `appliedFilters.tsx` | `AppliedFilterBar` - the applied-filter chip strip. Used by leads, customers (its non-facet chips ride `extraChips`), jobs, estimates and invoices. |
| `filterPopover.tsx` | `FilterPopover` - the ONE list filter: a popover from md up, a bottom sheet below it. Used by leads, customers, invoices, jobs, estimates, tasks and inventory. What a list varies is a prop: `statusDomain` / `renderOption` (option paint), `renderFacet` (its own pane for one facet), `facetTimezones` (the org zone for a scheduling facet), `extraCount` / `onClearAll` (constraints outside the facet list). |
| `adSource.ts` | `adSourceLabel` - display casing for an org's ad-source values. Used by leads and customers columns. |
| `planBuilderDialog.tsx` | The new-service-plan builder. Rendered by service-plans ("New plan") and by customers (with `presetCustomerId`). |
| `recurrenceBuilder.tsx` | The interval/weekday/terminator picker `planBuilderDialog` composes. |
| `materialLines.tsx` | The default-materials row editor. Used by `planBuilderDialog` and by the service-plans detail sheet. |
| `planShared.ts` | `money` / `date` / `customerName` / `property` / `MaterialDraftLine` - the display helpers those three and the service-plans page share. |
| `glyphs.ts` | The escaped punctuation constants `planShared` and the service-plans sheet render. |
| `loList.tsx` | `LOList` - the logistic-order list. Rendered bare by the inventory Logistic Orders tab and anchored (`jobId`) by the jobs detail page. |
| `selectColumn.tsx` | `buildSelectColumn` - the row-selection checkbox column. Used by all four inventory-module grids (stock, price book, purchase orders, vendor spend). |
| `backLink.tsx` | `BackLink` - the "back to where I came from" control, rendered into `PageHeader`'s `back` slot. Used by the customer, job and lead form pages, by both reports shells, and by the automations builder (which has no `PageHeader` to slot it into - its title is an editable `Input` - so it reproduces the slot's placement by hand). |
| `dateTimePicker.tsx` | `DateTimePicker` - kit Popover + Calendar + time Select, one field, `datetime-local`'s string contract. Used by tasks (create dialog and detail drawer) and the service-plans detail sheet. |
| `datePicker.tsx` | `DatePicker` - a typeable MM/DD/YYYY field plus a calendar popover, on `<input type="date">`'s `'YYYY-MM-DD'` string contract. Used by fourteen files across ten modules. |
| `timeCombobox.tsx` | `TimeCombobox` - a typeable 12-hour time field plus a filtered option list, on `<input type="time">`'s `'HH:MM'` contract. Used by the two schedule surfaces, the job form and the org default start time. |
| `scheduleTimeFields.tsx` | `ScheduleTimeFields` - start date, start time, end date, end time. The ONE field set every v2 surface that schedules anything renders: the board popover, the drop modal, the job form and the leads walkthrough tab. |

`loList.tsx` is a promotion for the same reason as the service-plan rows, and it is domain-named too:
the jobs detail page was still mounting the LEGACY `components/inventory/lo/LOList` on its Logistics
tab, so a v2 page rendered legacy chrome, and module isolation forbade it importing the inventory
copy. Everything it varies (`jobId` / `invoiceId` / `servicePlanId`) is already a prop, and it reaches
into no module folder - only `@/lib/api/logisticOrders`, the ability context, the two legacy
`components/inventory/lo/*` files it deliberately keeps, and `./statusChip`.

The five service-plan rows are a promotion, not a new primitive: `planBuilderDialog` is domain-named,
which the rules above otherwise rule out. It is here because customers and service-plans both render
it and the alternative was a second copy of a builder whose location POST is not idempotent. Its
transitive dependencies came with it so that nothing in `_shared/` reaches back into a module.

`selectColumn.tsx` is a factoring, not a move. `pages/v2/jobs`, `customers`, `estimates` and
`invoices` each still declare their own verbatim copy of this column - written when a module branch
could not edit a shared file. Those four are deliberately left alone (they are live and the brief
that added the fifth through ninth call sites forbids touching them); the new callers share one
declaration instead of adding five more copies. Both aria-labels arrive as props, so nothing here
branches per caller. Repointing the original four is a separate, mechanical follow-up.

`dateTimePicker.tsx` is a promotion out of `pages/v2/tasks/components`. It was tasks-local only because
tasks needed it first: the service-plans sheet asks for a date and a time in one field too, and was
still doing it with a bare native `datetime-local`, which is the browser's control rather than the
kit's and whose OS-level popup a modal Radix layer cannot dismiss (issue #430). It names no entity and
its whole contract is the `'YYYY-MM-DDTHH:MM'` string, so it belongs here. `ELLIPSIS` came with it,
into `glyphs.ts`.

`datePicker.tsx` and `timeCombobox.tsx` are v2 ports of `components/form/DatePicker` and
`components/form/TimeCombobox`, and they exist because `__tests__/no-native-time-inputs.test.ts` bans
native `date` / `time` / `datetime-local` inputs tree-wide: all three render their clock and their
field ORDER from the BROWSER locale, so a non-US browser showed an ambiguous `04/08/2026` and a
24-hour picker in a product sold only to US contractors. Nineteen v2 files still had one. The kit's own
`form/datePicker` cannot stand in - it emits a `Date` and is not typeable - and the legacy pair is
built on `components/ui`, a token vocabulary no v2 file uses. Both ports delegate every parse and
format to `@/lib/date-input`, the same module the legacy pair uses, so the string contracts (`''` /
`'YYYY-MM-DD'` and `''` / `'HH:MM'`) are identical to the native inputs' and no payload moved. Every
clickable affordance in both is a kit `Button`, not a raw one: the design-system raw-tag ratchet had
two counts of slack.

`timeCombobox` does NOT replace `timeSelect`; the two are different controls for different surfaces
(a text field beside a `datePicker` versus a dropdown), and `timeSelect`'s existing call sites are
untouched.

`backLink.tsx` is new, and it exists because "go back" had been built three different ways: the form
pages put a ghost Button in `PageHeader`'s ACTIONS column (top RIGHT, next to Save), while the two
reports shells hand-placed a link Button above the header with their own offsets. One control, one
place, and `PageHeader` gained a `back` slot to hold it.

`appliedFilters.tsx` and `filterPopover.tsx` are consolidations, not moves: the module copies were
verified character-for-character identical (comments and the exported name normalised out) before
being folded together. `filterPopover` gained one prop, `statusDomain`, which is exactly the constant
the two copies disagreed on.

## What is deliberately still duplicated

Each module keeps its own `statusChip.tsx` (jobs' lifecycle palette, estimates' deposit domain) and
its own chip strip where the chips are not facet-shaped (the tasks Dashboard drill-down, inventory's
`Remove {label}` chips). The list FILTER is no longer one of them: jobs, estimates, tasks and
inventory had their own fork of the panel until mobile slice 64, each sized for a desktop window
with no phone layout, and they now use `filterPopover.tsx`. `src/__tests__/list-filter-single-implementation.guard.test.ts`
fails if a second copy of the facet rail appears.

## The invariant

No file under `pages/v2/<module>/` imports from another module's folder. `pages/v2/__tests__/` is the
one exception - a cross-module adoption spec has to reach into every module by definition. Check it
with:

```
rg "from '(\.\./)+(leads|jobs|estimates|invoices|customers|inventory|schedule|tasks|dashboard|reports|settings|automations|communication|service-plans)/" frontend/src/pages/v2
```

## Adding to this folder

Move the file, repoint every importer, and run `npx tsc --noEmit` - a missed importer is a compile
error, not a silent break. Then add a row above.
