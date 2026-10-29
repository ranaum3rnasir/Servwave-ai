# Slice 09 — Schedule search matches Events by title

**Type:** AFK
**Blocked by:** Slice 08 — Dragging an Event, and the notify toast
**Spec sections:** §3

## What to build

The scheduler's search box returns Events, matched on **title**, in their own section alongside
Jobs and Walkthroughs. Selecting a result focuses that Event on the board the same way selecting
a job does.

This is not a frontend-only change: the schedule search box calls
`GET /api/search?scope=schedule&rangeStart=&rangeEnd=`, so the results come from
`backend/src/controllers/search.controller.ts`.

- **Backend.** `scope=schedule` gains a `calendarEntries` bucket in the results object. It is
  org-scoped through `scopeWhereForReq(req, 'CalendarEntry')` like every other bucket in that
  controller — which is fail-closed, so a caller without `read CalendarEntry` gets an empty
  array rather than a leak, and needs no extra branch. It matches `title` case-insensitively,
  honours the same `rangeStart`/`rangeEnd` overlap window Slice 02's list endpoint uses, and is
  capped at 5 like its siblings. The `results` object always carries the key, even when empty —
  the frontend spreads it unconditionally.
- **Frontend.** `frontend/src/pages/v2/schedule/components/scheduleSearch.tsx` — the **live**
  component. Note it currently flattens only `data.results.jobs` and `data.results.leads`
  (no service plans, unlike its dead v1 twin). Add a `'calendar-entry'` entry to
  `SECTION_CONFIG` labelled **Events**, include the new bucket in `flatResults` (keyboard nav
  and `indexMap` derive from it, so a bucket left out of the flatten renders rows that arrow-keys
  skip), in the `hitCap` check, and as a `renderSection` call.
  **Do not edit `frontend/src/components/schedule/ScheduleSearch.tsx`** — it has no importer
  outside its own test file.
- A `SearchResult` for an Event has no `status`, no `total` and no `address`; the row renders
  title plus date. `resultDate` reads the instant in the **org's** zone, not the viewer's — an
  Event must follow that same rule.

## Acceptance criteria

- [ ] A backend search test: `GET /api/search?scope=schedule&q=<title fragment>` returns the
      Event in `results.calendarEntries`, and an Event outside the `rangeStart`/`rangeEnd` window
      is excluded.
- [ ] A caller **without** `read CalendarEntry` gets `results.calendarEntries: []` — the key is
      present and empty, not missing.
- [ ] Search matches on `title` only. An Event whose *description* contains the query and whose
      title does not is **not** returned.
- [ ] `scheduleSearch.test.tsx`: the Events section renders under its own header; arrow-key
      navigation traverses Job → Walkthrough → Event rows in section order without skipping;
      Enter on an Event row calls `onSelect` with that result.
- [ ] Selecting an Event result focuses/highlights the entry's card on the board rather than
      navigating to a job or lead detail page.
- [ ] The existing Jobs and Walkthroughs sections and their tests are unchanged.

## Out of scope for this slice

- The global (non-schedule) search scope. Events are a scheduler concept; adding them to the
  header search is a separate decision nobody has asked for.
- Matching on participant name or description.

## Verification

`cd backend && npm test -- search` and `cd frontend && npm test -- scheduleSearch`. On staging:
create an Event titled something distinctive, type three letters of it into the scheduler's
search box, confirm it appears under **Events** with the right date in the org's timezone, arrow
down to it and press Enter, and confirm the board focuses that card.
