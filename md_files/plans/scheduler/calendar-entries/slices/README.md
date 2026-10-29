# Calendar Entries ("Events") — implementation slices

Source of truth: [the design-locked spec](../../2026-08-24-calendar-entries-spec.md) ·
[ADR 0002](../../../../../docs/adr/0002-calendar-entries-sit-on-the-board-without-joining-the-assignment-model.md) ·
[CONTEXT.md](../../../../../CONTEXT.md) glossary — *Calendar Entry*, *Participant*; the
user-facing word is **Event**.

Each file below is a **tracer bullet**: a thin but complete path through every layer it needs
(schema → API → UI → tests), independently demoable when it merges.

## Dependency order

| # | Slice | Type | Blocked by | What lands |
|---|---|---|---|---|
| 01 | [The `CalendarEntry` permission subject, seeded into every existing org](slice-01-calendar-entry-permission-subject-and-backfill.md) | AFK | — | Catalog + default grants + Roles-UI row + the per-org `role_permissions` backfill, shipped alone so §9 risk 2 is the only thing in the diff |
| 02 | [`CalendarEntry` + `CalendarEntryParticipant`: model, migration, CRUD API](slice-02-calendar-entry-model-and-crud-api.md) | AFK | 01 | Two tables, RLS backstop on both, `/api/calendar-entries` CRUD with participants |
| 03 | [Entries on the board: adapter, the three guards, Standard view](slice-03-board-read-path-standard-view.md) | **HITL** | 02 | `EventType`/`EVENT_TYPE_META`, `eventDangerState` + `conflictedEventIds` exclusions, adapter, Standard-view render; drag and Plan Mode held inert |
| 04 | [The Event dialog: create, edit, hard-delete, one participants field](slice-04-event-dialog-create-edit-delete.md) | AFK | 03 | The dialog, `CustomerPickerWithCreate` reuse, hard delete behind a warning |
| 05 | [All-day and multi-day entries on the all-day strip](slice-05-all-day-entries-on-the-all-day-strip.md) | **HITL** | 04 | `isAllDayEvent` branch, the multi-day bar, the dialog's all-day toggle |
| 06 | [Member / Technician column placement via `participantUserIds`](slice-06-member-column-placement-via-participants.md) | AFK | 05 | `participantUserIds` on `SchedulableEvent`, `isOnBoardFor` widened — participants never folded into `crew` |
| 07 | [Notifications: scheduled, moved, cancelled](slice-07-participant-notifications-three-outcomes.md) | AFK | 06 | Three senders in `email.ts`, three `notificationService` verbs, the checkbox and delete-prompt rules |
| 08 | [Dragging an Event, and the notify toast](slice-08-drag-on-the-board-and-notify-toast.md) | AFK | 07 | `ce-` in `parseBoardDragId`, direct-save drag gated on the grant, non-blocking notify toast |
| 09 | [Schedule search matches Events by title](slice-09-schedule-search-by-title.md) | AFK | 08 | `calendarEntries` bucket in `scope=schedule`, an **Events** section in the scheduler search box |
| 10 | [One combined "Schedule" tab on the customer page](slice-10-combined-customer-schedule-tab.md) | AFK | 09 | Read-only aggregation of jobs + walkthroughs + Events on the customer detail page |

## Merge sequencing

**Serial, one PR at a time, each merged into `staging` before the next branch is cut.** Slices
03, 05, 06 and 08 all edit
`frontend/src/components/schedule/scheduleModel.ts`, and 03, 05 and 08 all edit
`frontend/src/pages/v2/schedule/SchedulePage.tsx`. Running two of them in parallel worktrees
produces conflicts in the busiest file on the board, and — worse — the `scheduleModel.test.ts`
suite that proves job and walkthrough behaviour is unchanged would be resolved by hand across
two branches.

Cut every branch from **`staging`**, never from `main`: the `main`-ancestor gate has not
self-healed since 2026-08-05 and `git merge-base --is-ancestor origin/main origin/staging` is
still non-zero.

### Two places the sequence can legitimately move

- **Slice 05 is the one that may need to wait.** §9 risk 1: the all-day strip and the
  react-big-calendar config are the same rendering path as the multi-day work in a separate
  session. If that work is still unmerged when 05 comes up, skip to **06** and come back — 06,
  07, 08, 09 and 10 do not depend on all-day.
- **Slices 09 and 10 are independent of each other** and could swap, though neither should
  overtake 08.

### The two risks the sequence exists to answer

- **§9 risk 2 — the per-org grant backfill.** It is first, alone, and its acceptance criterion is
  a `NOT EXISTS` count over `organizations` proving **zero** orgs are missing each of the four
  grants, plus `check-role-permission-drift --strict`. "It works on my org" is precisely the
  failure mode; a developer's own org always has the grant.
- **§9 risk 3 — template selection by status.** Slice 07 selects by a diff of `start`/`end`, and
  its acceptance criteria include grepping the controller for `status` and finding nothing.
  #1550 is the precedent.

## Two standing hazards for whoever implements these

1. **Dead v1 forks in `frontend/src/components/schedule/`.** `EventEditor.tsx`,
   `UnifiedDropModal.tsx`, `ScheduleSearch.tsx`, `ContextMenu.tsx`, `UnassignedBuckets.tsx` and
   `SettingsGearDropdown.tsx` have **no importer outside their own test files**. The live
   surfaces are `frontend/src/pages/v2/schedule/components/*` (lowercase filenames). Genuinely
   shared and live: `scheduleModel.ts`, `eventAdapters.ts`, `eventPeople.ts`, `useScheduleData.ts`,
   `useScheduleEvents.ts`, `dragChannels.ts`, `MemberWeekBoard.tsx`, `TechnicianGridView.tsx`,
   `ScheduleCardBody.tsx`. Edit a dead copy and the change ships to nobody.
2. **What CI actually gates** (`.github/workflows/ci.yml`): gitleaks; backend `npm run build`
   (`prisma generate` + `tsc -p tsconfig.build.json`, which catches more than `tsc --noEmit`)
   + `npm test`; frontend `tsc --noEmit` + tests + `npm run build` + `scripts/lint-changed-lines.mjs`
   against the base ref; and a **Database** job that runs `prisma migrate deploy`,
   `prisma migrate status`, boots `dist/index.js` against `/health`, and runs the RLS suites —
   including `rls-coverage.test.ts`, a ratchet that fails any new table carrying an
   `organization_id` without the `tenant_isolation` policy. Slice 02 must satisfy that ratchet.
