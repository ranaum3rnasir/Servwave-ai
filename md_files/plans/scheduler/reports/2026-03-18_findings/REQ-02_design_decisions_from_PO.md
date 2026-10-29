# REQ-02 — Design Decisions from Product Owner

**Source:** Ran (Product Owner) via Slack
**Date:** 2026-03-18

These are product decisions that the development team must implement. They override previous assumptions.

---

## Decision 1: Past events CAN be dragged — design decision needed

**Current behavior:** Past events are visible and draggable (no restriction).
**Product Owner decision:** Past events CAN be dragged, but this needs a design decision from the development team on HOW to handle it. Options include:
- Allow freely (dispatchers may back-fill records)
- Allow with a confirmation dialog ("This event is in the past. Move anyway?")
- Allow but log the change for audit purposes

**Action for dev team:** Make a design decision on past-event drag behavior. Document the decision. Implement accordingly.

**Priority:** P2 — design decision, not a bug

---

## Decision 2: Cancelled events should be REMOVED from the schedule

**Current behavior:** Cancelled events appear on the schedule at 0.5 opacity when "All" toggle is active. They are locked from drag/resize (P0 fix from Day 1).
**Product Owner decision:** Cancelled events should NOT appear on the schedule at all. Remove them entirely.

**Implementation notes:**
- The "Open" filter already hides cancelled events. The "All" filter shows them.
- Option A: Remove cancelled events from the API response entirely (backend filter)
- Option B: Keep "All" toggle but rename to "Open / Show Completed" — exclude cancelled from both views
- Option C: Remove the "All" toggle, only show open events, add a separate "Archive" view for completed/cancelled

**Impact on P0 fix:** The `draggableAccessor` guard for CANCELLED events (N-01 fix) may become unnecessary if cancelled events are simply not rendered. Keep the guard as defense-in-depth.

**Priority:** P1 — cancelled events on the schedule cause confusion

---

## Decision 3: Completed events CAN be moved — design decision for future

**Current behavior:** Completed events are locked from drag/resize (P0 fix from Day 1 — `draggableAccessor` returns false for COMPLETED status).
**Product Owner decision:** Completed events SHOULD be movable, but this is a future design decision. The development team will determine:
- When should completed events be movable? (e.g., within 24 hours of completion? Always?)
- Should moving a completed event require confirmation?
- Should it change the status back to SCHEDULED?
- Audit trail requirements?

**Impact on P0 fix:** The current `draggableAccessor` guard blocking COMPLETED events is TEMPORARY. It was the right call for the QA sprint (preventing accidental data corruption), but the final behavior should allow movement with appropriate guardrails.

**Action for dev team:** Design the completed-event movement flow. Until then, keep them locked (current P0 fix).

**Priority:** P2 — future design decision, not immediate

---

## Summary for Dev Team

| Decision | Current | Required | Priority |
|----------|---------|----------|----------|
| Past events drag | Allowed, no restriction | Allowed, but needs design decision on UX | P2 |
| Cancelled events on schedule | Visible at 0.5 opacity in "All" mode | Remove from schedule entirely | P1 |
| Completed events drag | Locked (P0 fix) | Should be movable in future with guardrails | P2 (future) |
