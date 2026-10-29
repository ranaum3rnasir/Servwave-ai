# Slice 03 — Entries on the board: adapter, the three guards, Standard view

**Type:** HITL — the muted card scheme is §9 risk 4 and needs a human to look at it
**Blocked by:** Slice 02 — `CalendarEntry` + `CalendarEntryParticipant`: model, migration, CRUD API
**Spec sections:** §3, §9 risk 4

## What to build

A Calendar Entry created through Slice 02's API now appears on the scheduler's **Standard** view
as a muted card carrying its title, and it disturbs nothing else. Jobs and walkthroughs behave
byte-identically — the existing `scheduleModel.test.ts` suite is the proof and must pass
**unmodified**.

Everything here is additive to `frontend/src/components/schedule/scheduleModel.ts`. No schema
change to `Job` or `Walkthrough`, no touching their controllers.

- **`EventType` gains `'calendar-entry'`.** Three `Record<EventType, ...>` tables key off it —
  `DEFAULT_DURATION_MIN`, `EVENT_TYPE_META`, and the `crewPeopleOf`/`ownerOf`
  `ScheduleEventType` mirror in `eventPeople.ts`. Widening the union turns every one of those
  into a compile error that has to be answered, which is the intended forcing function; do not
  silence any of them with a cast.
- **`EVENT_TYPE_META['calendar-entry']`** gets a muted scheme reading "on the calendar", not
  "assigned work". Constraint, not a token list: it must be visually distinguishable from the
  three type accents (`info` / `warning` / `ai`) **and** from `boardCardScheme`'s completed
  treatment (`border-l-neutral-strong` / `bg-neutral-surface` / `text-neutral-text`) — an entry
  that renders identically to a finished job reads as a finished job. Label is `'Event'`,
  the user-facing word.
- **`eventDangerState` returns `null` early for calendar entries.** Without this every entry
  paints red as state 4 "needs assignment", because every entry has an empty crew. Put the check
  before the `deriveState(e) === 4` line, not after.
- **`conflictedEventIds` excludes entries on both axes** — an entry neither reports a
  double-booking nor causes one (ADR 0002). The exclusion has to skip them as `a` *and* as `b`,
  which the current double loop does not get for free.
- **`calendarEntryToEvent(entry, tz)` in `eventAdapters.ts`** — `boardId: \`ce-${entry.id}\``,
  `parentId: entry.id`, `type: 'calendar-entry'`, `number: ''` (§2 — the card renders the title
  alone), `title: entry.title`, `customer: ''`, `crew: []`, `ownerId: null`, `tags: []`,
  `raw: entry`. This is the read boundary: `start`/`end` cross through `toWallClock(new
  Date(...), tz)` exactly here and nowhere else, same as `jobToEvents` — a `new Date(v)` anywhere
  downstream converts in the browser zone, which is #1551's second defect.
- **`useScheduleData`** gains a `['schedule-calendar-entries', dateRange]` query against
  `/api/calendar-entries` with the same `toInstant(dateRange.start, tz).toISOString()` boundary
  conversion the other four queries use. It is **not** wrapped in `useFeature` — §4 says core
  scheduler for every plan tier, unlike the two lead queries.
- **`useScheduleEvents`** merges entries into `scheduledEvents` and passes the merged list to
  `conflictedEventIds` (which now skips them). Entries never reach `bucketEvents` — there is no
  unscheduled state for an entry, `start`/`end` are required columns.
- **Standard week/day rendering** in `frontend/src/pages/v2/schedule/SchedulePage.tsx`. Entries
  are timed cards for now.

Two things this slice must make **inert**, because their default behaviour is actively wrong:

- **Drag and resize are refused.** `draggableAccessor` / `resizableAccessor` must return false for
  a calendar entry. Left alone, dropping one would route through `parseBoardDragId`, whose
  fall-through case is `{ kind: 'job' }`, and the page would `PATCH /api/jobs/<entry-uuid>/assign`.
  `dragChannels.ts` gets **no** `ce-` case in this slice — the absence is what makes the
  misroute impossible to reach once the accessors refuse.
- **Plan Mode ignores entries entirely** (§3). No ghosts, no draft state, and "schedule all
  drafts" never touches them.

Clicking an entry must not open the job/walkthrough editor and must not navigate to `/jobs/:id`.
In this slice a click is a no-op; the editor arrives in Slice 04.

**Note on which files are live.** `frontend/src/components/schedule/{EventEditor,
UnifiedDropModal,ScheduleSearch,ContextMenu,UnassignedBuckets,SettingsGearDropdown}.tsx` have no
importer outside their own test files — they are dead v1 forks. The live surfaces are
`frontend/src/pages/v2/schedule/components/*` (lowercase filenames) plus the genuinely shared
`scheduleModel.ts`, `eventAdapters.ts`, `eventPeople.ts`, `useScheduleData.ts`,
`useScheduleEvents.ts`, `dragChannels.ts`, `MemberWeekBoard.tsx`, `TechnicianGridView.tsx` and
`ScheduleCardBody.tsx`. Edit the dead copies and the change ships to nobody.

## Acceptance criteria

- [ ] `frontend/src/components/schedule/scheduleModel.test.ts` passes with **no edits to existing
      cases** — job and walkthrough behaviour is unchanged.
- [ ] New `scheduleModel.test.ts` cases: a calendar entry with `crew: []` and a real `start`
      returns `null` from `eventDangerState` (not `'needs-crew'`); a calendar entry sharing a
      time window with a crewed job produces an empty `conflictedEventIds` set; two overlapping
      calendar entries produce an empty set.
- [ ] `eventAdapters.test.ts` covers `calendarEntryToEvent`: `boardId` is `ce-<id>`, `number` is
      `''`, `crew` is `[]`, and the returned `start` is the org-zone wall clock, not the browser's.
- [ ] `useScheduleEvents.test.tsx` asserts entries land in `scheduledEvents` and never in
      `bucketEvents` / `visibleBucketEvents`.
- [ ] `EVENT_TYPE_META['calendar-entry']` is not byte-identical to the completed treatment
      returned by `boardCardScheme(type, true, false)` — asserted in a test, so a later token
      tidy cannot silently collapse them.
- [ ] `draggableAccessor` and `resizableAccessor` both return false for a calendar entry, covered
      by a test that would otherwise let a drop reach `/api/jobs/<uuid>/assign`.
- [ ] With Plan Mode active, dragging is refused and the ghost count does not change.
- [ ] `npx tsc --noEmit` (frontend) and `tsc -b` (backend) are clean, and
      `node scripts/lint-changed-lines.mjs origin/staging` reports no errors on added lines.
- [ ] **Human sign-off:** an entry, a scheduled job, an in-progress job and a completed job side
      by side on the Standard week view, screenshotted — the entry must be tellable from all
      three at a glance.

## Out of scope for this slice

- All-day entries and the all-day strip — Slice 05, deliberately held back (§9 risk 1).
- Member / Technician column placement — Slice 06; with `crew: []`, `isOnBoardFor` already
  returns false, so entries correctly do not appear in member views yet.
- Creating or editing an entry from the UI — Slice 04.
- Drag — Slice 08.
- Search — Slice 09.

## Verification

`cd frontend && npm test -- scheduleModel eventAdapters useScheduleEvents`, then
`npm test -- --run` for the full suite. In the browser on staging: `POST` an entry via the API
for a day inside the current week, open `/schedule`, confirm the muted card renders with its
title and no record number, confirm no red fill and no red outline anywhere on the board, drag a
job over the same hour and confirm neither card shows a conflict outline, then try to drag the
entry and confirm it does not move.
