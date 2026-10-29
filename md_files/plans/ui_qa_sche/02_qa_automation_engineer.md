# Role: QA Automation Engineer — "The Robot"

## Identity

**Title:** QA Automation Engineer
**Seniority:** Mid (2-4 years in test automation, at least 1 year with Playwright or Cypress)
**Reports to:** Product Lead
**Allocation:** Full-time week 1, part-time (~50%) week 2

## Profile

### Must-Have Qualifications
- Strong Playwright experience: page objects, fixtures, parallel execution, screenshot comparison
- Comfortable reading React/TypeScript source code to identify correct selectors and understand component structure
- Can write CSS selector and XPath queries fluently
- Understands async patterns: `waitForResponse`, `waitForLoadState`, `waitForTimeout` vs proper waits
- Experience with DnD test simulation (mouse.move, mouse.down/up sequences, drag offsets)
- Git proficiency: branches, PRs, resolving merge conflicts in spec files

### Nice-to-Have
- Experience with visual regression testing (Playwright `toHaveScreenshot`, Percy, Chromatic)
- Familiar with react-big-calendar DOM structure (`.rbc-event`, `.rbc-time-content`, `.rbc-addons-dnd-*`)
- Performance profiling via Playwright (CDP sessions, `Network.emulateNetworkConditions`)
- CI/CD pipeline experience (running Playwright in GitHub Actions or similar)

### Personality Traits
- **Systematic.** Doesn't "just make it pass" — understands why a test exists and what it's actually verifying
- **Low tolerance for flakiness.** Investigates and fixes flaky tests immediately rather than re-running
- **Good communicator.** Can explain to the manual tester what the automated suite does and doesn't cover
- **Pragmatic about automation boundaries.** Knows when a test should stay manual (visual feel, animation smoothness) and doesn't waste time automating the unautomatable

---

## Responsibilities

### Primary: Automated Test Suite (55% of time)
Categories A, B, C, J, L, M, N — 98 scenarios across 11 spec files

- Run the full suite daily, triage every failure
- Fix broken locators when the developer changes the UI
- Replace `test.skip()` calls with proper assertions as the seed data stabilizes
- Add new spec cases for findings the manual tester discovers repeatedly
- Maintain the Page Object Model (`schedule.page.ts`) — add new helpers as needed
- Maintain the seed data helper (`schedule-seed.ts`) — extend if tests need more varied data

### Secondary: Visual Regression Baselines (20% of time)
- Capture baseline screenshots for every view × viewport combination
- Set up `toHaveScreenshot()` comparisons for critical layouts
- Track visual diffs after developer fixes
- Archive baselines in `frontend/e2e/screenshots/scheduler-audit/`

### Tertiary: Environment & Data Management (15% of time)
- Ensure test servers (backend + frontend) are running and healthy before each session
- Monitor seed data: clean up stale test data that accumulates over multiple runs
- Configure Playwright reporter (HTML report) for easy finding handoff to the team
- Set up parallel execution if serial runs become too slow (careful with shared state)

### Quaternary: Support Manual Tester (10% of time)
- When the manual tester can't reproduce an issue, write a targeted Playwright script to reproduce it deterministically
- Provide the manual tester with API shortcuts (curl commands, seed scripts) for data setup
- Automate repetitive setup steps the manual tester does before each session

---

## Daily Schedule

| Time | Activity |
|------|----------|
| 9:00 | Standup (15 min) |
| 9:15 | Review overnight run results. Triage failures. |
| 10:00 | Fix broken/flaky tests (locator changes, timing issues) |
| 11:00 | Run targeted suite against developer's latest fixes |
| 12:00 | Add new automated cases from manual tester's findings |
| 13:00 | Visual regression: capture new baselines, review diffs |
| 14:00 | Extend POM / seed helper as needed |
| 15:00 | Full suite run, review results |
| 16:00 | Update run summary, commit spec changes |

### Week 1 Focus (Full-time)

| Day | Focus Area |
|-----|-----------|
| 1 | Run all 11 spec files. Identify failures from seed data issues. Fix locators. |
| 2 | Stabilize Categories A, B, C specs (text, scroll, sidebar). Ensure 0 false skips. |
| 3 | Stabilize Categories D, F, H specs (DnD). Fix mouse simulation timing. |
| 4 | Add visual regression baselines for Week/Day/Month/Grid views at 3 viewports. |
| 5 | Category N specs (feature edge cases). Full suite run. Week 1 run summary. |

### Week 2 Focus (Part-time, ~4 hrs/day)

| Day | Focus Area |
|-----|-----------|
| 6-7 | Automate new cases from manual tester's week 1 findings |
| 8-9 | Re-run full suite against all fixes. Track regression. Update baselines. |
| 10 | Final clean run. Generate HTML report. Archive all screenshots. |

---

## Tools

| Tool | Purpose | Required |
|------|---------|----------|
| Playwright (latest) | Test framework | Yes |
| Node.js 20+ | Runtime | Yes |
| VS Code + Playwright extension | Spec authoring, debugging, trace viewer | Yes |
| Chrome (match Playwright's bundled Chromium version) | Consistency between automated and manual | Yes |
| Git | Version control for specs | Yes |
| Playwright HTML Reporter | Human-readable test results | Yes |
| Playwright Trace Viewer | Debug failures by replaying actions + screenshots | Yes |

### Playwright Configuration Notes
- Config: `frontend/e2e/playwright.config.ts`
- Auth: `global-setup.ts` saves admin session to `.auth/admin.json`
- All scheduler specs use `storageState: authFile` (pre-authenticated)
- Seed helper: `frontend/e2e/helpers/schedule-seed.ts` — unique suffix per spec file to avoid collisions
- Screenshot output: `frontend/e2e/screenshots/scheduler-audit/`
- Spec naming: `sched-{category}.spec.ts`

### Run Commands
```bash
# From frontend/ directory

# Run all scheduler specs
npx playwright test --config=e2e/playwright.config.ts --grep="sched-"

# Run a single category
npx playwright test --config=e2e/playwright.config.ts sched-dnd-core

# Run with headed browser (useful for debugging DnD)
npx playwright test --config=e2e/playwright.config.ts sched-dnd-core --headed

# Run with trace recording (for failure analysis)
npx playwright test --config=e2e/playwright.config.ts --trace on

# Generate HTML report
npx playwright show-report
```

---

## Code Standards for Specs

### Page Object Model Rules
- Every new locator goes in `schedule.page.ts`, not inline in spec files
- Locators should be resilient: prefer `getByRole`, `getByText`, `data-testid` over CSS classes
- Helper methods that perform multi-step actions (drag, right-click, view switch) go in the POM
- The POM should not contain assertions — only element access and actions

### Spec File Rules
- One `test.describe.serial` per file (scheduler tests mutate shared state)
- `beforeAll`: call `seedScheduleData({ suffix: 'unique' })` — never rely on pre-existing data
- `afterAll`: always call `seed.cleanup()` — no orphaned test data
- Every test calls `sp.goToToday()` after `waitForCalendarReady()` — guarantees the right date
- `expect()` over `test.skip()` when seed data guarantees the precondition
- `test.skip()` only for legitimate "feature not supported in this view" cases, with a `console.log` explaining why
- Every test ends with `sp.takeAuditScreenshot()` — even passing tests (for visual archive)
- Console.log findings with `[TEST-ID]` prefix for easy grep in CI output

### Handling Flakiness
1. **Never add arbitrary `waitForTimeout`** without a comment explaining what you're waiting for
2. **Prefer `waitForResponse` or `waitFor` with conditions** over timeouts
3. **If a DnD test is flaky:** increase `steps` parameter in mouse.move (more granular movement = more reliable)
4. **If a locator is flaky:** read the actual React source to find a stable selector
5. **If the seed data is flaky:** the seed creates data sequentially — if the API is slow, increase timeouts in the seed helper, not in specs

---

## Behavior Expectations

### DO
- Run the full suite before committing any spec changes (don't commit broken tests)
- Investigate every failure — "it passed on retry" is not acceptable
- Keep the run summary accurate: if 3 tests flake, note them as flaky, don't mark them as passing
- Coordinate with the manual tester: if they find something you can automate, do it that day
- Archive screenshots with timestamps — don't overwrite baselines without reason
- Comment your specs: explain *why* a test exists, not just *what* it does

### DON'T
- Don't auto-retry failing tests in CI to hide flakiness
- Don't add `{ force: true }` to Playwright clicks/drags to bypass visibility checks — if the element isn't visible, that's a finding
- Don't modify `SchedulePage.tsx` or any production code — only test code
- Don't create test users with names that could appear in real customer data searches
- Don't leave the test database polluted — every `beforeAll` seed has a matching `afterAll` cleanup

---

## Escalation Path

1. **Flaky test:** Investigate root cause → fix locator/timing → if still flaky after 2 attempts, tag developer for DOM structure investigation
2. **Seed data failure:** API returns error during seed → check if backend server is running → check if schema changed → notify developer
3. **Spec can't simulate behavior:** Some interactions (native HTML5 drag API, browser-level scroll acceleration) can't be reliably automated → document as "manual only" in the spec file and tell the manual tester to cover it
4. **Developer changed UI structure:** Locators break → read the new React source → update POM → re-run
