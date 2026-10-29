# Role: UI/UX Designer — "The Judge"

## Identity

**Title:** UI/UX Designer
**Seniority:** Mid-Senior (3-6 years in product design, at least 1 year designing scheduling/operations interfaces)
**Reports to:** Product Lead
**Allocation:** 3 scheduled sessions across 2 weeks (~4-5 hours total)

## Profile

### Must-Have Qualifications
- Owns or is deeply familiar with the ALPHA CRM design system (colors, typography, spacing, component library)
- Has designed or evaluated drag-and-drop interfaces before
- Knows the Tailwind tokens in `tailwind.config.js` and the design system documented in `CLAUDE.md`
- Can evaluate visual hierarchy at a glance: "this badge is competing with the title," "these two colors are too similar"
- Understands WCAG 2.1 AA accessibility requirements: contrast ratios (4.5:1 text, 3:1 large text), minimum touch targets (44x44px)
- Can articulate design decisions with reasoning: "the 40% height cap on walkthroughs is correct because in the typical workflow, dispatchers interact with unassigned jobs 3x more than walkthroughs"

### Nice-to-Have
- Experience with FSM/dispatch software UIs (ServiceTitan, Jobber, Google Calendar for business)
- Figma proficiency (for quick mockups of suggested fixes)
- Understanding of CSS implementation constraints (what's easy vs hard to fix)

### Personality Traits
- **Decisive.** Doesn't waffle on subjective calls — "this amber is too close to the orange conflict border, change the walkthrough to a golden-yellow (#D97706)" not "hmm, maybe consider adjusting the color"
- **Empathetic to the dispatcher.** Thinks about the daily 8-hour session: eye strain, information density, scan patterns
- **Realistic about scope.** Distinguishes "this must be fixed before launch" from "this would be nice in v2"
- **Respectful of engineering effort.** Doesn't request pixel-perfect redesigns during a QA sprint — focuses on impactful, achievable improvements

---

## Responsibilities

This role has three scheduled sessions. Each session has a specific purpose and deliverable.

---

### Session 1: Calibration (Day 1, 1 hour)

**Purpose:** Set the visual quality bar so the manual tester knows what "good" and "bad" look like.

**Attendees:** Designer + Manual Tester + Product Lead

**Agenda:**

| Time | Activity |
|------|----------|
| 0:00 | Open the scheduler at 1920x1080. Walk through Week, Day, Month, Grid Day, Grid Week views together. |
| 0:10 | **Color review.** Identify every distinct color used: SCHEDULED blue, IN_PROGRESS green, COMPLETED gray, walkthrough amber, urgent red, conflict orange, ghost dashed. Are they distinguishable? Name any that are too similar. |
| 0:20 | **Typography review.** Read event blocks at arm's length. Are job numbers bold enough? Is 11px too small? Can you read customer names? |
| 0:30 | **Spacing review.** Look at sidebar card padding, event block margins, header toolbar crowding. Identify anything that feels cramped or wasteful. |
| 0:40 | **DnD feel (live demo).** Drag a few events with Google Calendar open side-by-side. Calibrate the tester on what "natural" means. |
| 0:50 | **Q&A.** Tester asks "is X acceptable?" questions. Designer gives binary answers. |

**Deliverable:** A calibration checklist (written by the designer, 1 page max) that the tester uses as their "eye" for the rest of the sprint. Example:

```
PASS criteria:
- Event text readable at arm's length without squinting
- Status colors distinguishable without looking at the legend
- Drag ghost visible and follows cursor (not lagging)
- Sidebar cards compact but not cramped (8-12px padding is correct)
- Truncated text always has tooltip with full content

FAIL criteria:
- Two event types that look the same color
- Text smaller than 11px on event blocks
- Padding > 16px on sidebar cards (wasted space)
- No tooltip on truncated text
- Ghost doesn't snap to grid
```

---

### Session 2: Finding Review (Day 5 — End of Week 1, 1.5 hours)

**Purpose:** Review all P1 and P2 findings from week 1. Make design decisions. Prioritize the fix list for week 2.

**Attendees:** Designer + Manual Tester + Frontend Developer + Product Lead

**Agenda:**

| Time | Activity |
|------|----------|
| 0:00 | Tester presents the top 10 findings (sorted by severity, with videos). |
| 0:30 | **For each finding, designer makes a call:** |
|      | - "Fix it this way" (provides specific direction: exact color, pixel value, behavior) |
|      | - "Acceptable — close as won't-fix" (with documented reasoning) |
|      | - "Defer to v2" (not worth fixing in this sprint but should be tracked) |
| 1:00 | Review automated test screenshots at all 3 viewports. Flag any layout issues the specs missed. |
| 1:15 | **Priority stack-rank** the fix list for week 2. Developer confirms feasibility. |
| 1:25 | Any design system updates needed? (New color token, spacing adjustment, component tweak) |

**Deliverable:** Annotated finding list with designer decisions. Each finding gets one of:
- `FIX: [specific instruction]`
- `ACCEPT: [reason]`
- `DEFER: [reason, track in backlog]`

---

### Session 3: Final Sign-Off (Day 10 — End of Week 2, 1 hour)

**Purpose:** Approve or reject the scheduler's visual quality for launch readiness.

**Attendees:** Designer + Product Lead (tester and dev on standby for questions)

**Agenda:**

| Time | Activity |
|------|----------|
| 0:00 | Review before/after screenshots for every fixed P1 finding. |
| 0:15 | Live walkthrough of the scheduler at 1920x1080 and 1366x768. |
| 0:30 | DnD feel check: drag 5 events in Week view, 3 in Grid view, 2 sidebar-to-calendar. |
| 0:40 | Sidebar review: content density, empty states, collapse behavior. |
| 0:50 | **Verdict:** Approved / Approved with caveats / Blocked (list remaining issues). |

**Deliverable:** Signed-off statement:
```
Scheduler UI/UX — Final Design Review
Date: YYYY-MM-DD
Verdict: [APPROVED / APPROVED WITH CAVEATS / BLOCKED]
Reviewer: [Designer Name]

Remaining items (if any):
- [P2 item deferred to v2]
- [Minor polish tracked in backlog]

Notes:
[Any overall impressions, positive or negative]
```

---

## Tools

| Tool | Purpose | Required |
|------|---------|----------|
| Chrome (latest) | View the live app | Yes |
| Design system reference (`tailwind.config.js`, `CLAUDE.md` Design System section) | Verify tokens are applied correctly | Yes |
| Color contrast checker (WebAIM Contrast Checker or browser extension) | WCAG AA validation | Yes |
| Figma / design tool | Quick mockups if a fix needs visual direction | Nice-to-have |
| Google Calendar | Benchmark reference | Yes |

---

## What to Evaluate

### Category K — Visual Hierarchy & Readability (Your Primary Domain)

| ID | What You Decide |
|----|----------------|
| K-01 | Are SCHEDULED / IN_PROGRESS / COMPLETED distinguishable? Which specific colors need adjustment? |
| K-02 | Does the urgent badge stand out enough? Too much? |
| K-03 | Walkthrough vs job — can you tell them apart in 0.5 seconds? |
| K-04 | Conflict indicator — is the orange noticeable enough? Should it pulse/animate? |
| K-05 | Ghost event — does it clearly read as "provisional"? Is 0.55 opacity enough? |
| K-06 | Font sizes — is 11px the right floor? Should job numbers be bolder? |
| K-07 | Contrast ratios — do any color/text combos fail WCAG AA? Which ones? |
| K-08 | Current time indicator — is the blue line visible enough? Should it be thicker? |
| K-09 | Today highlight — is the column shading too subtle or too strong? |
| K-10 | Grid view time axis — are the labels aligned and readable? |
| K-11 | Sidebar headers — do walkthroughs (amber) and jobs (slate) feel distinct enough? |
| K-12 | Legend — do the swatches match the actual event colors? |

### Cross-Category Design Decisions Only You Can Make

| Topic | Question |
|-------|----------|
| **Truncation strategy** | When text truncates, should we show 1 line or 2 lines before ellipsis? Should short events (30 min) show only job number, or also customer? |
| **Sidebar card density** | Is p-2.5 the right padding? Should cards be tighter (p-2) or more spacious (p-3)? |
| **Empty state messaging** | Is "No jobs scheduled this week" the right message? Should it be more encouraging ("Drag a job to get started")? |
| **Off-hours dimming** | Is `#F8FAFC` subtle enough? Should it be more distinct? |
| **DnD ghost appearance** | Should the drag ghost show the full event card or just the job number pill? (Currently it's a blue pill with job number.) |
| **Conflict indicator timing** | Should the orange conflict border show *during* drag (before drop) or only *after* drop? |
| **Walkthrough section cap** | Is 40% the right max-height for the walkthrough sidebar section? Or should it be dynamic? |

---

## Behavior Expectations

### DO
- Give specific, actionable feedback: "Change the walkthrough amber from `#F59E0B` to `#D97706` for better contrast with the conflict orange"
- Decide quickly during sessions — don't create homework for yourself between sessions
- Bring Google Calendar open on your phone or second screen during every session
- Consider the dispatcher's daily experience: 8 hours on this screen, 100+ drag operations, constant context switching between technicians
- Trust the manual tester's severity assessment — they've been staring at this for days

### DON'T
- Don't request redesigns that would require more than 2-4 hours of dev work per item during this sprint
- Don't evaluate animations at this stage (motion design is v2) — focus on static visual quality and basic interaction feedback
- Don't nitpick spacing by 1-2px — focus on issues visible at arm's length
- Don't attend more than the 3 scheduled sessions — your value is fresh perspective, not daily immersion
- Don't override the manual tester's P0/P1 classification based on aesthetic preference — severity is about user impact, not design opinion

---

## Escalation Path

1. **Disagree with a fix direction:** Your design decision is final for visual matters. If the developer says "too hard," the Product Lead arbitrates scope, not the design direction.
2. **Finding something the test plan missed:** Tell the manual tester to add it. Don't file it yourself — keep the reporting consistent.
3. **Design system change needed:** If a fix requires a new Tailwind token or component variant, specify it exactly. The developer implements it. Don't wait for a design system update cycle — this is a sprint.
4. **Final sign-off blocked:** If you can't approve, list the exact blocking items with fix instructions. The team gets 1 extra day to address them, then you re-review.
