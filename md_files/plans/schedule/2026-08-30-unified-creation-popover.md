# Scheduler - unified creation flow + toolbar refresh

Plan for the single-creation-surface task. Status: awaiting approval, nothing implemented.

## What exists today (verified, not assumed)

The current creation flow is **three** windows, not two:

| Step | Component | File |
|---|---|---|
| 1. Picker popover on empty-slot click | `QuickScheduleCard` | `pages/v2/schedule/components/quickScheduleCard.tsx` (340 lines) |
| 2a. Job selected | `AssignJobDialog` | `components/jobs/AssignJobDialog.tsx` |
| 2b. Walkthrough selected | none - mutates directly | `SchedulePage.tsx` `walkthroughRescheduleMutation` |
| 2c. Event | `EventEntryDialog` | `pages/v2/schedule/components/eventEntryDialog.tsx` (647 lines) |

The toolbar "New Event" button (`SchedulePage.tsx` ~3569) opens `EventEntryDialog` directly,
bypassing step 1.

Toolbar lives inline in `SchedulePage.tsx` ~3338-3620 (the file is 4574 lines).

## Findings that change the brief

1. **`AssignJobDialog` is shared with the Jobs module.** `pages/v2/jobs/JobDetailPage.tsx:55,1847`
   renders it for its own assign/schedule actions. "No other path in the app may open the old
   creation windows" therefore cannot include it - unwiring it there would break job assignment
   from the job page. Scope the rule to the Scheduler's creation path.

2. **Standard/Member is already an icon + label two-segment toggle.** `components/segmented.tsx`
   with `CalIcon`/`Users` icons and Standard/Member labels. Spec item 1.4 looks already satisfied.

3. **Job addresses need no backend work.** `backend/src/controllers/job.controller.ts:142` already
   selects `service_location: { id, address_line1, city, state }` on the jobs list. Walkthrough rows
   already read the lead's own `service_address_line1` (`quickScheduleCard.tsx:280`). So the
   "never the customer address" rule is satisfiable client-side today.

4. **Job rows currently show no address at all** - only job number + customer name
   (`quickScheduleCard.tsx:253-267`). So item 4 is an *addition* for jobs, not the removal of a
   wrong customer fallback. The wrong-fallback risk is real but latent: `job.customer` is what is
   in hand at that call site, so the obvious implementation is the wrong one.

5. **Toolbar heights are already inconsistent**: `h-7` (Today, segments), `size-6` (hour nudge),
   `size-7` (plan mode). Item 1.7's shared size token is a real change, not a no-op.

## Work plan

### Slice 1 - shared size token
Add one toolbar control size token and apply to every control in the row. No behaviour change.

### Slice 2 - extract shared creation logic
Pull the form logic the new popover needs out of `EventEntryDialog` / `AssignJobDialog` into a
shared module (`pages/v2/schedule/creation/`), consumed by BOTH old and new, so the old windows
still compile and render standalone. No deletion, no gutting.

### Slice 3 - the popover
`ScheduleCreatePopover` - Radix popover (`ui-kit/components/ui/popover.tsx` exists), ~520px,
max-height + internal scroll, collision flip, `Sheet` fallback under the mobile breakpoint.
Header `Schedule`, tabs Job / Walkthrough / Event, `Job` forced on every open.
Shared date/time/address state hoisted above the tabs; type-specific state per tab.
Outside-click + Esc dismiss with a dirty-confirm; portalled content excluded from outside-click
(Radix does this natively for its own portals - the risk is non-Radix portals, to be checked).

### Slice 4 - two entry points
Toolbar icon button (far left of `Today`, tooltip + `aria-label="Create"`) and empty-slot click,
both opening the same component, the slot click seeding date/time and anchoring to the slot.
Remove the toolbar "New Event" button. Unwire `QuickScheduleCard` from the slot click.

### Slice 5 - search rows
Two-line rows: line 1 `ID` + `Name`, line 2 address from the job's `service_location` or the
lead's own `service_address_line1`. Blank when missing - never `job.customer`.
Add a regression test asserting no customer-address fallback.

### Slice 6 - view switcher + CLEANUP.md
Day/Week/Month segmented -> `SelectField` single select. Hover states on every control.
Write `CLEANUP.md` at repo root listing everything that dies on approval. Do not act on it.

## Verification
`npx tsc --noEmit`, the schedule vitest suites, and a browser pass on the mock dev-lab
(`npx vite --config vite.dev-app.config.ts --port 5199`, http://localhost:5199/schedule).

## Decisions (2026-08-30)

- **Branch:** continue on `refactor/schedule-dense-day` (#1780) itself. Accepted tradeoff:
  that PR now covers both the dense-day redesign and this work.
- **Old windows:** preserve `QuickScheduleCard` + `EventEntryDialog` (unwired from the
  scheduler, still compiling). `AssignJobDialog` stays fully wired for `JobDetailPage` -
  the scheduler simply stops routing into it. Shared logic may be extracted from it.
- **Standard/Member toggle:** becomes icon-only, tooltip + `aria-label`, matching the new
  create button and the existing Plan Mode toggle.
