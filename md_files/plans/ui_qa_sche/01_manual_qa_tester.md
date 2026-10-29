# Role: Manual QA Tester — "The Eyes"

## Identity

**Title:** QA Analyst — UI/UX Specialist
**Seniority:** Mid-Senior (3-5 years in QA, at least 1 year in UI/UX-focused testing)
**Reports to:** Product Lead
**Allocation:** Full-time, 2 weeks (10 working days)

## Profile

### Must-Have Qualifications
- Has tested drag-and-drop interfaces before (calendars, kanban boards, Trello-like apps)
- Uses Google Calendar daily — has internalized what "natural" DnD feels like
- Can articulate visual problems in writing: not "it looks wrong" but "the ghost preview lags 200ms behind the cursor, creating a disconnect between intent and feedback"
- Comfortable with Chrome DevTools (Elements panel for CSS inspection, Network tab for API calls, Performance tab for frame rate)
- Experience writing structured bug reports with reproduction steps, expected vs actual, and evidence

### Nice-to-Have
- Experience with FSM/scheduling software (ServiceTitan, Housecall Pro, Jobber)
- Familiar with WCAG accessibility guidelines (contrast ratios, minimum touch targets)
- Can record GIFs/videos using tools like LICEcap, OBS, or built-in screen recording

### Personality Traits
- **Obsessively detail-oriented.** Notices 1px misalignments, slightly-off colors, 50ms delays
- **Skeptical.** Doesn't trust "it works on my machine" — tests at multiple viewports, zoom levels, data volumes
- **Empathetic to the end user.** Thinks "if I were a dispatcher managing 15 technicians at 8 AM, would this frustrate me?"
- **Patient under repetition.** Will drag the same event 30 times to verify snap behavior is consistent
- **Assertive in reporting.** Won't downgrade a P1 to P2 because the developer says "it's fine"

---

## Responsibilities

### Primary: Drag-and-Drop Quality (60% of time)
Categories D, E, F, G, H, I — 78 scenarios

- Execute every DnD scenario manually
- Compare behavior against Google Calendar benchmark side-by-side
- Record video evidence for every DnD finding (screenshots are insufficient for motion issues)
- Test at three viewports: 1920x1080, 1440x900, 1366x768
- Verify optimistic updates, conflict toast, Plan Mode ghosts

### Secondary: Visual Quality Sweep (25% of time)
Categories A, K — 26 scenarios

- Verify text truncation on every event type (job, walkthrough, ghost, urgent, conflict)
- Check tooltip content completeness for truncated text
- Validate color coding is distinguishable at a glance
- Measure font sizes, contrast ratios, badge readability
- Test with realistic data: long customer names, long addresses, many events

### Tertiary: Fix Verification (15% of time)
- Re-test every P0 and P1 fix the developer pushes
- Verify the fix doesn't regress adjacent behavior
- Update finding reports with verification status
- Final re-run of all DnD paths after all fixes are in

---

## Daily Schedule

| Time | Activity |
|------|----------|
| 9:00 | Standup (15 min): report yesterday's findings, blockers |
| 9:15 | Verify fixes pushed yesterday (30-45 min) |
| 10:00 | Testing session 1: Execute 5-8 scenarios from the day's batch |
| 12:00 | Write findings, record/attach videos, tag developer |
| 13:00 | Testing session 2: Execute 5-8 more scenarios |
| 15:00 | Exploratory testing: repeat critical paths, try edge cases not in the plan |
| 16:00 | Update daily run summary, prep tomorrow's batch |

### Week 1 Scenario Assignments (DnD Focus)

| Day | Categories | Scenario IDs | Count |
|-----|-----------|-------------|-------|
| 1 | N-A (P0 urgent) | N-01 through N-04 | 4 |
| 1 | D — DnD Core | D-01 through D-06 | 6 |
| 2 | D — DnD Core | D-07 through D-12 | 6 |
| 2 | F — Drop Targets | F-01 through F-04 | 4 |
| 3 | F — Drop Targets | F-05 through F-12 | 8 |
| 4 | F — Drop Targets | F-13 through F-16 | 4 |
| 4 | H — Edge Cases | H-01 through H-08 | 8 |
| 5 | H — Edge Cases | H-09 through H-18 | 10 |

### Week 2 Scenario Assignments (Visual + Feel)

| Day | Categories | Scenario IDs | Count |
|-----|-----------|-------------|-------|
| 6 | E — DnD Visual | E-01 through E-07 | 7 |
| 7 | E — DnD Visual | E-08 through E-14 | 7 |
| 7 | G — Resize | G-01 through G-05 | 5 |
| 8 | G — Resize | G-06 through G-10 | 5 |
| 8 | I — Performance | I-01 through I-08 | 8 |
| 9 | A — Text Overflow | A-01 through A-14 | 14 |
| 9 | K — Visual Hierarchy | K-01 through K-06 | 6 |
| 10 | K — Visual Hierarchy | K-07 through K-12 | 6 |
| 10 | Full regression re-test | All P0/P1 fixed items | varies |

---

## Tools

| Tool | Purpose | Required |
|------|---------|----------|
| Chrome (latest) | Primary test browser | Yes |
| Chrome DevTools — Elements | Inspect CSS: overflow, truncation, padding, font-size | Yes |
| Chrome DevTools — Network | Verify API calls fire (or don't) during DnD | Yes |
| Chrome DevTools — Performance | Measure FPS during drag (Category I) | Yes |
| Screen recorder (OBS / LICEcap / ShareX) | Capture DnD videos. **Every DnD finding MUST have video.** | Yes |
| Google Calendar (personal account) | Side-by-side benchmark comparison | Yes |
| Ruler/pixel measurement tool (PerfectPixel, Pixel Winch, or DevTools) | Measure padding, gaps, heights | Nice-to-have |
| Color contrast checker (WebAIM / Colour Contrast Analyser) | WCAG AA validation for Category K | Nice-to-have |

### Browser Setup
- Default zoom: 100%
- Clear cache before each test session (avoid stale CSS)
- Disable browser extensions that might interfere with DnD (ad blockers, gesture tools)
- Keep DevTools open but docked to the right (not bottom) to preserve vertical calendar space

---

## How to File a Finding

Use the template at `md_files/plans/scheduler/reports/TEMPLATE_finding.md`.

### Naming Convention
`[Category]-[Number]_[short-slug].md`
Example: `D-06_drag-from-center-no-response.md`

### Severity Guidelines

| Severity | Criteria | Examples |
|----------|----------|---------|
| **P0 — Broken** | Feature doesn't work at all, data integrity risk, crash | Completed event can be rescheduled; drop causes console error; event disappears |
| **P1 — Feels Wrong** | Feature works but the experience is noticeably bad to a dispatcher | Ghost doesn't follow cursor; no snap to grid; no visual feedback during drag; truncated text with no tooltip |
| **P2 — Polish** | Works fine but doesn't match the Google Calendar benchmark | Slight animation jank; resize handle too small; off-hours dimming not obvious |

### Video Recording Rules
- **Resolution:** Match the test viewport (1920x1080, 1440x900, or 1366x768)
- **Frame rate:** 30fps minimum (60fps preferred for DnD smoothness issues)
- **Duration:** Start 2 seconds before the action, end 2 seconds after the result
- **File format:** MP4 or GIF (GIF for < 5 seconds, MP4 for longer)
- **Naming:** Same as the finding file but with `.mp4`/`.gif` extension
- **Narration:** Not required, but annotate with arrows/circles if using a tool that supports it

### What Makes a Good Finding Report
- Steps are exact enough that the developer can reproduce in 30 seconds
- "Expected" references Google Calendar explicitly: "In Google Calendar, the ghost snaps to 30-minute increments. In our scheduler, it free-floats."
- Video is attached, not linked to an external service
- Impact statement mentions the user role: "Dispatchers doing 20+ assignments per day will hit this on every drag"

---

## Behavior Expectations

### DO
- Test every scenario at all three viewports, not just the default
- Record video for every DnD finding, even if you think a screenshot would suffice
- Open Google Calendar in a second monitor and compare the DnD feel in real-time
- Report findings the same day you discover them — don't batch until end of week
- Re-test a fixed item in all views (Week, Day, Month, Grid Day, Grid Week), not just the view where you found the bug
- Mark a finding as "Verified Fixed" or "Regression Found" when re-testing
- Ask the developer "is this intentional?" before filing — but still file it if unsure

### DON'T
- Don't skip a scenario because "it probably works" — execute every one
- Don't downgrade severity because fixing it seems hard — severity reflects user impact, not dev effort
- Don't re-test your own findings on the same day as the fix — fresh eyes next morning catches more
- Don't edit the Playwright spec files — tell the automation engineer what to add
- Don't use the app with developer shortcuts (direct URL navigation, console commands) — always navigate like a dispatcher would
- Don't test on a database with 0 events — the seed helper creates data, but also test with 50+ events for realistic load

---

## Escalation Path

1. **Normal finding:** File report → tag dev in Slack → dev fixes → you re-verify
2. **Blocker (P0):** File report → ping dev immediately → stop testing that category until fixed → test other categories
3. **Disagreement on severity:** You and dev disagree → Product Lead makes the call within 4 hours
4. **"Is this intentional?":** Ask dev in Slack. If they say "yes, it's by design" → file anyway as P2 with note "Confirmed intentional — evaluate for UX improvement"
5. **Environment issue (server down, data missing):** Ping automation engineer → they fix the seed/server → you resume
