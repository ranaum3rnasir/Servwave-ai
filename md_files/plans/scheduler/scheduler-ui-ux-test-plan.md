# Scheduler UI/UX Test Plan

**Author:** UI/UX Lead
**Date:** 2026-03-17
**Module:** SchedulePage + TechnicianGridView + MemberWeekBoard
**Benchmark:** Google Calendar drag-and-drop behavior
**Status:** Reviewed by Senior QA — v2 with gap fixes

---

## Table of Contents

1. [Test Infrastructure & Output Format](#1-test-infrastructure--output-format)
2. [Test Categories Overview](#2-test-categories-overview)
3. [Category A — Text & Content Overflow](#category-a--text--content-overflow)
4. [Category B — Scroll Behavior](#category-b--scroll-behavior)
5. [Category C — Sidebar Space Utilization](#category-c--sidebar-space-utilization)
6. [Category D — Drag-and-Drop Core](#category-d--drag-and-drop-core)
7. [Category E — Drag-and-Drop Visual Feedback](#category-e--drag-and-drop-visual-feedback)
8. [Category F — Drag-and-Drop Drop Targets](#category-f--drag-and-drop-drop-targets)
9. [Category G — Resize (Duration Change)](#category-g--resize-duration-change)
10. [Category H — DnD Edge Cases & Error States](#category-h--dnd-edge-cases--error-states)
11. [Category I — DnD Performance](#category-i--dnd-performance)
12. [Category J — Responsive & Viewport](#category-j--responsive--viewport)
13. [Category K — Visual Hierarchy & Readability](#category-k--visual-hierarchy--readability)
14. [Category L — Interaction Feedback (Non-DnD)](#category-l--interaction-feedback-non-dnd)
15. [Category M — State Edge Cases](#category-m--state-edge-cases)
16. [Existing E2E Coverage Map](#existing-e2e-coverage-map)
17. [Priority Matrix](#priority-matrix)

---

## 1. Test Infrastructure & Output Format

### Output Storage

All test outputs go to the **git-ignored** `md_files/` tree:

```
md_files/plans/scheduler/
├── scheduler-ui-ux-test-plan.md          ← THIS FILE (master plan)
├── reports/
│   ├── YYYY-MM-DD_run-summary.md         ← Per-run summary (pass/fail counts, top blockers)
│   ├── YYYY-MM-DD_findings/
│   │   ├── A-01_event-title-truncation.md
│   │   ├── D-07_sidebar-to-calendar-drag.md
│   │   └── ...                           ← One file per finding
│   └── YYYY-MM-DD_screenshots/
│       ├── A-01_truncation_1920x1080.png
│       ├── A-01_truncation_1366x768.png
│       ├── D-07_drag-ghost-week-view.mp4  ← Video for DnD issues
│       └── ...
```

### E2E Test Spec Storage

Automated Playwright specs go in the existing E2E structure:

```
frontend/e2e/
├── specs/
│   ├── sched-text-overflow.spec.ts        ← Category A
│   ├── sched-scroll.spec.ts               ← Category B
│   ├── sched-sidebar.spec.ts              ← Category C (extends wt-schedule-sidebar.spec.ts)
│   ├── sched-dnd-core.spec.ts             ← Category D
│   ├── sched-dnd-visual.spec.ts           ← Category E
│   ├── sched-dnd-targets.spec.ts          ← Category F
│   ├── sched-resize.spec.ts               ← Category G
│   ├── sched-dnd-edge-cases.spec.ts       ← Category H
│   ├── sched-responsive.spec.ts           ← Category J
│   ├── sched-visual-hierarchy.spec.ts     ← Category K
│   ├── sched-interactions.spec.ts         ← Category L + M
│   ├── sched-state-edge-cases.spec.ts     ← Category M (standalone)
│   └── sched-feature-edge-cases.spec.ts   ← Category N (QA review additions)
├── pages/
│   └── schedule.page.ts                   ← Extend existing POM
└── screenshots/
    └── scheduler-audit/                   ← Visual regression baselines
```

### Finding Report Template (One Per Issue)

Each finding file (`YYYY-MM-DD_findings/X-NN_slug.md`) uses this format:

```markdown
# [Test ID] — [Short Title]

**Category:** [A-M] — [Category Name]
**Severity:** P0 (Broken) | P1 (Feels Wrong) | P2 (Polish)
**View(s) Affected:** Week / Day / Month / By-Tech Grid / By-Tech Week / All
**Viewport(s):** 1920x1080 / 1440x900 / 1366x768

## Steps to Reproduce
1. Navigate to /schedule
2. [Exact click/drag sequence]
3. [What to observe]

## Expected Behavior (Google Calendar Reference)
[What Google Calendar does in this scenario. If no Google equivalent, describe the ideal UX.]

## Actual Behavior
[What our scheduler does — be precise about visual state]

## Evidence
- Screenshot: `screenshots/X-NN_description_viewport.png`
- Video/GIF: `screenshots/X-NN_description.mp4` (required for DnD/animation issues)
- Console errors: [if any]

## Impact
[Who is affected, how often this scenario occurs, workflow disruption level]

## Suggested Fix Direction
[Optional — brief hint for the developer, not a full spec]
```

### Run Summary Template

Each `YYYY-MM-DD_run-summary.md`:

```markdown
# Scheduler UI/UX Audit — [Date]

**Tester:** [Name]
**Viewports tested:** [list]
**Views tested:** [Standard Week/Day/Month, By-Tech Grid/Week]
**Test data:** [N jobs, N walkthroughs, N technicians]

## Results

| Category | Total Tests | Pass | Fail | Skip | P0 | P1 | P2 |
|----------|------------|------|------|------|----|----|-----|
| A — Text Overflow | | | | | | | |
| B — Scroll | | | | | | | |
| ... | | | | | | | |
| **TOTAL** | | | | | | | |

## Top Blockers (P0)
1. [Finding ID] — [title]

## Top Usability Issues (P1)
1. [Finding ID] — [title]

## Notes
[Anything unusual about this run, data setup issues, flaky behaviors]
```

---

## 2. Test Categories Overview

| ID | Category | Tests | Automatable | Priority |
|----|----------|-------|-------------|----------|
| A | Text & Content Overflow | 14 | Mostly | High |
| B | Scroll Behavior | 12 | Partially | High |
| C | Sidebar Space Utilization | 15 | Mostly | High |
| D | DnD Core (Grab & Initiate) | 12 | Partially | Critical |
| E | DnD Visual Feedback | 14 | Manual only | Critical |
| F | DnD Drop Targets | 16 | Partially | Critical |
| G | Resize (Duration Change) | 10 | Partially | High |
| H | DnD Edge Cases & Errors | 18 | Partially | Critical |
| I | DnD Performance | 8 | Manual only | High |
| J | Responsive & Viewport | 10 | Mostly | Medium |
| K | Visual Hierarchy & Readability | 12 | Partially | Medium |
| L | Interaction Feedback (Non-DnD) | 14 | Mostly | Medium |
| M | State Edge Cases | 12 | Mostly | Medium |
| N | Feature-Specific Edge Cases | 20 | Mostly | Critical/High |
| +GAP | Gaps found in final review | 8 | Mixed | P1-P2 |
| | **TOTAL** | **195** | | |

---

## Category A — Text & Content Overflow

**Goal:** Every piece of text in the scheduler either fits or truncates gracefully with a way to see the full content.

### Test Scenarios

| ID | Scenario | Steps | Expected | View(s) | Automatable |
|----|----------|-------|----------|---------|-------------|
| A-01 | Short event title fits | Create job "Fix AC" for customer "John". View in Week. | Full title visible, no truncation | Week, Day | Yes |
| A-02 | Long event title truncates with ellipsis | Create job with scope_notes "Emergency HVAC system replacement and full ductwork inspection for commercial building". View in Week, 1-hour slot. | Title truncates with `...`, no overflow outside event block | Week, Day | Yes |
| A-03 | Truncated event shows full text on hover tooltip | Hover over truncated event from A-02 for 350ms. | Tooltip appears showing full job title, customer name, address, time range | Week, Day | Yes — check tooltip visibility |
| A-04 | Long customer name on event block | Job for "Christopher Montgomery-Worthington III". | Name truncates, doesn't push other content off | Week, Day, Grid | Yes |
| A-05 | Long address on event block | Service location: "12345 Northeast Industrial Boulevard Suite 400, Building C". | Address truncates within event card, full text in tooltip | Week, Day, Grid | Yes |
| A-06 | Event title in Month view day cell | View Month with 3+ events on a single day. | Events show abbreviated titles. "+N more" link appears when cells overflow. | Month | Yes |
| A-07 | Sidebar unassigned job — long title | Job for customer "Christopher Montgomery-Worthington" at "12345 NE Industrial Blvd". | Card text truncates, no horizontal scroll in sidebar, no card height explosion | Sidebar | Yes |
| A-08 | Sidebar walkthrough — long lead info | Lead with long customer name + long address. | Same as A-07 for walkthrough cards | Sidebar | Yes |
| A-09 | By-Tech grid event card — short event (30min) | 30-minute event in TechnicianGridView. Card height = 48px. | Shows at minimum: time + job number. Customer/address hidden or in tooltip. No text overflow. | Grid Day | Yes |
| A-10 | By-Tech grid event card — tall event (4hr) | 4-hour event in TechnicianGridView. Card height = 384px. | Shows: time, job#, customer, address, badges. No excessive whitespace. | Grid Day | Yes |
| A-11 | By-Tech week card text | MemberWeekBoard card with long customer + long address. | Card truncates, no width blowout on the column | Grid Week | Yes |
| A-12 | Technician name in grid header | Tech name "Christopher Montgomery" in column header. | Name truncates or wraps within 280px column width. Avatar + name fit. | Grid Day/Week | Yes |
| A-13 | Time label on event block | Week view, 1-hour event 2:00-3:00 PM. | "2:00 PM – 3:00 PM" visible on event block (or at least start time) | Week, Day | Yes |
| A-14 | Job number badge on event | Check JOB-2026-0001 badge is readable on event block at all zoom levels. | Badge fully visible, not cut off | All views | Yes |

---

## Category B — Scroll Behavior

**Goal:** The user is always oriented. The calendar scrolls to the right place at the right time.

| ID | Scenario | Steps | Expected | View(s) |
|----|----------|-------|----------|---------|
| B-01 | Initial load scroll position (Week/Day) | Navigate to /schedule in Week or Day view. | Calendar auto-scrolls to 6 AM (`scrollToTime` is hardcoded to 6:00). The current time indicator (blue line) should be visible without manual scrolling during business hours. **Note:** Implementation uses `new Date(1970, 0, 1, 6, 0, 0)` — verify if this is the desired UX or if it should scroll to current hour. | Week, Day |
| B-02 | Initial load scroll position (Grid Day) | Switch to By-Tech Grid, Day view. | Time axis scrolls to current hour. Not stuck at 6 AM top. | Grid Day |
| B-03 | View switch preserves scroll context | In Week view, scroll to 3 PM. Switch to Day view. | Day view shows approximately 3 PM area, not reset to top. | Week → Day |
| B-04 | Date navigation preserves scroll position | In Week view at 2 PM area. Click Next (>) to go to next week. | Same vertical scroll position (2 PM area), new week's dates. | Week |
| B-05 | DnD does not cause scroll jump | Drag an event from 10 AM to 11 AM in Week view. | Calendar stays stable. No vertical/horizontal scroll jump on drop. | Week, Day |
| B-06 | Auto-scroll during drag (vertical) | Start dragging an event at 2 PM. Move cursor to the very bottom edge of the calendar viewport. | Calendar auto-scrolls downward to reveal later hours (3 PM, 4 PM...). Scroll speed accelerates near edge. | Week, Day |
| B-07 | Auto-scroll during drag (horizontal — Grid) | In By-Tech Grid with 6+ techs. Drag a sidebar job to the right edge. | Grid scrolls horizontally to reveal more technician columns. | Grid Day |
| B-08 | Sidebar scrolls independently | 15+ unassigned jobs in sidebar. Scroll sidebar down. | Main calendar does not scroll. Only the sidebar panel scrolls. | All |
| B-09 | Sidebar scroll vs calendar scroll | Mousewheel over the calendar area with long sidebar. | Only the calendar scrolls, sidebar stays put. No dual-scroll. | All |
| B-10 | After assign from sidebar, calendar shows event | Assign a job from sidebar (click → AssignDialog → confirm) to Thursday 3 PM. | Calendar scrolls/navigates to show the newly placed event. Or at minimum, the event is visible if Thursday is in the current week. | Week |
| B-11 | Month view scroll (no vertical scroll needed) | Switch to Month. Verify. | Month grid fills available space. No vertical scrollbar on the calendar body (only if 6+ weeks shown). | Month |
| B-12 | By-Tech Week board scroll | MemberWeekBoard with 5 techs, many jobs on Monday. | Each tech column scrolls independently. Sticky day headers stay visible. Tech header stays pinned at top. | Grid Week |

---

## Category C — Sidebar Space Utilization

**Goal:** The sidebar efficiently uses its width/height, adapts to content volume, and never wastes space or clips content.

| ID | Scenario | Steps | Expected | View(s) |
|----|----------|-------|----------|---------|
| C-01 | Sidebar width vs calendar width | Load /schedule at 1920x1080. Measure sidebar vs calendar. | Sidebar takes reasonable width (~280-320px). Calendar gets the remaining space. Neither is cramped. | All |
| C-02 | Sidebar collapsed state | Click sidebar collapse button (PanelRightClose). | Sidebar fully collapses. Calendar expands to fill the width. Toggle button remains visible. | All |
| C-03 | Sidebar expand after collapse | Collapse then re-expand sidebar. | Sidebar returns to original width. Calendar resizes. No layout flicker. | All |
| C-04 | Empty sidebar — 0 unassigned jobs, 0 walkthroughs | Ensure all jobs are assigned, all walkthroughs scheduled. | Both sections show success state: checkmark icon + "All jobs are assigned" / "No walkthroughs to schedule". No wasted blank space. | All |
| C-05 | Sidebar with 1 unassigned job | One unassigned job, 0 walkthroughs. | Job card displays. Walkthrough section shows empty state. Section heights adapt — job section doesn't stretch to fill 50% when it only needs one card. | All |
| C-06 | Sidebar with 5 unassigned jobs | 5 unassigned + 0 walkthroughs. | All 5 cards visible without scrolling (if space permits) or clean scroll within section. No excessive padding between cards. | All |
| C-07 | Sidebar with 20+ unassigned jobs | 20 unassigned jobs. | Section scrolls internally. Scroll indicator visible. Sticky section header stays pinned. Card spacing is tight/efficient (not excessive gaps). | All |
| C-08 | Both sections populated | 5 walkthroughs + 5 unassigned jobs. | Both sections visible. **Note:** Walkthrough section is hard-capped at `maxHeight: 40%` (line 1202). Jobs section gets remaining space via `flex-1`. This is NOT proportional — verify the 40% cap doesn't waste space when walkthroughs have few items, and doesn't clip when they have many. | All |
| C-09 | Section collapse (Walkthroughs) | Click walkthrough section header to collapse. | Cards hide with smooth transition. Unassigned jobs section expands to use freed space. | All |
| C-10 | Section collapse (Unassigned Jobs) | Click unassigned section header to collapse. | Cards hide. Walkthrough section expands. | All |
| C-11 | Both sections collapsed | Collapse both sections. | Sidebar shows just two section headers. Minimal height. No blank/dead space below. | All |
| C-12 | Card content efficiency | Inspect a single unassigned job card. | Card shows: job# (+ urgent badge if applicable), customer name, location — all in a compact layout. No excessive padding (more than 8-12px). | All |
| C-13 | Walkthrough card content | Inspect a walkthrough card. | Shows: lead#, customer name, address. Compact. Phone icon clickable. No wasted space. | All |
| C-14 | Sidebar responsive at 1366x768 | Resize viewport to 1366x768. | Sidebar still usable. Cards don't overlap. Text still readable. Sidebar width may shrink but cards adapt. | All |
| C-15 | Sidebar hidden on small viewports | Resize below `lg:` breakpoint (~1024px). | Sidebar hides completely. Calendar takes full width. Sidebar toggle either hidden or opens as overlay. | All |

---

## Category D — Drag-and-Drop Core (Grab & Initiate)

**Goal:** Initiating a drag feels natural, intentional, and works from any draggable source in every view.

| ID | Scenario | Steps | Expected | View(s) |
|----|----------|-------|----------|---------|
| D-01 | Cursor on hover (calendar event) | Hover over a SCHEDULED job event in Week view. | Cursor changes to `grab` (open hand) or `move`. Indicates draggability. | Week, Day |
| D-02 | Cursor on hover (sidebar card) | Hover over unassigned job card in sidebar. | Cursor shows `grab`. Card may slightly elevate (shadow/scale). | Sidebar |
| D-03 | Cursor during active drag | Click + hold + move on a calendar event. | Cursor changes to `grabbing` (closed hand) immediately on movement. | All |
| D-04 | Dead zone before drag starts | Click an event and move cursor 1-2px. | NO drag initiated. This is a click, not a drag. Must move 3-5px before drag engages. Prevents accidental drags. | Week, Day |
| D-05 | Click vs drag distinction | Click (no movement) on an event. | Click popup appears (event detail popover). NOT a drag operation. | All |
| D-06 | Drag event from center of block | Grab a 2-hour event from the middle of its block. Drag to new time. | Drag works from anywhere on the event body — not just a specific handle. | Week, Day |
| D-07 | Drag event from top edge of block | Grab the very top pixel row of an event. Drag. | Drags the whole event (not resize from top). Resize handles are only at very bottom. | Week, Day |
| D-08 | Drag in Month view | In Month view, drag a job from Monday to Wednesday. | Entire event moves from Monday cell to Wednesday cell. Date changes, time preserved. | Month |
| D-09 | Drag in By-Tech Grid (Day) | In TechnicianGridView, drag a job card down 2 hours. | Job moves within same tech column. Time updates. | Grid Day |
| D-10 | Drag sidebar card (native drag API) | Drag an unassigned job card from sidebar. | Card becomes semi-transparent (opacity ~0.4), slight scale-down. A drag image/ghost follows cursor. | Sidebar → Calendar |
| D-11 | Drag a walkthrough event | In Week view, drag a walkthrough event to a new time. | Walkthrough moves. Calls `walkthroughRescheduleMutation`. | Week, Day |
| D-12 | Cannot drag completed/cancelled events | Try to drag a COMPLETED job (0.5 opacity) in Week view. | Drag does NOT initiate. Event is not draggable. Cursor stays `default` on hover. **CODE WARNING:** `draggableAccessor: () => true` (line 1630) makes ALL events draggable. This test WILL FAIL — the implementation doesn't guard completed/cancelled events. File as P0 bug. | All |

---

## Category E — Drag-and-Drop Visual Feedback

**Goal:** During a drag operation, the user has clear, continuous visual feedback about what's happening and where the event will land. Google Calendar benchmark.

| ID | Scenario | Steps | Expected | View(s) |
|----|----------|-------|----------|---------|
| E-01 | Ghost preview follows cursor | Drag event in Week view. Move cursor around. | A semi-transparent preview of the event follows the cursor. It snaps to the time grid (not pixel-perfect mouse tracking). | Week, Day |
| E-02 | Source slot indicator | Drag event from 2 PM Tuesday. | The original 2 PM Tuesday slot remains visible — dimmed outline or lighter color — showing "where it came from". | Week, Day |
| E-03 | Time label updates during drag | Drag event vertically through different hours. | The ghost preview or a nearby label shows the current target time updating live (e.g., "2:00 PM → 3:00 PM" becoming "2:30 PM → 3:30 PM"). | Week, Day |
| E-04 | Snap to time grid | Drag event slowly through 15-minute increments. | Ghost snaps to 15 or 30-minute slots. Not free-floating between grid lines. Movement feels guided. | Week, Day |
| E-05 | Target slot highlight | Drag event over a new time slot. | The target time row/cell gets a subtle highlight (background color change) showing where the event will land. | Week, Day |
| E-06 | Cross-day drag visual | Drag event from Tuesday to Thursday in Week view. | Ghost moves horizontally. Target day column highlights. Clear visual that you're changing the date. | Week |
| E-07 | Sidebar → Calendar drag visual | Drag unassigned job from sidebar into the calendar area. | Calendar shows drop indicator. Nearest time slot highlights. The sidebar card dims/fades. | Week, Day |
| E-08 | Sidebar → Grid drag visual | Drag unassigned job from sidebar into TechnicianGridView. | Target tech column + hour slot shows "Drop here - [time]" label. Blue highlight on drop zone. | Grid Day |
| E-09 | Drag over non-droppable area | Drag event over the sidebar area, or over the header toolbar. | Cursor changes to `not-allowed` or no drop indicator. Clear that you can't drop here. | All |
| E-10 | Drag cancellation visual | Press Escape during a drag. | Ghost disappears. Event returns to original position. No flash/jump. | All |
| E-11 | Ghost event in Plan Mode | Drag sidebar job to calendar while Plan Mode is active. | Ghost event appears with dashed border, 0.55 opacity, "draft" label. Different from normal event placement. | All |
| E-12 | DnD in Month view visual | Drag event across day cells in Month view. | Target day cell highlights. Source cell shows the event dimmed. | Month |
| E-13 | Multiple overlapping events during drag | Drag an event to a slot that already has 2 events. | Ghost appears alongside existing events. Events reflow/stack to make room. Shows that overlap is possible but visible. | Week, Day |
| E-14 | Conflict visual on hover during drag | Drag an event to a time that conflicts with another event on the same tech. | Conflict indicator (orange border/flash) appears on both the ghost and the conflicting event BEFORE you drop. | Week, Day, Grid |

---

## Category F — Drag-and-Drop Drop Targets

**Goal:** You can drag from anywhere to anywhere that makes sense. Every valid combination works. Every invalid combination fails gracefully.

| ID | Scenario | Steps | Expected Result | Expected API Call |
|----|----------|-------|-----------------|-------------------|
| F-01 | Same day, different time | Drag job from Tue 10 AM to Tue 2 PM (Week view) | Event moves. Time updates. | `POST /jobs/:id/assign` with new `scheduled_start/end` |
| F-02 | Different day, same time | Drag job from Tue 10 AM to Thu 10 AM (Week view) | Event moves horizontally. | Same assign call, new date |
| F-03 | Different day, different time | Drag job from Tue 10 AM to Thu 3 PM (Week view) | Diagonal move works. | Same assign call, new date + time |
| F-04 | Same tech, different time (Grid) | TechnicianGridView: drag within one column, 9 AM → 1 PM. | Event moves down. Same tech. | Assign with updated times |
| F-05 | Different tech, same time (Grid) | Drag event from Tech A column to Tech B column, same hour. | Event moves to Tech B's column. Reassignment. | Assign with new `assigned_to` + same times |
| F-06 | Different tech, different time (Grid) | Diagonal drag in Grid: Tech A 9 AM → Tech B 2 PM. | Both tech and time change. | Assign with new `assigned_to` + new times |
| F-07 | Sidebar → Week view calendar | Drag unassigned job from sidebar to Tuesday 11 AM in Week view. | AssignJobDialog opens with date pre-filled (or direct assignment in Plan Mode). Job disappears from sidebar. Event appears on calendar. | Assign with tech + times |
| F-08 | Sidebar → Day view calendar | Drag unassigned job from sidebar to 3 PM slot in Day view. | Same as F-07 but in Day view context. | Assign |
| F-09 | Sidebar → Grid tech column | Drag unassigned job from sidebar to Tech A's 10 AM drop zone. | Job assigned to Tech A at 10 AM. Card removed from sidebar. Event appears in tech column. | Assign with tech + times |
| F-10 | Sidebar → Month view day cell | Drag unassigned job from sidebar to a day cell in Month view. | AssignJobDialog opens with that date. No specific time (Month has no time axis). | Assign |
| F-11 | Calendar → sidebar (unassign) | Drag a scheduled event from calendar back toward the sidebar. | **Implementation note:** The sidebar uses native HTML5 drag for outgoing drags only. The react-big-calendar DnD system cannot emit "drop on sidebar" events. This path is a **no-op** — the event will snap back. Verify it snaps back cleanly with no error. | None (no-op) |
| F-12 | Drop on exact same position | Drag event, then drop on the exact same time slot where it started. | No-op. No API call. No flash. No toast. Event stays put. | None |
| F-13 | Drop outside calendar bounds | Drag event to the header area or outside the browser window. | Drag cancels. Event returns to original position. No error. | None |
| F-14 | Drop onto conflicting slot (same tech, overlapping time) | Drag event to a slot where Tech A already has another job. | Conflict toast appears: shows conflicting event, "Schedule Anyway" + "Cancel" buttons. | If "Schedule Anyway": assign with `force=true`. If "Cancel": revert. |
| F-15 | Sidebar → By-Tech Week board | Drag sidebar job onto a tech's Monday section in MemberWeekBoard. | Job assigned to that tech for Monday. Card appears in tech's Monday list. | Assign |
| F-16 | Cross-week drag (edge day) | In Week view (Mon-Sun), drag from Sunday to... does it let you drag beyond the visible week? | Drag to edge should either auto-scroll to next week's days or stop at the week boundary. No event lost. | Assign if target resolves to valid date |

---

## Category G — Resize (Duration Change)

**Goal:** Resizing events to change duration feels natural and mirrors Google Calendar's resize handles.

| ID | Scenario | Steps | Expected | View(s) |
|----|----------|-------|----------|---------|
| G-01 | Resize handle visible at bottom | Hover over a SCHEDULED event in Week view. | A resize handle (small bar/grabber) appears at the bottom edge of the event block. Cursor changes to `ns-resize`. | Week, Day |
| G-02 | Extend duration (drag bottom down) | Drag resize handle from bottom of 2-hour event downward by 1 hour. | Event expands to 3 hours. End time updates. | Week, Day |
| G-03 | Shorten duration (drag bottom up) | Drag resize handle upward on a 3-hour event, reducing to 1 hour. | Event shrinks. End time moves earlier. | Week, Day |
| G-04 | Time label updates during resize | Drag resize handle slowly. | A live time label shows new end time updating as you drag (e.g., "3:00 PM" → "4:00 PM"). | Week, Day |
| G-05 | Resize snaps to grid | Drag resize handle between time grid lines. | Resize snaps to 15 or 30-minute increments. Not pixel-precise. | Week, Day |
| G-06 | Minimum duration on resize | Try to resize a 1-hour event to less than 15 minutes. | Resize stops at minimum duration (15 or 30 min). Cannot create a zero-height event. **CODE WARNING:** `resizableAccessor: () => true` (line 1632) enables resize on ALL events including completed. Verify completed events cannot be resized. | Week, Day |
| G-07 | Resize top edge (change start time) | Drag the TOP edge of an event upward. | Start time moves earlier, end time stays. Duration increases. (Check if react-big-calendar supports this.) | Week, Day |
| G-08 | Resize in Grid view | In TechnicianGridView, is there a resize handle on event cards? | **Document:** either resize works in grid view, or it's not supported. If not supported, this is a P2 gap. | Grid Day |
| G-09 | Resize triggers API update | Resize event from 2 hours to 3 hours. Check network tab. | Single API call to update `scheduled_end`. Optimistic UI update (instant visual, API in background). | Week, Day |
| G-10 | Resize past midnight | Resize a 10 PM event's bottom edge past midnight. | Either stops at midnight or extends into next day gracefully. No error. No negative duration. | Day |

---

## Category H — DnD Edge Cases & Error States

**Goal:** Every conceivable error or edge case during drag-and-drop is handled gracefully. No orphaned state. No lost data.

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| H-01 | Drag to the past | Drag a SCHEDULED job from tomorrow to yesterday (a date in the past). | **Decide:** Allow (dispatcher may back-fill records) OR block with visual feedback (past dates dimmed, drop rejected). Document the decision. |
| H-02 | Drag a COMPLETED job | Try to initiate drag on a COMPLETED event. | Drag does not start. No cursor change. Event is "locked". |
| H-03 | Drag a CANCELLED job | Same as H-02 for cancelled. | Same — no drag. |
| H-04 | Drag an IN_PROGRESS job | Try to drag an IN_PROGRESS job to different time/tech. | **Implementation note:** Code allows this (no status check in `handleEventDrop`). This may be intentional — dispatchers reschedule in-progress jobs. Document actual behavior. If it works without warning, classify as P2 improvement (add confirmation). |
| H-05 | Network failure on drop | Drag event to new slot. Simulate network offline (DevTools). | Event snaps back to original position after timeout. Error toast: "Failed to reschedule. Please try again." No data corruption. |
| H-06 | 409 Conflict on drop | Drop event onto conflicting slot (backend returns 409). | Conflict toast appears with details. "Schedule Anyway" (force) + "Cancel" (revert). Event reverts visually until user decides. |
| H-07 | Force through conflict | Click "Schedule Anyway" on conflict toast. | Second API call with `force=true`. Event stays at new position. Conflict indicators appear on both events. |
| H-08 | Cancel conflict | Click "Cancel" on conflict toast. | Event smoothly returns to original position. No API call. |
| H-09 | Rapid successive drags | Drag event A to new slot. Before the API resolves, drag event B. | Both mutations fire independently. No race condition. Both events land correctly. |
| H-10 | Drag then immediately undo | Drop event at new slot. Immediately look for undo option. | **Ideal:** Toast with "Undo" button (Google Calendar pattern). **Minimum:** No undo, but optimistic revert is possible via conflict toast. |
| H-11 | Drag during data refetch | While TanStack Query is refetching schedule data, drag an event. | Drag works. Refetch doesn't reset the dragged event's position mid-drag. |
| H-12 | Drag multi-day event (if exists) | If a job spans 2 days (overnight), try dragging it. | Either moves the whole block or disables drag for multi-day events. No partial move. |
| H-13 | Drag with Plan Mode active | In Plan Mode, drag a calendar event (not ghost) to new slot. | Creates a ghost at new position. Original event dims. Shows "moved" ghost with dashed border. |
| H-14 | Discard ghost after drag in Plan Mode | After H-13, right-click the ghost → "Discard". | Ghost disappears. Original event returns to full opacity. No API call. |
| H-15 | Confirm ghost after drag in Plan Mode | After H-13, right-click ghost → "Confirm". | API call fires. Ghost becomes real event. Original position's dimmed event disappears. |
| H-16 | Confirm All with 5+ ghosts | Create 5 ghosts in Plan Mode. Click "Confirm All". | All 5 API calls fire (parallel or sequential). Progress indicator. All ghosts become real events. Sidebar updates. |
| H-17 | Browser tab close during Plan Mode with ghosts | Create ghosts, then close the tab. Reopen /schedule. | Plan mode state restored from localStorage? Or clean slate? **Document current behavior.** |
| H-18 | Drop at exact slot boundary | Drop event at exactly 2:00:00 PM (not 2:15 or 1:45). | Event starts at exactly 2:00 PM. No off-by-one to 1:45 or 2:15. |

---

## Category I — DnD Performance

**Goal:** Drag-and-drop stays fluid at 60fps even under load. No perceivable lag.

| ID | Scenario | Measurement Method | Expected |
|----|----------|--------------------|----------|
| I-01 | Drag initiation latency | Chrome DevTools Performance tab → mousedown to first ghost frame. | < 16ms (1 frame). No perceptible delay. |
| I-02 | Drag frame rate (light load) | 10 events visible. Drag one event across the calendar. Record FPS via DevTools. | Steady 60fps. No drops below 30fps. |
| I-03 | Drag frame rate (heavy load) | 50+ events visible. Drag one event. Record FPS. | Stays above 30fps. Ideally 60fps. |
| I-04 | Drop commit speed (optimistic) | Drop event. Measure time between drop and visual settlement. | Instant visual update (optimistic). No spinner. API resolves in background. |
| I-05 | Drop commit speed (actual API) | Network tab: time from drop to API response. | < 500ms. If longer, optimistic update masks it. |
| I-06 | Sidebar drag start latency | Drag card from sidebar. Time from mousedown+move to ghost appearance. | < 50ms. Native drag API should be near-instant. |
| I-07 | Grid view drag with 8+ tech columns | 8 technicians visible in TechnicianGridView. Drag event across columns. | Smooth scrolling and snapping. No jank from many DOM nodes. |
| I-08 | Rapid view switches after drag | Drag, drop, immediately switch from Week to Day to Grid. | No stale ghosts. No phantom events. View rebuilds cleanly. |

---

## Category J — Responsive & Viewport

| ID | Scenario | Viewport | Expected |
|----|----------|----------|----------|
| J-01 | Full HD layout | 1920x1080 | Calendar fills space. Events readable. Sidebar visible. No wasted space. |
| J-02 | Common laptop | 1440x900 | All functional. Events may be narrower. Sidebar may be tighter. |
| J-03 | Small laptop | 1366x768 | Sidebar may auto-collapse or shrink. Events still readable. No horizontal scrollbar on calendar. |
| J-04 | Tablet landscape | 1024x768 | Sidebar hidden (below `lg:` breakpoint). Calendar full-width. |
| J-05 | Short events at small viewport | 1366x768, 30-min events. | Events still clickable (minimum height ~20px). Not invisible. |
| J-06 | Many techs in Grid at 1366px | 1366x768, 6+ technicians in Grid Day. | Horizontal scroll works. Columns don't compress below readable width (280px). |
| J-07 | Month view at 1366x768 | Small viewport, Month view with busy weeks. | "+N more" overflow works. Day cells don't collapse. |
| J-08 | Sidebar + calendar at 1024px | Exactly at `lg:` breakpoint. | Clean transition — sidebar either shows or hides cleanly, no half-state. |
| J-09 | Browser zoom 125% | 1920x1080 at 125% zoom. | Layout adapts. No overlapping elements. Events still draggable. |
| J-10 | Browser zoom 150% | 1920x1080 at 150% zoom. | Usable but tight. No broken layouts. DnD still works. |

---

## Category K — Visual Hierarchy & Readability

| ID | Scenario | What to Check | Expected |
|----|----------|---------------|----------|
| K-01 | Status color distinction | View Week with SCHEDULED (blue), IN_PROGRESS (green), COMPLETED (gray) events side by side. | All three clearly distinguishable at a glance. No two look the same. |
| K-02 | Urgent vs normal job | URGENT job (red badge + Zap icon) next to normal SCHEDULED job. | Urgent job clearly stands out. Red + icon is obvious. |
| K-03 | Walkthrough vs job | Walkthrough event (amber) next to job event (blue). | Clearly different entity types. Color + icon differentiation. |
| K-04 | Conflict indicator visibility | Two overlapping events with orange conflict border. | Orange border/glow is noticeable. Not subtle. User sees "something's wrong here". |
| K-05 | Ghost event vs real event | Plan Mode ghost (dashed, 0.55 opacity) next to a real event. | Ghost is obviously provisional. "Draft" label readable. |
| K-06 | Font size on event blocks | Read event titles at normal viewing distance (arm's length from monitor). | Text is >= 11px. Readable without squinting. Bold job number, regular customer name. |
| K-07 | Contrast ratio on colored backgrounds | Blue event bg (#3B82F6) with white text. Green event bg with white text. | WCAG AA contrast ratio (4.5:1 for normal text, 3:1 for large text). |
| K-08 | Current time indicator | Blue "now" line in Week/Day view. | Clearly visible. Extends full width. Not hidden behind events. |
| K-09 | Today highlight | Today's column in Week view. | Subtle but visible highlight (different background shade). |
| K-10 | Grid view hour markers | TechnicianGridView time axis labels (6 AM, 7 AM...). | All labels readable. Consistent size. Aligned with grid lines. |
| K-11 | Sidebar section visual weight | Walkthroughs (amber bg) vs Unassigned Jobs (slate bg) headers. | Sections are visually distinct. Counts badges prominent. |
| K-12 | Legend readability | Legend section (walkthrough + completed indicators). | Legend items are clear. Colors match actual event colors. |

---

## Category L — Interaction Feedback (Non-DnD)

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| L-01 | Event hover tooltip (350ms delay) | Hover over event, wait 350ms. | Tooltip appears with: title, customer, address, time, status. No flicker. |
| L-02 | Tooltip dismissal | Move cursor away from event. | Tooltip disappears immediately. |
| L-03 | Click event popup (Google Calendar style) | Click on an event. | Detail popup appears below mouse position. Shows full info + "View Job" button. |
| L-04 | Click popup positioning at edges | Click an event at the very right edge of the calendar. | Popup repositions to stay within viewport. Not clipped off-screen. |
| L-05 | Context menu (right-click event) | Right-click a SCHEDULED job. | Menu: "Open Job Details", "Reassign/Reschedule", "Mark In Progress", "Cancel Job". |
| L-06 | Context menu positioning at edges | Right-click event at bottom-right corner. | Menu repositions to stay within viewport. |
| L-07 | Context menu dismissal | Open context menu, then click elsewhere. | Menu closes. No orphaned menus. |
| L-08 | Keyboard shortcut: T (Today) | Press T key. | Calendar navigates to today's date. |
| L-09 | Keyboard shortcut: 1/2/3 (views) | Press 1, then 2, then 3. | Switches to Day, Week, Month views respectively. |
| L-10 | Keyboard shortcut: G (Group) | Press G key. | Toggles By-Tech/Member view on/off. |
| L-11 | Keyboard shortcut: Escape | Open popup/menu/tooltip, press Escape. | All popups/menus close. |
| L-12 | Loading state | Navigate to /schedule with slow network (DevTools throttle). | Spinner or skeleton visible while data fetches. Calendar structure visible (not blank page). |
| L-13 | Conflict toast actions | Trigger conflict. Verify toast. | Toast has clear conflicting event list, "Schedule Anyway" is blue, "Cancel" is gray. Auto-dismiss after ~10s if no action. |
| L-14 | Plan Mode banner visibility | Activate Plan Mode. | Blue banner clearly visible. Pulsing indicator. Ghost count updates as you add ghosts. |

---

## Category M — State Edge Cases

| ID | Scenario | Setup | Expected |
|----|----------|-------|----------|
| M-01 | Empty calendar (no events) | No jobs, no walkthroughs. | Calendar grid renders. No events. Empty state overlay: CalendarX2 icon + **"No jobs scheduled this week"** (line 1603) + helper text "Drag a job from the panel on the left to assign it". No error. |
| M-02 | Single technician in By-Tech | Only 1 tech user. Switch to By-Tech Grid. | Single column. No wasted space on the right. Column width may expand. |
| M-03 | 10+ technicians in By-Tech | 10 techs. Switch to By-Tech Grid. | Horizontal scroll. All tech columns same width (280px). Scroll is smooth. |
| M-04 | Overlapping events (same tech, same time) | 3 jobs assigned to Tech A at 2 PM. | Events stack horizontally within the time slot. All visible (maybe narrower). Click each one individually. |
| M-05 | Past events | View last week's schedule. | Past events visible (possibly dimmed). COMPLETED events at 0.5 opacity. Not editable. |
| M-06 | All-day event (if possible) | Job with no specific start/end time, just a date. | Shows in all-day row at top, or defaults to a reasonable time slot. |
| M-07 | Event at midnight boundary | Job scheduled 11 PM to 1 AM next day. | Either shows as a multi-day event, or clips at midnight in Day view. No crash. |
| M-08 | Very long event (8+ hours) | Full-day job 8 AM to 5 PM. | Event block stretches correctly. Text repeats or is placed at top. No visual overflow. |
| M-09 | Very short event (15 min) | 15-minute job. | Event block has minimum visible height (~20px). Clickable. Job # visible. |
| M-10 | Refresh during Plan Mode | F5 while Plan Mode active with 3 ghosts. | Plan Mode restores from localStorage. Ghosts reappear. No data loss. |
| M-11 | Two tabs open | Open /schedule in two browser tabs. Drag event in Tab 1. | Tab 2 eventually shows updated state (on next refetch). No conflict between tabs' localStorage plan mode. |
| M-12 | Open/All filter toggle | Toggle from "Open" to "All". | Completed/cancelled events appear (0.5 opacity). Toggle back hides them. No flash/reflow. |

---

## Category N — Feature-Specific Edge Cases (QA Review Additions)

**Goal:** Cover implementation-specific behaviors discovered during code review that don't fit neatly into the generic UI categories above. These are real code paths with real risk.

### N-A: Completed/Cancelled Event Protection (P0 — DATA INTEGRITY)

**Root cause:** `draggableAccessor: () => true` and `resizableAccessor: () => true` (SchedulePage.tsx lines 1630-1632) make ALL events draggable and resizable, regardless of status. The `handleEventDrop` and `handleEventResize` handlers do NOT check event status before firing mutations.

| ID | Scenario | Steps | Expected | Priority |
|----|----------|-------|----------|----------|
| N-01 | Drag COMPLETED event and drop at new time | Toggle to "All" view. Drag a COMPLETED event (0.5 opacity) to a new time slot. Release. | **Should be blocked.** If not, the assign mutation fires, re-scheduling a completed job. This is a P0 data integrity bug. | P0 |
| N-02 | Drag CANCELLED event and drop | Same as N-01 for CANCELLED event. | **Should be blocked.** Same risk. | P0 |
| N-03 | Resize COMPLETED event | Toggle to "All". Drag the resize handle on a COMPLETED event. | **Should be blocked.** If not, the event's duration changes on a completed job. | P0 |
| N-04 | Resize CANCELLED event | Same as N-03 for CANCELLED. | **Should be blocked.** | P0 |

### N-B: Slot Popover (Empty Slot Click)

**Root cause:** `handleSelectSlot` (line 1119) opens a `slotPopover` when clicking empty calendar slots. This entire flow is untested.

| ID | Scenario | Steps | Expected | Priority |
|----|----------|-------|----------|----------|
| N-05 | Click empty time slot shows popover | In Week view, click an empty slot at 2 PM Tuesday. | Popover appears at click position showing the selected time range. | P1 |
| N-06 | Slot popover dismisses on Escape | Open slot popover, press Escape. | Popover closes. | P2 |
| N-07 | Slot popover dismisses on outside click | Open slot popover, click elsewhere. | Popover closes. | P2 |
| N-08 | Slot popover does NOT open during drag | Start dragging a sidebar card over the calendar. Click/release should not trigger slot popover. | No popover. (Code checks `draggingJobIdRef.current` at line 1121.) | P1 |

### N-C: Search → Highlight Flow

**Root cause:** `ScheduleSearch` → `handleSearchSelect` → `highlightedEventId` → pulsing `search-highlight` animation. Zero coverage.

| ID | Scenario | Steps | Expected | Priority |
|----|----------|-------|----------|----------|
| N-09 | Search and select a job | Type a job number in ScheduleSearch. Select from dropdown. | Calendar navigates to the event's date. Event pulses with blue box-shadow (`search-highlight` animation). | P1 |
| N-10 | Search highlight clears | After N-09, click anywhere or wait. | Highlight animation stops. Event returns to normal styling. | P2 |

### N-D: Role-Based UI Restrictions

| ID | Scenario | Steps | Expected | Priority |
|----|----------|-------|----------|----------|
| N-11 | Plan Mode hidden for TECHNICIAN | Log in as TECHNICIAN. Navigate to /schedule. | Plan Mode button is NOT visible. | P1 |
| N-12 | Plan Mode hidden for SALES | Log in as SALES. Navigate to /schedule. | Plan Mode button is NOT visible. | P1 |

### N-E: Staff Filter & View Constraints

| ID | Scenario | Steps | Expected | Priority |
|----|----------|-------|----------|----------|
| N-13 | Staff filter: Technicians only | In By-Tech Grid, select "Technicians" from dropdown. | Only technician columns visible. Sales user columns removed. | P1 |
| N-14 | Staff filter: Sales only | Select "Sales". | Only sales user columns visible. | P1 |
| N-15 | Month button hidden in grouped view | Switch to Member View. Check view switcher. | Month button is gone. Only Day + Week available. Switch back to Standard — Month returns. | P1 |

### N-F: Sidebar-Specific Actions

| ID | Scenario | Steps | Expected | Priority |
|----|----------|-------|----------|----------|
| N-16 | "No Walkthrough Needed" action | Right-click walkthrough card → "No Walkthrough Needed". | `noWalkthroughMutation` fires. Card removed from sidebar. Walkthrough count decrements. Lead updated (`walkthrough_needed: false`). | P1 |
| N-17 | Walkthrough 40% height cap behavior | Create 15 unscheduled walkthroughs + 15 unassigned jobs. | Walkthrough section scrolls internally within its 40% cap. Jobs section uses remaining 60%. Neither overflows. | P1 |

### N-G: Overlay Stacking & Dismissal

**Root cause:** 6+ independently positioned overlays can appear: tooltip (z-60), click popup, context menu, ghost context menu, sidebar context menu, conflict toast, error toast, slot popover. The `useEffect` at line 528 handles some dismissals but not all combinations.

| ID | Scenario | Steps | Expected | Priority |
|----|----------|-------|----------|----------|
| N-18 | Tooltip → right-click = tooltip dismissed | Hover event (tooltip appears). Right-click same event. | Tooltip dismissed (line 559 clears it). Context menu appears. No overlap. | P1 |
| N-19 | Click popup → right-click another event | Click event A (popup appears). Right-click event B. | Click popup dismissed. Context menu for event B appears. | P1 |
| N-20 | Off-hours visual dimming | In Day view, check 6 AM area and 8 PM area. | Hours < 7 AM and >= 7 PM have lighter background (`#F8FAFC`). Business hours (7 AM – 7 PM) have normal white background. | P2 |

---

## Gap Scenarios (Added After Final Review)

Discovered during the product lead's final review — these scenarios were missing from the original categories.

| ID | Scenario | Steps | Expected | Category | Priority |
|----|----------|-------|----------|----------|----------|
| L-05b | Context menu "Mark In Progress" action works | Right-click SCHEDULED job → click "Mark In Progress". | Job status changes to IN_PROGRESS. Event color changes to green. API call succeeds. | L | P1 |
| L-05c | Context menu "Reassign" opens dialog | Right-click SCHEDULED job → click "Reassign/Reschedule". | AssignJobDialog opens with current job data pre-filled. | L | P1 |
| F-07b | AssignJobDialog pre-fill after sidebar DnD | Drag unassigned job from sidebar to Tuesday 2 PM. Dialog opens. | Dialog has Tuesday's date in the start field. Time is ~2 PM. If in grouped view, tech is pre-selected. | F | P1 |
| G-11 | Resize a walkthrough event | In Week view, resize a walkthrough event's bottom handle downward. | Duration increases. API calls `walkthroughRescheduleMutation` (not `assignMutation`). `walkthrough_duration_minutes` updated. | G | P1 |
| H-19 | Plan Mode full lifecycle (end-to-end) | Enter Plan Mode → drag 3 sidebar jobs to calendar → drag one ghost to a new time → right-click one ghost → Discard → click "Confirm All" → exit Plan Mode. | Each step works in sequence. Final state: 2 real events on calendar, 1 discarded, Plan Mode deactivated, sidebar cards removed for confirmed items. | H | P1 |
| N-21 | Right sidebar stats accuracy | Open right sidebar. Check "Walkthroughs", "Unassigned Jobs", "Scheduled today", "Conflicts" numbers. | Numbers match actual sidebar card counts and calendar event counts. Conflict count matches orange-bordered events. | N | P1 |
| N-22 | Search edge cases | Type "zzzznonexistent" in ScheduleSearch. Also test empty string. Also test search while Plan Mode active. | No results: empty dropdown or "No results" message. No crash. Plan Mode doesn't interfere with search. | N | P2 |
| N-23 | Walkthrough card click navigation | Click a walkthrough card in the sidebar. | Navigates to `/leads/{id}?tab=walkthrough`. The walkthrough tab is active on the Lead Detail page. | N | P1 |

---

## Existing E2E Coverage Map

Tests that already exist (do NOT duplicate):

| Existing Spec | What It Covers |
|---------------|----------------|
| `wt-schedule-sidebar.spec.ts` | Page loads, sidebar sections visible, walkthrough cards show info, collapse works, stats counts |
| `wt-schedule-views.spec.ts` | Member View button, Plan Mode button + banner + actions, Open/All filter, legend |

**Gaps (new specs needed):**
- All DnD scenarios (D, E, F, G, H)
- Text overflow (A)
- Scroll behavior (B)
- Sidebar space utilization beyond basic visibility (C-04 through C-15)
- Responsive testing (J)
- Visual hierarchy (K)
- Performance (I — manual only)
- Full interaction feedback (L — partial overlap with existing)
- State edge cases (M)
- Feature-specific edge cases from QA review (N) — **includes P0 data integrity bugs**

---

## Priority Matrix

### P0 — Must Fix Before Ship (Blockers)

| Category | IDs | Rationale |
|----------|-----|-----------|
| **N — Completed Event Protection** | **N-01, N-02, N-03, N-04** | **HIGHEST PRIORITY.** `draggableAccessor: () => true` and `resizableAccessor: () => true` allow drag/resize on completed/cancelled events. `handleEventDrop`/`handleEventResize` don't check status — mutation fires, re-scheduling completed jobs. Data integrity risk. |
| D — DnD Core | D-04, D-05, D-12 | Click vs drag distinction is fundamental. D-12 will fail due to `draggableAccessor` bug above. |
| F — Drop Targets | F-01 through F-09, F-12, F-14 | Core drag paths must all work. Same-slot no-op prevents wasted API calls. Conflict handling is critical. |
| H — Edge Cases | H-02, H-03, H-05, H-06, H-07, H-08 | Completed/cancelled lock (will fail — same root cause as N-01), network failure recovery, conflict flow. |

### P1 — Must Fix Before Launch (Usability)

| Category | IDs | Rationale |
|----------|-----|-----------|
| A — Text | A-02, A-03, A-09 | Truncation + tooltip is basic readability. Short events are common. |
| B — Scroll | B-01, B-02, B-05, B-08 | Initial scroll position and DnD scroll stability are daily-use issues. |
| C — Sidebar | C-04, C-06, C-07, C-08, C-12 | Space efficiency directly impacts dispatcher workflow. C-08 verifies the 40% height cap. |
| E — DnD Visual | E-01, E-02, E-04, E-07, E-08 | Ghost preview, snap, and sidebar-to-calendar feedback are what makes DnD feel "Google-like". |
| G — Resize | G-01, G-02, G-03, G-06 | Resize is the second most-used gesture after move. |
| I — Performance | I-01, I-02, I-04 | Lag on drag initiation or drop is immediately noticeable. |
| N — Slot/Search/Roles | N-05, N-08, N-09, N-11, N-12, N-13, N-14, N-15, N-16, N-17, N-18, N-19 | Slot popover, search highlight, role restrictions, staff filter, sidebar actions, overlay stacking. |

### P2 — Polish Before v1.0

| Category | IDs | Rationale |
|----------|-----|-----------|
| E — DnD Visual | E-03, E-05, E-06, E-14 | Live time labels and conflict preview during drag are delighters. |
| G — Resize | G-07, G-08, G-10 | Top-edge resize and grid resize are nice-to-have. |
| H — Edge Cases | H-10, H-17 | Undo toast and tab-close recovery are polish. |
| J — Responsive | All | Dispatcher uses desktop primarily. Mobile is Step 7. |
| K — Visual | All | Readability audit is polish unless contrast fails WCAG. |
| L — Interactions | L-04, L-06 | Edge-positioning of popups is polish. |
| M — State | M-06, M-07, M-11 | Rare edge cases. |
| N — Polish | N-06, N-07, N-10, N-20 | Slot popover dismissal, search highlight clear, off-hours dimming. |

---

## Execution Order

1. **Phase 0 (Day 1 — URGENT):** Category N-A (N-01 through N-04) — completed/cancelled event protection. Run immediately. These are likely P0 bugs that need developer fix before broader testing.
2. **Phase 1 (Week 1):** Categories D + F + H + N-B/N-G (DnD core, drop targets, edge cases, slot popover, overlay stacking) — manual walkthrough + Playwright specs
3. **Phase 2 (Week 1-2):** Categories A + B + C + N-E/N-F (visual/layout, staff filter, sidebar actions, height cap) — Playwright screenshot tests + manual audit
4. **Phase 3 (Week 2):** Categories E + G + I + N-C (DnD feel, resize, performance, search highlight) — primarily manual, video recordings
5. **Phase 4 (Week 2-3):** Categories J + K + L + M + N-D (responsive, visual, interactions, role restrictions, polish) — automated responsive tests + manual contrast checks

---

## QA Review Notes (2026-03-17)

### Known Implementation Facts That Affect Testing

1. **`draggableAccessor: () => true`** (line 1630) — ALL events are draggable regardless of status. Tests D-12, H-02, H-03, N-01, N-02 will fail. This is the top-priority bug to fix.
2. **`resizableAccessor: () => true`** (line 1632) — Same issue for resize. N-03, N-04 will fail.
3. **`scrollToTime` = 6 AM** (line 611) — Not current time. B-01 expected behavior updated.
4. **Walkthrough section `maxHeight: 40%`** (line 1202) — Not proportional. C-08 expected behavior updated.
5. **Empty state text: "No jobs scheduled this week"** (line 1603) — Not "No scheduled events". M-01 updated.
6. **F-11 (drag to sidebar) is a no-op** — react-big-calendar DnD doesn't emit drop events on external HTML elements.
7. **H-04 (drag IN_PROGRESS) is allowed** — no status check in `handleEventDrop`. May be intentional.
8. **`handleSelectSlot`** (line 1119) shows slot popover on empty click — completely untested before this review.
9. **6 overlay layers** can appear simultaneously — tooltip, popup, context menu, ghost context menu, sidebar context menu, slot popover, conflict toast, error toast.
10. **Plan Mode role restriction** — `canPlanMode` only true for ADMIN/DISPATCHER. Never tested with other roles.

---

*End of test plan. Next step: run Phase 0 (N-01 through N-04) to confirm the completed event protection bug, then begin Phase 1.*
