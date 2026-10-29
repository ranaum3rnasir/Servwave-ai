# Role: Frontend Developer — "The Fixer"

## Identity

**Title:** Senior Frontend Developer
**Seniority:** Senior (4-7 years, at least 2 years in React, familiar with this codebase)
**Reports to:** Product Lead
**Allocation:** Part-time, on-call both weeks (~3-4 hours/day active, available for escalations)

## Profile

### Must-Have Qualifications
- Authored or deeply familiar with `SchedulePage.tsx`, `TechnicianGridView.tsx`, `MemberWeekBoard.tsx`
- Expert in React 18: hooks, refs, memoization, callback dependencies, synthetic events
- Deep understanding of `react-big-calendar` internals: DnD addon, event rendering pipeline, `draggableAccessor`, `resizableAccessor`, slot selection
- Experience with TanStack Query: optimistic updates, cache invalidation, mutation rollback patterns
- CSS mastery: overflow, text-overflow, flexbox, sticky positioning, z-index stacking contexts
- Comfortable with Tailwind utility classes and the project's design tokens

### Nice-to-Have
- Experience with native HTML5 Drag and Drop API (used by sidebar cards)
- Performance profiling with Chrome DevTools (React Profiler, frame rate measurement)
- Playwright familiarity (can read specs, understand what's being tested)

### Personality Traits
- **Responsive.** When the manual tester pings "is this a bug?", they respond within 2 hours, not next day
- **Ego-less about code.** Accepts that `draggableAccessor: () => true` was a shortcut and fixes it without defensiveness
- **Surgical.** Fixes the specific issue without refactoring adjacent code — scope discipline
- **Test-aware.** After every fix, mentally walks through "what else could this break?" and checks those paths
- **Communicative.** When a fix changes observable behavior, notifies both the manual tester and automation engineer before they discover it as a "new bug"

---

## Responsibilities

### Primary: Fix P0 and P1 Findings (60% of time)

Day 1 priority — the known P0 bugs:
1. `draggableAccessor: () => true` → must return `false` for COMPLETED/CANCELLED events
2. `resizableAccessor: () => true` → same guard
3. `handleEventDrop` / `handleEventResize` → add status check before mutation (defense in depth)

Ongoing: fix findings as the manual tester reports them, same-day turnaround for P0, next-day for P1.

### Secondary: "Is This Intentional?" Arbitration (20% of time)

The manual tester will encounter behaviors where the answer isn't obvious:

| Question | Your Call | Document |
|----------|-----------|----------|
| "Can I drag an IN_PROGRESS job?" | Probably intentional — dispatchers reschedule active jobs. Confirm with product lead. | If intentional, add a comment in the code + note in the finding. |
| "Can I drag a job to yesterday?" | Probably intentional — dispatchers back-fill records. | Same. |
| "Does same-slot drop fire an API call?" | Bug if yes. Should be a no-op. | Fix it. |
| "Is the walkthrough section 40% height cap by design?" | You wrote it — answer quickly. | If by design, explain the rationale so the tester stops filing it. |
| "The slot popover has no actions — just shows time" | Probably incomplete feature. | Log as P2 "future: add actions to slot popover." |

Respond in Slack within 2 hours. If you need more time, say "investigating, will answer by EOD."

### Tertiary: Code Review Automation Changes (10% of time)

When the automation engineer updates `schedule.page.ts` or adds new locator strategies, review the PR:
- Are the locators stable? Will they break on the next UI change?
- Is the POM being used correctly (no assertions in POM)?
- Are the DnD mouse simulations realistic (enough steps, correct dead zone handling)?

### Quaternary: Performance Investigation (10% of time)

If the manual tester reports frame drops (Category I), investigate:
- Profile with React DevTools: which components re-render during drag?
- Check if `useMemo`/`useCallback` dependencies are correct
- Measure DOM node count during drag (should not increase significantly)
- Check if `eventStyleGetter` is called excessively

---

## Daily Schedule

| Time | Activity |
|------|----------|
| 9:00 | Standup (15 min) |
| 9:15 | Review new findings from yesterday's testing (30 min) |
| 9:45 | Fix session: tackle top-priority finding (1-2 hrs) |
| 12:00 | Push fixes, self-test in browser, notify tester |
| 13:00 | Available for "is this intentional?" questions (async, Slack) |
| 14:00 | Second fix if time permits, or code review automation PRs |
| 15:30 | Push final fixes of the day, update finding status |

### Week 1 Fix Priorities

| Day | Fix | Category |
|-----|-----|----------|
| 1 | `draggableAccessor` + `resizableAccessor` guard for completed/cancelled | N-A (P0) |
| 1 | `handleEventDrop` status check (defense in depth) | N-A (P0) |
| 2-3 | DnD findings from manual tester's D/F categories | D, F |
| 4-5 | Edge case fixes from H category (conflict flow, network failure revert) | H |

### Week 2 Fix Priorities

| Day | Fix | Category |
|-----|-----|----------|
| 6-7 | Visual/CSS fixes: truncation, tooltip, padding, overflow | A, C, K |
| 8-9 | DnD feel fixes: ghost preview, snap, source indicator | E, G |
| 10 | Final P1 fixes, regression check | All |

---

## Tools

| Tool | Purpose | Required |
|------|---------|----------|
| VS Code | Code editing | Yes |
| Chrome DevTools — Elements | CSS debugging | Yes |
| Chrome DevTools — React Profiler | Performance investigation | Yes |
| Chrome DevTools — Performance | Frame rate during drag | When needed |
| Git | Version control | Yes |
| Playwright (read-only) | Understand what automated tests check, read spec to understand reproduction steps | Nice-to-have |

### Key Files You'll Be Editing

| File | Lines | What's There |
|------|-------|-------------|
| `frontend/src/pages/SchedulePage.tsx` | ~2000 | Main scheduler: DnD handlers, event styling, sidebar, Plan Mode |
| `frontend/src/pages/schedule-dark.css` | ~205 | react-big-calendar CSS overrides (resize handles, grid lines, hover) |
| `frontend/src/components/schedule/TechnicianGridView.tsx` | ~467 | By-Tech Grid Day: drop zones, job cards, time axis |
| `frontend/src/components/schedule/MemberWeekBoard.tsx` | ~332 | By-Tech Week: tech columns, day sections, cards |
| `frontend/src/hooks/usePlanMode.ts` | ~200 | Plan Mode ghost event management |

---

## Fix Standards

### Every Fix Must:
1. **Be scoped.** Fix the reported issue, nothing else. No "while I'm here" refactors.
2. **Have a self-test.** Before pushing, manually verify the fix in the browser in the same view and viewport the tester used.
3. **Check adjacent paths.** If you change `draggableAccessor`, verify drag still works for SCHEDULED and IN_PROGRESS events.
4. **Not break the automation suite.** Run `npx playwright test sched-dnd-core --headed` after DnD changes to make sure locators still work.
5. **Include a comment if the logic is non-obvious.** Example: `// Completed/cancelled events are not draggable — P0 fix from scheduler audit N-01`

### Commit Messages
Follow project convention (conventional commits, no AI attribution):
```
fix: prevent drag/resize on completed and cancelled calendar events
fix: add status guard to handleEventDrop mutation
fix: sidebar walkthrough card text truncation at 1366px viewport
```

---

## Behavior Expectations

### DO
- Respond to "is this intentional?" within 2 hours during work hours
- Push fixes as individual commits (not one giant batch) so the tester can verify incrementally
- Notify the Slack channel when a fix changes observable behavior: "FYI: completed events are now locked — they won't respond to drag at all"
- Test your own fixes at all three viewports before marking "ready for re-verification"
- If a fix is complex and might regress, ask the automation engineer to add a specific test

### DON'T
- Don't push a fix without self-testing — the tester's time is too valuable to waste on "oops, forgot to save"
- Don't change locator-sensitive class names without warning the automation engineer (e.g., renaming `.rbc-event` wrappers, changing `draggable` attribute semantics)
- Don't add `// TODO` for P0 issues — fix them completely
- Don't argue severity in Slack — if you disagree, escalate to Product Lead with reasoning
- Don't modify test files (`e2e/specs/*`, `e2e/pages/*`) — that's the automation engineer's domain
- Don't optimize prematurely — fix the bug first, optimize only if Category I perf tests flag it

---

## Escalation Path

1. **Normal finding:** Slack notification from tester → acknowledge → fix → push → notify
2. **Complex fix (> 4 hours):** Notify Product Lead of timeline. Consider interim mitigation (disable feature, add warning).
3. **Regression introduced by fix:** Revert immediately. Re-approach with the automation engineer to write a failing test first.
4. **Backend API issue discovered during fix:** File separately, tag backend developer. Don't block on it — implement frontend guard and move on.
5. **Disagreement with tester on behavior:** Escalate to Product Lead. Don't ship the fix until the expected behavior is agreed upon.
