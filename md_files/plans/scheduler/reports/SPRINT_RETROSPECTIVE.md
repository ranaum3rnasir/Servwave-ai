# Scheduler UI/UX Audit — Sprint Retrospective

**Duration:** 5 days (2026-03-18)
**Team:** AI agents (Eyes, Robot, Fixer, Lead) + Manual testing (Ran, Product Owner)

---

## What Went Well

### 1. Screenshot-Verify-Proceed Protocol
The breakthrough of the sprint. Agents capture Playwright screenshots, then visually analyze the PNG files. This caught issues that code analysis alone missed (popup persisting during drag, text truncation severity, conflict hatch pattern readability). Established on Day 1 after the initial code-only approach failed.

### 2. Manual Testing by Product Owner
Ran's hands-on testing caught the two most critical issues:
- Sidebar drag to calendar broken (Playwright false positive)
- All DnD snaps back in live browser (Playwright false positive)

Without human browser testing, we would have declared DnD "PASS" based on false automated results.

### 3. Root Cause Analysis
Day 4's deep code trace found the exact smoking gun: one wrong URL path (`/walkthrough` vs `/walkthrough/schedule`). The finding includes exact line numbers, code snippets, and 4 specific fixes. The dev team can fix this in under an hour.

### 4. Slack Communication
All findings, triage decisions, manual test requests, and root cause analysis posted to #scheduler-ui-audit with proper formatting. Creates a complete audit trail.

### 5. Structured Reporting
35+ individual finding reports with consistent format: steps, expected/actual, evidence, impact, suggested fix. Plus daily summaries and the final comprehensive report.

---

## What Went Wrong

### 1. Playwright Mouse Simulation ≠ Real Browser DnD
The #1 lesson. `page.mouse.down()/move()/up()` fires `mousedown`/`mousemove`/`mouseup` events — NOT HTML5 `dragstart`/`dragover`/`drop`. The sidebar cards use native `draggable` attribute + HTML5 DnD. Playwright bypassed this entirely and triggered a different code path. **5 tests showed false PASS results.**

**Fix for future:** Any test involving `draggable` attribute must be verified manually. Consider using `page.dispatchEvent` to simulate real HTML5 drag events, or mark these tests as "manual verification required."

### 2. Test Data Pollution
60+ inactive E2E test technicians accumulated in the DB. The seed cleanup deactivated users instead of deleting them. New seed runs failed on email uniqueness constraints. Jobs referencing inactive techs silently failed on reassignment.

**Fix for future:** Seed cleanup must fully delete test users, not just deactivate. Use unique email prefixes per run. Add a "nuke test data" script.

### 3. Initial Code-Only Analysis Approach
Day 1 started with agents reading code and declaring PASS/FAIL without visual evidence. This was wrong. Corrected mid-Day 1, but the first batch of findings had no screenshots.

### 4. Some Automated Tests Masked Real Issues
The F-01 test showed a conflict dialog appearing (PASS), but didn't verify the event STAYED at the new position after the dialog. Test passed, but the drag didn't actually persist. **Always verify persistence, not just immediate visual state.**

### 5. Scope: 41% Coverage
Only 80 of 195 scenarios were tested. 44 were blocked by DnD being broken, 8 by seed failures, and 50 were lower-priority deferrals. This is acceptable for a 5-day sprint — the critical path was covered and the root cause was found. But the remaining 59% needs testing after fixes.

---

## Key Metrics

| Metric | Value |
|--------|-------|
| Scenarios planned | 195 |
| Scenarios tested | 80 (41%) |
| Scenarios blocked | 52 (27%) |
| Scenarios deferred | 63 (32%) |
| Screenshots captured | 112+ |
| Finding reports | 35+ |
| P0 found | 6 |
| P0 fixed during audit | 5 |
| P0 root-caused (open) | 1 |
| P1 open | 16 |
| P2 open | 18 |
| Product requirements | 2 |
| Fixes applied during audit | 9 |
| Playwright specs created | 15 |
| Manual test verifications | 8+ |

---

## Process Improvements for Next Audit

1. **Always pair automated tests with manual browser verification** for any DnD or native drag feature
2. **Seed cleanup must DELETE, not deactivate** — prevent data pollution
3. **Start with screenshot protocol from Day 1** — don't waste time on code-only analysis
4. **Verify persistence on every drag test** — add "refresh and check position" step
5. **Create test data via a dedicated admin script**, not during spec beforeAll — avoid race conditions
6. **Save Ran's time** — batch manual testing requests, don't ask one at a time
7. **Test with REAL data** early — active technicians, real customers, production-like volume

---

## Verdict

**The scheduler is NOT ready for production.** The visual design is solid (PASS), but the core DnD workflow is broken (FAIL). After the dev team applies the fixes from the final report (especially P0-04: wrong endpoint), a Round 2 audit should be run focusing on the 44 DnD scenarios that were blocked.

Estimated time to fix all P0+P1: 2-3 days for a senior frontend developer.
Estimated time for Round 2 audit: 2 days.
