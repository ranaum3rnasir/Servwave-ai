# Scheduler UI/UX Audit — [YYYY-MM-DD]

**Tester:** [Name]
**Viewports tested:** 1920x1080, 1440x900, 1366x768
**Views tested:** Standard Week/Day/Month, By-Tech Grid/Week
**Test data:** [N] jobs, [N] walkthroughs, [N] technicians

## Results

| Category | Total Tests | Pass | Fail | Skip | P0 | P1 | P2 |
|----------|------------|------|------|------|----|----|-----|
| A — Text Overflow | 14 | | | | | | |
| B — Scroll | 12 | | | | | | |
| C — Sidebar | 15 | | | | | | |
| D — DnD Core | 12 | | | | | | |
| E — DnD Visual | 14 | | | | | | |
| F — DnD Targets | 16 | | | | | | |
| G — Resize | 10 | | | | | | |
| H — DnD Edge Cases | 18 | | | | | | |
| I — DnD Performance | 8 | | | | | | |
| J — Responsive | 10 | | | | | | |
| K — Visual Hierarchy | 12 | | | | | | |
| L — Interactions | 14 | | | | | | |
| M — State Edge Cases | 12 | | | | | | |
| **TOTAL** | **167** | | | | | | |

## Top Blockers (P0)
1. [Finding ID] — [title]

## Top Usability Issues (P1)
1. [Finding ID] — [title]

## Top Polish Items (P2)
1. [Finding ID] — [title]

## Automated Test Results
```
npx playwright test --config=e2e/playwright.config.ts --grep="Category"
```
- Pass: [N]
- Fail: [N]
- Skip: [N]

## Console Log Findings
[Paste relevant console.log output from Playwright runs — these contain the measurements and observations from automated tests]

## Notes
[Anything unusual about this run, data setup issues, flaky behaviors]
