# REQ-01 — All Scheduler Objects Must Behave Identically (DnD)

**Category:** Product Requirement (from Product Owner)
**Severity:** P0 (Requirement)
**Source:** Ran — "The number one goal: every object on the schedule and sidebar should behave the same"
**Date:** 2026-03-18

---

## The Requirement

Every object on the scheduler — jobs AND walkthroughs — must have identical drag-and-drop behavior in every context. No exceptions. If a job can be dragged somewhere, a walkthrough can be dragged there too. If a sidebar job can be dropped on the calendar, a sidebar walkthrough can too.

## Current State vs Required State

| Context | Jobs | Walkthroughs | Required |
|---------|------|-------------|----------|
| **Standard Calendar (Week/Day)** | Draggable (reschedule) | Draggable (reschedule) | Both draggable — MATCH |
| **Sidebar → Standard Calendar** | Draggable (assign via dialog) | NOT draggable (click only) | Both must be draggable |
| **Sidebar → Grid View** | Drag blocked (cursor blocked) | NOT draggable | Both must be draggable |
| **Within Grid View** | Cards not draggable | Cards not draggable | Both must be draggable |
| **Standard Calendar visual snap-back** | Snaps back (under investigation) | Snaps back despite 200 API | Both must STAY at new position |
| **Month View drag** | Draggable (date change) | Unknown | Both must be draggable |

## What Needs to Change

### 1. Sidebar walkthrough cards must be draggable
Currently walkthrough sidebar cards only have `onClick` (navigate to lead detail). They need `draggable` + `onDragStart` + a drag ghost (amber pill with lead number), same as job cards.

Drop behavior: when a walkthrough is dropped on the calendar, open a "Schedule Walkthrough" dialog (similar to AssignDialog) with pre-filled date/time from the drop position, and a technician/sales rep selector.

### 2. Grid view — ALL cards must be draggable
Both job cards and walkthrough cards in `TechnicianGridView` need `draggable` + `onDragStart`. Drop zones must accept both types. The drop handler should detect the type and call the appropriate mutation (`assignMutation` for jobs, walkthrough schedule mutation for walkthroughs).

### 3. Grid view — drop zones must accept external drags
The TechnicianGridView drop zones need to properly handle HTML5 `dragOver`/`drop` events from sidebar cards (both jobs and walkthroughs). Currently showing "blocked" cursor.

### 4. Snap-back bug must be fixed
Events must STAY at their new position after a successful drag. The optimistic update → query invalidation → refetch cycle must not cause visual revert. This affects both jobs and walkthroughs equally.

## Design Principle

**"If it's on the scheduler, it's draggable. Period."**

The only exceptions:
- Completed/cancelled events (locked — already implemented via P0 fix)
- Events in the past (optional — dispatchers may back-fill)

Everything else — jobs, walkthroughs, urgent, non-urgent, in any view, in any sidebar section — drags the same way, drops the same way, confirms the same way.
