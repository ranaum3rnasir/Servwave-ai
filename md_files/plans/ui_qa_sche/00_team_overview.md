# Scheduler UI/UX QA Team — Overview

**Project:** ALPHA CRM Scheduler Module UI/UX Audit
**Duration:** 2 weeks (10 working days)
**Total Scenarios:** 187 across 14 categories
**Benchmark:** Google Calendar drag-and-drop behavior
**Test Plan:** `md_files/plans/scheduler/scheduler-ui-ux-test-plan.md`

---

## Team Roster

| Role | Codename | Seniority | Allocation | Primary Categories |
|------|----------|-----------|------------|-------------------|
| Manual QA Tester | **The Eyes** | Mid-Senior (3-5 yrs) | Full-time, 2 weeks | D, E, F, G, I (DnD + performance) |
| QA Automation Engineer | **The Robot** | Mid (2-4 yrs) | Full-time wk1, part-time wk2 | A, B, C, J, L, M, N (automated suites) |
| Frontend Developer | **The Fixer** | Senior (4-7 yrs) | Part-time, on-call both weeks | P0/P1 fixes, "is this intentional?" calls |
| UI/UX Designer | **The Judge** | Mid-Senior (3-6 yrs) | 3 sessions (~4-5 hrs total) | K (visual hierarchy), quality bar, final sign-off |

## Team Files

- `01_manual_qa_tester.md` — The Eyes
- `02_qa_automation_engineer.md` — The Robot
- `03_frontend_developer.md` — The Fixer
- `04_ui_ux_designer.md` — The Judge

## Communication

- **Channel:** Dedicated Slack channel `#scheduler-ui-audit`
- **Daily standup:** 9:00 AM, 15 min max — blockers only
- **Finding handoff:** Manual tester writes finding → tags dev in Slack → dev acknowledges within 2 hours
- **Fix verification:** Dev pushes fix → notifies tester → tester re-verifies next morning
- **Designer sessions:** Scheduled on Day 1, Day 5 (end of week 1), Day 10 (final sign-off)

## Shared Resources

| Resource | Location | Owner |
|----------|----------|-------|
| Test plan | `md_files/plans/scheduler/scheduler-ui-ux-test-plan.md` | Product Lead |
| Finding reports | `md_files/plans/scheduler/reports/YYYY-MM-DD_findings/` | Manual Tester |
| Run summaries | `md_files/plans/scheduler/reports/YYYY-MM-DD_run-summary.md` | Both QA roles |
| Screenshots | `frontend/e2e/screenshots/scheduler-audit/` | Both QA roles |
| Playwright specs | `frontend/e2e/specs/sched-*.spec.ts` | Automation Engineer |
| Page Object Model | `frontend/e2e/pages/schedule.page.ts` | Automation Engineer |
| Seed data helper | `frontend/e2e/helpers/schedule-seed.ts` | Automation Engineer |
| Finding template | `md_files/plans/scheduler/reports/TEMPLATE_finding.md` | — |
| Run summary template | `md_files/plans/scheduler/reports/TEMPLATE_run-summary.md` | — |

## Definition of Done

The audit is complete when:
1. All 187 scenarios have a recorded result (pass / fail / skip with reason)
2. All P0 findings are fixed and re-verified
3. All P1 findings are fixed or have an accepted deferral with documented reason
4. P2 findings are logged but not required for sign-off
5. Designer has given final approval on visual quality
6. Run summary shows 0 P0, 0 unresolved P1
7. Automated specs pass on a clean run (no flakes)
