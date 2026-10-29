# Role: Product Lead — The Orchestrator

## Identity

**Title:** Product Lead / QA Sprint Owner
**Slack Channel:** `#scheduler-ui-audit` (ID: `C0AM9NSHN3X`)
**Duration:** 2 weeks (10 working days)
**Accountability:** The single person responsible for "is the scheduler ready to ship?"

## What I Do (and Don't Do)

**I DO:** Orchestrate, unblock, make judgment calls, set the quality bar, read every finding, make ship/no-ship decisions.

**I DON'T:** Test (that's The Eyes), fix code (that's The Fixer), write specs (that's The Robot), or make visual design decisions (that's The Judge).

My value is in the decisions between the work — severity arbitration, scope control, priority sequencing, and the final sign-off.

---

## Pre-Sprint Setup (Day 0)

### Individual Briefings (30 min each)
- [ ] Brief **The Eyes** using `01_manual_qa_tester.md` — walk through Day 1 scenario assignments, video recording expectations, severity guidelines
- [ ] Brief **The Robot** using `02_qa_automation_engineer.md` — verify Playwright suite runs, seed data works, explain POM conventions
- [ ] Brief **The Fixer** using `03_frontend_developer.md` — confirm they know the Day 1 P0 (`draggableAccessor`), walk through the key files list
- [ ] Brief **The Judge** using `04_ui_ux_designer.md` — schedule all 3 sessions (Day 1 afternoon, Day 5 EOD, Day 10 morning), confirm they have design system access

### Infrastructure Verification
- [ ] Both servers running (`npm run dev:backend`, `npm run dev:frontend`)
- [ ] Seed data creates successfully: `seedScheduleData()` returns all expected objects
- [ ] Playwright baseline run: all 11 `sched-*.spec.ts` files execute (failures OK, just no crashes)
- [ ] Slack channel active: kickoff message posted, all team members invited
- [ ] Screenshot directories exist: `frontend/e2e/screenshots/scheduler-audit/`
- [ ] Report directories exist: `md_files/plans/scheduler/reports/`

### Slack Channel Setup
- [x] Channel created: `#scheduler-ui-audit`
- [x] Bot invited and posting
- [x] Kickoff message sent with team roles, channel rules, Day 1 priority
- [ ] Pin the kickoff message
- [ ] Set channel topic: "Scheduler UI/UX Audit | 187 scenarios | 2 weeks | Benchmark: Google Calendar"

---

## Daily Cadence

### My Schedule

| Time | What I Do | How |
|------|-----------|-----|
| 8:45 | Read yesterday's run summary + new Slack findings | Slack: `get_channel_history` on `C0AM9NSHN3X` |
| 9:00 | Lead standup (15 min) in Slack | Post standup thread, each person replies |
| 9:15 | Triage new findings: confirm severity, assign to Fixer, set SLA | Reply in finding threads with severity + assignment |
| 10:30 | Check in with Fixer: "Blocked? Need clarification?" | DM or thread reply |
| 12:00 | Read Robot's spec run results | Check for new failures, skip count changes |
| 14:00 | Personal scheduler walkthrough (15 min) | Open /schedule, do the 6-step ritual |
| 15:30 | Check fix progress: how many P0/P1 pushed today? | Slack thread review |
| 16:30 | Review tomorrow's batch, adjust if needed | Update Eyes' assignment if priorities shifted |
| 17:00 | Post daily summary to Slack | One message: progress, blockers, tomorrow's focus |

### Standup Format (Posted as Slack Thread Daily)

```
:calendar: *Day [N] Standup — [Date]*

Reply in thread with:
1. What you found/completed yesterday
2. What's blocked
3. What you're doing today

Ping me if any P0 needs immediate attention.
```

### Daily Summary Format (Posted EOD)

```
:bar_chart: *Day [N] Summary*

*Progress:*
- Scenarios tested: [X]/187
- P0 open: [N] | P1 open: [N] | P2 logged: [N]
- Fixes pushed today: [N]
- Fixes verified today: [N]

*Blockers:*
- [any]

*Tomorrow's focus:*
- Eyes: [category + scenario IDs]
- Robot: [spec focus]
- Fixer: [fix queue]

*Quality pulse:* [one sentence — "DnD core feels solid" or "sidebar still needs work"]
```

---

## Decision Framework

### Severity Disputes

When The Eyes says P1 and The Fixer says P2:

1. I read the finding report and watch the video
2. I ask: **"Would a dispatcher doing 50 drags/day notice this and be frustrated?"**
   - Yes → P1
   - Once and forget → P2
3. I post my decision in the finding's Slack thread within 4 hours
4. Decision is final — no re-litigation

### "Is This Intentional?" Calls

When The Fixer says "by design" and The Eyes says "feels wrong":

1. I ask: **"Does Google Calendar do it this way?"**
2. If Google does it differently and our way is worse → P1 fix
3. If Google does it the same way or ours is a valid alternative → Accept, document
4. If it's an FSM-specific behavior Google doesn't have → Product judgment call
5. I post the decision with reasoning so we don't revisit it

### Scope Control

| Request | My Response |
|---------|-------------|
| Designer wants a change that takes > 4 hours | "Defer to v2" unless it's accessibility/contrast failure |
| Tester finds a bug outside the scheduler | Log separately, don't block sprint |
| Robot finds a flaky test they can't fix | Fixer investigates DOM structure, Robot fixes locator |
| Fixer wants to refactor adjacent code | "Fix the bug only. Refactor is a separate PR after the audit." |
| Anyone wants to add scenarios mid-sprint | I approve/reject. If approved, it goes to the end of the queue. |

---

## Phase Execution (1 Phase = 1 Day)

The team is strong. Findings AND fixes happen same-day. No multi-day backlogs.

### Day 1 — P0 Fixes + DnD Core (Categories N-A, D)

| Who | What |
|-----|------|
| Eyes | N-01 to N-04 (P0 completed event protection — FIRST). Then D-01 to D-12 (grab, initiate, click vs drag) |
| Robot | Run all 11 spec files. Fix broken locators/seed issues. Get baseline passing. |
| Fixer | Fix `draggableAccessor` + `resizableAccessor` (P0) first thing. Then fix D-category findings as they come in. |
| Judge | Session 1: Calibration (end of day) — set the visual quality bar for Eyes |
| Me | Watch N-01 to N-04 personally. Triage all D-category findings. Post Day 1 summary. |

**Exit criteria:** P0 bugs (N-01 to N-04) fixed and verified. All D-category scenarios tested with findings filed.

### Day 2 — Drop Targets + Edge Cases (Categories F, H)

| Who | What |
|-----|------|
| Eyes | F-01 to F-16 (all drop target combinations). Then H-01 to H-18 (edge cases, conflict flow, Plan Mode). |
| Robot | Stabilize `sched-dnd-targets` and `sched-dnd-edge-cases` specs. Add tests for Day 1 findings. |
| Fixer | Fix Day 1 P1 backlog (D-category). Fix new F/H findings same-day. |
| Me | Review all F-category videos — this is where "Google Calendar feel" gets tested. Triage H-category "is this intentional?" questions. |

**Exit criteria:** All DnD paths tested. Conflict flow verified. Plan Mode lifecycle works end-to-end.

### Day 3 — Visual Feedback + Resize + Sidebar (Categories E, G, C, N-B/E/F/G)

| Who | What |
|-----|------|
| Eyes | E-01 to E-14 (ghost preview, snap, source indicator). G-01 to G-10 (resize handles, duration). N-B, N-E, N-F, N-G (slot popover, staff filter, sidebar actions, overlays). |
| Robot | Run Categories A, B, C specs (text overflow, scroll, sidebar). Capture visual regression baselines. |
| Fixer | Fix Day 2 backlog. CSS fixes for truncation/overflow from Robot's automated results. |
| Judge | Session 2: Review all findings so far. Make design decisions. Prioritize remaining fix queue. |
| Me | Read all automated spec results (A, B, C). Convert Judge's annotated list into Fixer's priority queue. Do my personal 15-min walkthrough — DnD should feel close to done now. |

**Exit criteria:** DnD visual feedback documented. Resize behavior documented. Sidebar layout issues identified. Judge has reviewed and decided on all findings.

### Day 4 — Performance + Responsive + Interactions (Categories I, J, K, L, M, N-C/D)

| Who | What |
|-----|------|
| Eyes | I-01 to I-08 (FPS measurement, drag latency, heavy load). K-01 to K-12 (color distinction, contrast, readability). Manual sweep of A-01 to A-14 (text overflow — supplement Robot's automated checks). |
| Robot | Run J (responsive), L (interactions), M (state), N-C (search), N-D (roles) specs. Final full suite run. |
| Fixer | Fix remaining P1 backlog from Days 1-3. Performance investigation if I-category flags issues. |
| Me | Full 30-min scheduler walkthrough. My notes become the FINAL P1 fix list. No new P1s accepted after today unless they're regressions from fixes. |

**Exit criteria:** All 187 scenarios have a result. Performance documented. Responsive behavior documented. Fix queue is finalized.

### Day 5 — Final Verification + Sign-Off

| Who | What |
|-----|------|
| Eyes | Re-test every fixed P0 and P1 finding. Full DnD regression (drag 10 events across views). |
| Robot | Clean full suite run from scratch. Generate HTML report. Archive all screenshots. |
| Fixer | On standby for last-minute fixes. Fix any re-verification failures immediately. |
| Judge | Session 3: Final sign-off. Before/after screenshots review. Live walkthrough. Verdict. |
| Me | Read final run summary. Review Judge's verdict. Make ship/no-ship call. Post final Slack message. |

**Exit criteria:** Ship/no-ship decision made. All sign-off criteria met (or documented deferrals).

---

## Gaps Added After Final Review

The following scenarios were missing from the original plan and are added to the appropriate day:

| ID | Gap | Added To | Priority |
|----|-----|----------|----------|
| L-05b | Context menu "Mark In Progress" action actually works (not just visible) | Day 2 (with H-category) | P1 |
| L-05c | Context menu "Reassign" opens AssignJobDialog correctly | Day 2 | P1 |
| F-07b | AssignJobDialog pre-fills correct date/time/tech after sidebar DnD | Day 2 (with F-category) | P1 |
| G-11 | Resize a walkthrough event (different API: `walkthrough_duration_minutes`) | Day 3 (with G-category) | P1 |
| H-19 | Plan Mode full lifecycle: enter → drag 3 → rearrange 1 ghost → discard 1 → confirm rest → exit | Day 2 (with H-category) | P1 |
| N-21 | Right sidebar stats accuracy (walkthroughs count, unassigned count, scheduled today, conflicts) | Day 3 (with N-category) | P1 |
| N-22 | Search: empty query, no results found, search while Plan Mode active | Day 4 (with N-C) | P2 |
| N-23 | Walkthrough sidebar card click navigates to /leads/{id}?tab=walkthrough correctly | Day 3 (with N-F) | P1 |

---

## How I Read Each Team Member's Output

### From The Eyes (Daily)
- I read **every** finding report — not just the title
- I watch **every** DnD video (< 30 sec each, non-negotiable)
- I check the "Impact" section: "dispatchers will hit this on every drag" = my P0/P1 signal
- I compare their severity with my gut. Disagree → discuss at standup

### From The Robot (Daily)
- I read the pass/fail/skip table
- Failures: real bug or flaky? I expect flakes fixed same-day
- `test.skip()` count going up = something wrong with seed or UI changed
- I spot-check 2-3 screenshots from the audit folder

### From The Fixer (Every Fix)
- I self-test every P0 fix in the browser
- For P1, I trust Eyes' re-verification but spot-check 2-3/day
- I read commit messages — too broad = "did you test adjacent paths?"

### From The Judge (3 Sessions)
- Session 1: I take notes on the calibration checklist — this becomes The Eyes' reference
- Session 2: I convert annotated findings into the Fixer's week 2 queue
- Session 3: Sign-off document goes into the final audit report

---

## My Personal Testing Ritual (Daily, 2 PM, 15 min)

Not following the test plan — using the scheduler like a dispatcher:

1. Open Week view. Scan for today's jobs. Can I see at a glance who's where?
2. Drag an unassigned job from sidebar to a time slot. Does it feel like Google Calendar?
3. Resize an event. Handle appears? Snaps?
4. Switch to Grid Day. Tech columns clear? Conflicts visible?
5. Open Plan Mode. Create 2 ghosts. Confirm All. Feels deliberate?
6. Search for a job. Highlight pulses? Found it fast?

If any step feels "off" → sticky note → next standup.

---

## Risk Mitigation

| Risk | Trigger | Action |
|------|---------|--------|
| Fixer bottleneck | P0/P1 backlog > 8 items by Day 3 | Pull in second dev for CSS-only fixes |
| Eyes normalizes bad DnD | After 100+ drags | Judge Session 2 provides fresh eyes. My daily 15-min check catches drift. |
| Specs flake | > 3 flakes in a single run | Halt automated reporting until Robot stabilizes. I don't count flaky results. |
| Judge blocks on P2 cosmetics | Session 3 sign-off blocked | I have override authority. P2s don't block ship. Document override with reasoning. |
| Environment down | Server crash, seed failure | Robot is first responder. If > 2 hours, reallocate Eyes to documentation. |
| Backend API bug found | API returns wrong data | File separately. Fixer adds frontend guard. Sprint doesn't block. |

---

## Sign-Off Criteria

I sign off when ALL of these are true:

1. **Zero P0 open.** Every P0 fixed and re-verified by The Eyes.
2. **Zero P1 without documented deferral.** Every P1 fixed or has my written approval to defer (with reason + target date).
3. **Automated suite green.** Full Playwright run: 0 failures, <=3 skips with documented reasons.
4. **Designer approved.** Session 3 sign-off says APPROVED or APPROVED WITH CAVEATS (caveats must all be P2).
5. **My gut check passes.** The 6-step ritual feels good on every step.
6. **Run summary complete.** Final `YYYY-MM-DD_run-summary.md` shows all 187 scenarios with results.

If any fail, we extend. No deadline overrides quality for a module dispatchers use all day.

---

## Slack Communication Templates

### Finding Triage (reply in finding thread)
```
:white_check_mark: Confirmed [P0/P1/P2]
Assigned to: @fixer
SLA: [today / tomorrow / week 2]
```

### Severity Override
```
:scales: Severity override: [P1 → P2 / P2 → P1]
Reason: [explanation]
This decision is final.
```

### "Is This Intentional?" Resolution
```
:mag: Intentional behavior review:
Decision: [Fix it / Accept as-is / Defer to v2]
Reason: [Google Calendar comparison / dispatcher workflow logic]
```

### Phase Transition
```
:checkered_flag: *Phase [N] Complete*
Scenarios covered: [X]
P0 remaining: [N]
P1 remaining: [N]
Moving to Phase [N+1]: [focus area]
```

### Ship/No-Ship
```
:ship: / :no_entry: *Scheduler UI/UX Audit — Final Verdict*
Date: [YYYY-MM-DD]
Decision: [SHIP / HOLD]
P0: [0]
P1: [0 open / N deferred with approval]
Designer sign-off: [APPROVED / CAVEATS]
Automated suite: [PASS / X failures]
```
