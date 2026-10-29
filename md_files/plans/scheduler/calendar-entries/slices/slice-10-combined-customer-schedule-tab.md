# Slice 10 — One combined "Schedule" tab on the customer page

**Type:** AFK
**Blocked by:** Slice 09 — Schedule search matches Events by title
**Spec sections:** §6

## What to build

Attaching a customer participant makes the Event visible on that customer's page. Rather than a
fourth place to look, §6 asks for **one combined "Schedule" tab** listing that customer's jobs,
walkthroughs and Events together, in time order, so a user can see what is booked with a client
without jumping between tabs.

This is **read-only aggregation**. No schema change to jobs, walkthroughs or visits, no new
write path, no edit affordances — a row links out to the record it represents.

- **`frontend/src/pages/v2/customers/CustomerDetailPage.tsx`** — a
  `{ value: 'schedule', label: 'Schedule' }` entry in the `TabStrip` array and its matching
  `TabPanel`. Follow the strip's existing conventions exactly: text-only label, no glyph, **no
  parenthesised count** (the comment above that array explains why counts were removed — they
  restated the row count of the table the tab opens and half of them counted only the loaded
  page). Place it after **Jobs**, since it aggregates them.
- The panel composes three reads: the jobs already loaded by the page, the customer's
  walkthroughs, and `GET /api/calendar-entries` filtered to that customer participant — which
  means Slice 02's list endpoint needs a `customer_id` filter, the one small backend addition
  in this slice.
- Rows are sorted by start time across all three kinds, with a type chip using the same
  `EVENT_TYPE_META` label vocabulary the board uses ("Job" / "Walkthrough" / "Event"), so the
  two surfaces name the same things the same way.
- **The Events rows are hidden entirely when the viewer lacks `read CalendarEntry`** — the rest
  of the tab still renders. Same shape as the existing `canReadComms` gate on the Comms tab.
- Only the active panel is mounted, so the queries are naturally deferred until the tab opens.

## Acceptance criteria

- [ ] `GET /api/calendar-entries?customer_id=<id>` returns only entries holding a
      `CUSTOMER`-kind participant with that id, tenant-scoped, with a backend test — including
      the negative: another org's entry for a same-named customer is not returned.
- [ ] A frontend test renders the tab with one job, one walkthrough and one Event and asserts a
      single list in chronological order across all three.
- [ ] A viewer without `read CalendarEntry` sees the tab with jobs and walkthroughs and **no**
      Events rows, and no failed request in the console.
- [ ] Clicking a row navigates to the right record: job → `/jobs/:id`, walkthrough →
      `/leads/:id?tab=walkthrough`, Event → opens the Event dialog (read-only when the viewer
      cannot update).
- [ ] The existing customer tabs and their tests are unchanged, and the Comms tab still renders
      last.
- [ ] The tab is absent from the strip for a customer-detail render where the page already hides
      lead-dependent tabs (`hasLeads`), or it degrades gracefully — decide and assert one.

## Out of scope for this slice

- Removing or merging the existing **Jobs** tab. This tab is additive.
- Any write, reschedule or create affordance from the customer page.
- Service plans on the combined list — they are not a customer-page tab today and adding them is
  a separate decision.

## Verification

`cd backend && npm test -- calendar-entries` and `cd frontend && npm test -- customer`. On
staging: attach a customer to an Event, open that customer's page, open the **Schedule** tab and
confirm the Event sits in time order among that customer's jobs and walkthroughs; then log in as
a role without the `CalendarEntry` grant and confirm the tab still renders with the Events rows
absent.
