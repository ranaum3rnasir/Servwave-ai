# RAN-04 — Product Owner Assessment: "The Whole DnD System Is Broken From Its Base"

**Tester:** Ran (Product Owner)
**Date:** 2026-03-18
**Severity:** P0 (Systemic — affects the core value proposition of the scheduler)
**Source:** Slack message

---

## Ran's Exact Words

> "Resize doesn't work. I tried to resize but I can drag but when I release it gets back to the original place. Same thing even if I refresh the page."
>
> "So it's not consistent regarding the drag and drop thing. I tried to drag past events and I'm able to drag them but they go back to their original place. Same thing for jobs, same thing for walkthroughs. I am also able to drag jobs in the day view but not walkthroughs."
>
> "I feel like everything is off. All the objects should inherit the same object basically so they should all behave the same. I don't understand why certain objects behave differently. Jobs and walkthroughs are not some of one of them. Can be rescheduled, one of them cannot be rescheduled. One of them can be resized or they cannot be resized. I think this whole thing is broken from its base."

---

## What Ran Found

| Action | Jobs | Walkthroughs | Expected |
|--------|------|-------------|----------|
| Drag in Day view | Can drag, snaps back | CANNOT drag | Both should drag + persist |
| Drag in Week view | Can drag, snaps back | Can drag, snaps back (API 200 but no persist) | Both should drag + persist |
| Drag past events | Can drag, snaps back | Can drag, snaps back | Both should drag + persist |
| Resize (bottom edge) | Can initiate, snaps back | Unknown | Both should resize + persist |
| Resize persists after refresh | No | N/A | Yes |

---

## Root Cause Assessment

The DnD system has MULTIPLE independent failure points:

1. **Snap-back after successful API call (walkthroughs):** API returns 200 but the optimistic update → query invalidation cycle reverts the visual position. Data doesn't persist after refresh — so either the API isn't actually saving, or the mutation sends wrong data.

2. **Jobs can't be rescheduled (inactive tech):** Most jobs reference inactive E2E test technicians. The assign mutation fails with "Cannot assign to inactive technician" but the error is swallowed silently — no toast shown.

3. **Walkthroughs can't drag in Day view:** The `handleEventDrop` may handle walkthroughs differently in Day vs Week view, or the DnD addon's day view doesn't fire `onEventDrop` for walkthrough events.

4. **Inconsistent behavior between entity types:** Jobs and walkthroughs use different mutation paths (`assignMutation` vs `walkthroughRescheduleMutation`), different data structures, and different error handling. They should behave identically from the user's perspective.

5. **Resize snaps back:** The `handleEventResize` uses the same `assignMutation` as drag, so it hits the same inactive-tech issue for jobs. For walkthroughs, resize calls `walkthroughRescheduleMutation` which has the same snap-back persistence issue.

---

## Product Owner's Core Directive

**"All objects should inherit the same object. They should all behave the same."**

This means:
- One unified DnD behavior for jobs AND walkthroughs
- Same drag behavior in ALL views (Week, Day, Month, Grid)
- Same resize behavior for all event types
- Same persistence — if you move it, it STAYS moved
- Same error handling — if it fails, you SEE the error

---

## Impact on the Final Report

This finding, combined with REQ-01 ("everything must be draggable"), fundamentally redefines the scope of work for the dev team. The scheduler's DnD is not a polish issue — it's a core functionality failure. The dev team report must lead with this systemic assessment, not individual findings.

**The scheduler looks good (layout, colors, cards, sidebar). But the #1 feature — drag-and-drop rescheduling — does not work reliably in any view, for any event type.**
