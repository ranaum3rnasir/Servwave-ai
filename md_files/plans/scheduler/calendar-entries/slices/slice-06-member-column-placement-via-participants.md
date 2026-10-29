# Slice 06 — Member / Technician column placement via `participantUserIds`

**Type:** AFK
**Blocked by:** Slice 05 — All-day and multi-day entries on the all-day strip
**Spec sections:** §3, ADR 0002

## What to build

An Event appears in a member's column on the Member week board and the Technician grid **iff a
user participant matches that column**. An Event with no user participants — or with only
customer participants — appears in no member column at all. Those views answer "what is this
person doing"; they do not answer "when is Dave off", and an entry naming nobody has no column
to belong to.

- **`SchedulableEvent` gains `participantUserIds?: string[]`.** Optional, so every existing
  fixture across the five schedule test files stays valid — the same reason `tags` is optional.
- **`isOnBoardFor` becomes**
  `e.crew.includes(memberId) || (e.participantUserIds ?? []).includes(memberId)`,
  and its parameter widens from `Pick<SchedulableEvent, 'crew'>` to
  `Pick<SchedulableEvent, 'crew' | 'participantUserIds'>`.
- **Participants are never folded into `crew`** (§3). `crew` stays `[]` for a calendar entry,
  which is what keeps `deriveState` at state 4/1, `eventDangerState`'s early return meaningful,
  and `conflictedEventIds`' exclusion honest. A test must assert `crew` is still `[]` on an
  entry that has user participants — the tempting shortcut of populating `crew` from
  participants would make every entry double-book its participants and paint the board red,
  which is precisely the alternative ADR 0002 rejects.
- **The adapter fills the field** from the entry's `participants` where `kind === 'USER'`.
  Slice 02's list payload already carries them.
- Both member views already call `isOnBoardFor` and `eventDangerState` and render whatever
  `scheduledEvents` hands them, so no per-view branching should be needed. If a view needs a
  special case, that is a signal the model change is in the wrong place.

**The deliberate consequence, restated so nobody "fixes" it:** attaching Dave says nothing about
Dave's availability. A dispatcher can book a real job over an entry naming Dave and the board
shows no warning, in the member column as much as on the Standard view. That is ADR 0002's
accepted trade. The escape hatch if it proves wrong is a `blocks_availability` flag feeding the
conflict pass — explicitly not v1 (§8).

## Acceptance criteria

- [ ] `scheduleModel.test.ts`: `isOnBoardFor` is true for a member listed only in
      `participantUserIds`; true for a member on `crew` with `participantUserIds` absent
      (the existing job cases, unmodified); false for a member who is neither.
- [ ] An entry whose only participants are customers returns false from `isOnBoardFor` for every
      member.
- [ ] An entry with user participants still has `crew: []`, and `conflictedEventIds` over that
      entry plus a job crewed with the same user returns an **empty** set.
- [ ] `MemberWeekBoard.test.tsx` and `TechnicianGridView.test.tsx` each gain a case: an entry
      naming user A renders in A's column and not in B's, on the correct day.
- [ ] The card in a member column shows no red fill and no red outline.
- [ ] The full existing member-view suites pass unmodified.

## Out of scope for this slice

- Any availability or conflict behaviour — ADR 0002 forbids it.
- Notifying the participant that they were added — Slice 07.
- Dragging the entry out of a member column — Slice 08.

## Verification

`cd frontend && npm test -- scheduleModel MemberWeekBoard TechnicianGridView`. In the browser on
staging: create an Event naming one technician, switch to the Member view and confirm the card
sits in that technician's column only; create a second Event with only a customer participant and
confirm it appears on the Standard view but in no member column; then book a real job on that
technician at the same hour and confirm **no** conflict outline appears on either card.
